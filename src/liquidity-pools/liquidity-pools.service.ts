import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Asset,
  LiquidityPoolAsset,
  LiquidityPoolFeeV18,
  Memo,
  Operation,
  TransactionBuilder,
  getLiquidityPoolId,
} from '@stellar/stellar-sdk';
import QRCode from 'qrcode';
import { AppConfig, StellarNetwork } from '../config/configuration';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCanAfford,
  assertTrustline,
  type HorizonBalance,
} from '../stellar/stellar-preflight';
import { StellarService } from '../stellar/stellar.service';
import type {
  LiquidityPoolOperation,
  SwapStatus,
  WebhookEventType,
} from '../../generated/prisma/client';
import { WebhookTerminalEmitter } from '../webhooks/webhook-terminal-emitter.service';
import { applySlippage, fromStroops, toStroops } from '../swaps/swap-math';
import {
  aggregateCostBasis,
  computeWithdrawCommission,
  matchDeposit,
  priceBounds,
  proportionalShare,
} from './lp-math';
import {
  LP_CAN_FAIL_STATUSES,
  LP_CAN_SUCCEED_STATUSES,
  LP_IN_FLIGHT_STATUSES,
  type LpOperationStatus,
} from './lp-operation-transitions';
import { DepositLiquidityDto } from './dto/deposit-liquidity.dto';
import { QueryLiquidityOperationsDto } from './dto/query-liquidity-operations.dto';
import { QueryLiquidityPoolsDto } from './dto/query-pools.dto';
import { QueryLiquidityPositionsDto } from './dto/query-positions.dto';
import { WithdrawLiquidityDto } from './dto/withdraw-liquidity.dto';
import {
  LiquidityPoolEntity,
  LiquidityPoolListEntity,
  LiquidityPoolReserve,
  LiquidityPositionListEntity,
} from './entities/liquidity-pool.entity';

const MAX_UINT64 = 18446744073709551615n;

/**
 * On-chain MEMO_TEXT stamped on operations that collect the platform commission
 * when the caller did not supply their own MEMO_ID — so the commission is
 * identifiable on the ledger. English by design (it is the canonical label).
 * Kept ≤ 28 bytes (the MEMO_TEXT limit).
 */
export const LIQUIDITY_COMMISSION_MEMO = 'Cosmos Liquidity Commission';

/** A stored operation plus its derived QR — the shape API responses return. */
export type LiquidityOperationView = LiquidityPoolOperation & {
  qr: string;
  /** The commission MEMO_TEXT label when a commission was collected, else null. */
  commissionMemo: string | null;
};

/** Result of relaying a signed liquidity pool operation. */
export interface LiquiditySubmitOutcome {
  submitted: boolean;
  status: SwapStatus;
  txHash?: string;
  reason?: string;
  resultCodes?: string[];
  operation: LiquidityOperationView;
}

/** Resolved asset: its stored code/issuer and the SDK Asset for building txs. */
interface ResolvedAsset {
  code: string;
  issuer: string | null;
  asset: Asset;
}

/** Minimal shape we read off a Horizon liquidity pool record. */
interface PoolRecord {
  id: string;
  paging_token: string;
  fee_bp: number;
  total_trustlines: string;
  total_shares: string;
  reserves: { asset: string; amount: string }[];
}

/** Minimal shape of a Horizon account balance entry. */
type BalanceEntry = HorizonBalance;

/**
 * Stellar AMM liquidity pools. Like swaps, this is **non-custodial**: the
 * service prices a deposit/withdraw against the pool's on-chain reserves,
 * assembles the unsigned transaction (a pool-share `changeTrust` when needed +
 * `liquidityPoolDeposit`/`liquidityPoolWithdraw`), and relays the signed
 * envelope the customer hands back. Funds never pass through Cosmos Pay.
 */
@Injectable()
export class LiquidityPoolsService {
  private readonly logger = new Logger(LiquidityPoolsService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookTerminalEmitter,
    private readonly stellar: StellarService,
  ) {}

  // ── Pools (Horizon proxy) ───────────────────────────────────────────────────
  async listPools(
    consumer: GatewayConsumer,
    query: QueryLiquidityPoolsDto,
  ): Promise<LiquidityPoolListEntity> {
    const network = this.resolveNetwork(consumer);
    let builder = this.stellar
      .server(network)
      .liquidityPools()
      .limit(query.limit)
      .order('desc');
    const filters: Asset[] = [];
    if (query.assetACode !== undefined || query.assetAIssuer !== undefined) {
      filters.push(
        this.resolveAsset(query.assetACode, query.assetAIssuer).asset,
      );
    }
    if (query.assetBCode !== undefined || query.assetBIssuer !== undefined) {
      filters.push(
        this.resolveAsset(query.assetBCode, query.assetBIssuer).asset,
      );
    }
    if (filters.length) builder = builder.forAssets(...filters);
    if (query.account) builder = builder.forAccount(query.account);
    if (query.cursor) builder = builder.cursor(query.cursor);

    let records: PoolRecord[];
    try {
      records = (await builder.call()).records;
    } catch (err) {
      this.logger.error('liquidityPools list failed', err);
      throw new ServiceUnavailableException(
        'Could not reach the Stellar network to list liquidity pools',
      );
    }
    return {
      data: records.map((r) => this.toPoolEntity(network, r)),
      cursor:
        records.length === query.limit
          ? records[records.length - 1].paging_token
          : null,
    };
  }

  async getPool(
    consumer: GatewayConsumer,
    poolId: string,
  ): Promise<LiquidityPoolEntity> {
    this.assertPoolId(poolId);
    const network = this.resolveNetwork(consumer);
    const pool = await this.fetchPool(network, poolId);
    if (!pool) {
      throw new NotFoundException(
        `Liquidity pool ${poolId} not found on the ${network} network`,
      );
    }
    return this.toPoolEntity(network, pool);
  }

  // ── Positions ───────────────────────────────────────────────────────────────
  /** An account's pool share trustlines joined with each pool's reserves. */
  async positions(
    consumer: GatewayConsumer,
    query: QueryLiquidityPositionsDto,
  ): Promise<LiquidityPositionListEntity> {
    const network = this.resolveNetwork(consumer);
    const account = await this.loadAccount(network, query.account);
    const shares = (account.balances as BalanceEntry[]).filter(
      (b) => b.asset_type === 'liquidity_pool_shares' && b.liquidity_pool_id,
    );
    const data = await Promise.all(
      shares.map(async (entry) => {
        const pool = await this.fetchPool(network, entry.liquidity_pool_id!);
        if (!pool) return null;
        const held = toStroops(entry.balance ?? '0');
        const total = toStroops(pool.total_shares);
        const reserves = pool.reserves.map((r) => this.parseReserve(r));
        return {
          poolId: pool.id,
          shares: fromStroops(held),
          totalShares: pool.total_shares,
          shareOfPoolBps: total > 0n ? Number((held * 10_000n) / total) : 0,
          reserves,
          redeemable: reserves.map((r) => ({
            ...r,
            amount:
              total > 0n
                ? fromStroops(
                    proportionalShare(held, total, toStroops(r.amount)),
                  )
                : '0',
          })),
        };
      }),
    );
    return {
      account: query.account,
      network,
      data: data.filter((p) => p !== null),
    };
  }

  // ── Deposit ─────────────────────────────────────────────────────────────────
  /**
   * Builds the unsigned deposit transaction and persists it. The pair is
   * canonically ordered (assetA < assetB), amounts follow their assets, and the
   * price bounds come from the pool's current reserves (or, for a new/empty
   * pool, from the deposit's own ratio) bracketed by the slippage tolerance.
   */
  async deposit(
    consumer: GatewayConsumer,
    dto: DepositLiquidityDto,
  ): Promise<LiquidityOperationView> {
    const network = this.resolveNetwork(consumer);
    const local = await this.resolveConsumer(consumer);
    const slippageBps = this.resolveSlippage(dto.slippageBps);
    const memo = this.resolveMemo(dto.memo);

    // Canonical order: the protocol requires assetA < assetB. Reorder the pair
    // (and its amounts) if the caller passed them the other way around.
    let a = this.resolveAsset(dto.assetACode, dto.assetAIssuer);
    let b = this.resolveAsset(dto.assetBCode, dto.assetBIssuer);
    let rawAmountA: string | undefined = dto.maxAmountA;
    let rawAmountB: string | undefined = dto.maxAmountB;
    const cmp = Asset.compare(a.asset, b.asset);
    if (cmp === 0) {
      throw new BadRequestException('A pool needs two different assets');
    }
    if (cmp > 0) {
      [a, b] = [b, a];
      [rawAmountA, rawAmountB] = [rawAmountB, rawAmountA];
    }

    const poolShare = new LiquidityPoolAsset(
      a.asset,
      b.asset,
      LiquidityPoolFeeV18,
    );
    const poolId = getLiquidityPoolId(
      'constant_product',
      poolShare.getLiquidityPoolParameters(),
    ).toString('hex');

    const pool = await this.fetchPool(network, poolId);
    const reserveA = pool ? toStroops(this.reserveOf(pool, a)) : 0n;
    const reserveB = pool ? toStroops(this.reserveOf(pool, b)) : 0n;
    const funded = reserveA > 0n && reserveB > 0n;

    // Fill in the side the caller left out from the pool's current ratio.
    let amountA = rawAmountA !== undefined ? toStroops(rawAmountA) : 0n;
    let amountB = rawAmountB !== undefined ? toStroops(rawAmountB) : 0n;
    if (funded) {
      if (rawAmountA === undefined && rawAmountB !== undefined) {
        amountA = matchDeposit(amountB, reserveB, reserveA);
      } else if (rawAmountB === undefined && rawAmountA !== undefined) {
        amountB = matchDeposit(amountA, reserveA, reserveB);
      }
    } else if (rawAmountA === undefined || rawAmountB === undefined) {
      throw new BadRequestException(
        'This pool has no reserves yet — provide both amounts; the deposit sets the initial price',
      );
    }
    if (amountA <= 0n || amountB <= 0n) {
      throw new BadRequestException(
        'Deposit amounts must be greater than zero',
      );
    }

    // Deposits carry NO commission — the plan fee is charged only on the *gain*
    // at withdraw time, never on the principal. The full amounts enter the pool.

    // Price bounds around the pool price (or the deposit's own ratio when the
    // pool is empty). The deposit fails on-chain if the price drifts outside.
    let bounds: { minPrice: string; maxPrice: string };
    try {
      bounds = funded
        ? priceBounds(reserveA, reserveB, slippageBps)
        : priceBounds(amountA, amountB, slippageBps);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const account = await this.loadAccount(network, dto.source);
    const balances = account.balances as BalanceEntry[];
    assertTrustline(
      balances,
      a,
      dto.source,
      'it must trust the asset before depositing it into a pool',
    );
    assertTrustline(
      balances,
      b,
      dto.source,
      'it must trust the asset before depositing it into a pool',
    );
    const hasPoolTrust = balances.some(
      (bal) =>
        bal.asset_type === 'liquidity_pool_shares' &&
        bal.liquidity_pool_id === poolId,
    );

    const stellarCfg = this.config.get('stellar', { infer: true });

    // Pre-flight: the account must hold the full amount of each asset and keep
    // its XLM minimum reserve (incl. the new pool-share trustline) plus the tx
    // fee. Fail here with a clear 400 rather than let the network reject the
    // signed tx with op_underfunded.
    const opCount = (hasPoolTrust ? 0 : 1) + 1;
    assertCanAfford(
      account,
      balances,
      [
        { asset: a, required: amountA },
        { asset: b, required: amountB },
      ],
      !hasPoolTrust,
      BigInt(stellarCfg.baseFee) * BigInt(opCount),
    );

    const builder = new TransactionBuilder(account, {
      fee: stellarCfg.baseFee,
      networkPassphrase: this.stellar.passphrase(network),
    });
    // Operation 1: trust the pool share asset (first deposit into this pool).
    if (!hasPoolTrust) {
      builder.addOperation(Operation.changeTrust({ asset: poolShare }));
    }
    // Operation 2: the deposit itself, capped by the amounts + price bounds.
    builder.addOperation(
      Operation.liquidityPoolDeposit({
        liquidityPoolId: poolId,
        maxAmountA: fromStroops(amountA),
        maxAmountB: fromStroops(amountB),
        minPrice: bounds.minPrice,
        maxPrice: bounds.maxPrice,
      }),
    );
    if (memo) builder.addMemo(Memo.id(memo));

    const tx = builder.setTimeout(stellarCfg.timeoutSeconds).build();
    const op = await this.persist(consumer, {
      consumerId: local.id,
      kind: 'DEPOSIT' as const,
      network,
      source: dto.source,
      poolId,
      assetA: a.code,
      assetAIssuer: a.issuer,
      assetB: b.code,
      assetBIssuer: b.issuer,
      amountA: fromStroops(amountA),
      amountB: fromStroops(amountB),
      shares: null,
      minPrice: bounds.minPrice,
      maxPrice: bounds.maxPrice,
      slippageBps,
      // Deposits carry no commission; the cost basis is captured at settlement.
      feeBps: 0,
      feeAmountA: '0',
      feeAmountB: '0',
      feeWallet: null,
      tx,
      timeoutSeconds: stellarCfg.timeoutSeconds,
    });
    this.logger.log(
      `Created LP deposit ${op.id}: ${fromStroops(amountA)} ${this.label(a)} + ` +
        `${fromStroops(amountB)} ${this.label(b)} → pool ${poolId.slice(0, 8)}… ` +
        `(consumer=${consumer.username}, network=${network})`,
    );
    return op;
  }

  // ── Withdraw ────────────────────────────────────────────────────────────────
  /**
   * Builds the unsigned withdrawal transaction: burn `shares` pool shares for
   * the proportional amounts of both reserves, with slippage-protected on-chain
   * minimums derived from the current reserves.
   */
  async withdraw(
    consumer: GatewayConsumer,
    dto: WithdrawLiquidityDto,
  ): Promise<LiquidityOperationView> {
    const network = this.resolveNetwork(consumer);
    const local = await this.resolveConsumer(consumer);
    const slippageBps = this.resolveSlippage(dto.slippageBps);
    const memo = this.resolveMemo(dto.memo);

    const pool = await this.fetchPool(network, dto.poolId);
    if (!pool) {
      throw new BadRequestException(
        `Liquidity pool ${dto.poolId} not found on the ${network} network`,
      );
    }
    const total = toStroops(pool.total_shares);
    const shares = toStroops(dto.shares);
    if (shares <= 0n) {
      throw new BadRequestException('shares must be greater than zero');
    }
    if (total <= 0n) {
      throw new BadRequestException('This pool has no outstanding shares');
    }

    const account = await this.loadAccount(network, dto.source);
    const held = (account.balances as BalanceEntry[]).find(
      (bal) =>
        bal.asset_type === 'liquidity_pool_shares' &&
        bal.liquidity_pool_id === dto.poolId,
    );
    if (!held) {
      throw new BadRequestException(
        `Account ${dto.source} holds no shares of pool ${dto.poolId}`,
      );
    }
    if (toStroops(held.balance ?? '0') < shares) {
      throw new BadRequestException(
        `Account ${dto.source} holds only ${held.balance} shares of this pool`,
      );
    }

    const [resA, resB] = pool.reserves.map((r) => this.parseReserve(r));
    const minA = applySlippage(
      proportionalShare(shares, total, toStroops(resA.amount)),
      slippageBps,
    );
    const minB = applySlippage(
      proportionalShare(shares, total, toStroops(resB.amount)),
      slippageBps,
    );

    // Plan commission — charged ONLY on the gain (redeemed − proportional cost
    // basis), and only for shares whose cost basis we recorded from deposits
    // made through Cosmos Pay. Shares with no known basis are taxed nothing.
    const feeBps = this.resolveSwapFeeBps(consumer);
    const feeWallet = this.feeWallet();
    let feeA = 0n;
    let feeB = 0n;
    if (feeBps > 0) {
      const basis = await this.costBasis(local.id, dto.source, dto.poolId);
      const fees = computeWithdrawCommission({
        shares,
        totalShares: total,
        remainingShares: basis.remainingShares,
        depositedShares: basis.depositedShares,
        costA: basis.costA,
        costB: basis.costB,
        reserveA: toStroops(resA.amount),
        reserveB: toStroops(resB.amount),
        slippageBps,
        feeBps,
      });
      feeA = fees.feeA;
      feeB = fees.feeB;
    }
    if (feeA + feeB > 0n && !feeWallet) {
      throw new ServiceUnavailableException(
        'A swap commission is configured (STELLAR_SWAP_FEE_BPS) but STELLAR_SWAP_FEE_WALLET is not set',
      );
    }

    const stellarCfg = this.config.get('stellar', { infer: true });

    // Pre-flight: the withdraw itself funds the fee payments (they come out of
    // the just-received reserves), so we only need the account to keep its XLM
    // minimum reserve plus the tx fee. Clear 400 instead of an on-chain reject.
    const opCount = 1 + (feeA > 0n ? 1 : 0) + (feeB > 0n ? 1 : 0);
    assertCanAfford(
      account,
      account.balances,
      [],
      false,
      BigInt(stellarCfg.baseFee) * BigInt(opCount),
    );

    const builder = new TransactionBuilder(account, {
      fee: stellarCfg.baseFee,
      networkPassphrase: this.stellar.passphrase(network),
    }).addOperation(
      Operation.liquidityPoolWithdraw({
        liquidityPoolId: dto.poolId,
        amount: fromStroops(shares),
        minAmountA: fromStroops(minA),
        minAmountB: fromStroops(minB),
      }),
    );
    // Collect the plan commission out of the just-received reserves.
    if (feeA > 0n && feeWallet) {
      builder.addOperation(
        Operation.payment({
          destination: feeWallet,
          asset: this.assetFromReserve(resA),
          amount: fromStroops(feeA),
        }),
      );
    }
    if (feeB > 0n && feeWallet) {
      builder.addOperation(
        Operation.payment({
          destination: feeWallet,
          asset: this.assetFromReserve(resB),
          amount: fromStroops(feeB),
        }),
      );
    }
    this.addMemo(builder, memo, feeA + feeB > 0n);

    const tx = builder.setTimeout(stellarCfg.timeoutSeconds).build();
    const op = await this.persist(consumer, {
      consumerId: local.id,
      kind: 'WITHDRAW' as const,
      network,
      source: dto.source,
      poolId: dto.poolId,
      assetA: resA.asset,
      assetAIssuer: resA.issuer,
      assetB: resB.asset,
      assetBIssuer: resB.issuer,
      amountA: fromStroops(minA),
      amountB: fromStroops(minB),
      shares: fromStroops(shares),
      minPrice: null,
      maxPrice: null,
      slippageBps,
      feeBps,
      feeAmountA: fromStroops(feeA),
      feeAmountB: fromStroops(feeB),
      feeWallet: feeA + feeB > 0n ? feeWallet : null,
      tx,
      timeoutSeconds: stellarCfg.timeoutSeconds,
    });
    this.logger.log(
      `Created LP withdraw ${op.id}: ${fromStroops(shares)} shares of pool ` +
        `${dto.poolId.slice(0, 8)}… (consumer=${consumer.username}, network=${network})`,
    );
    return op;
  }

  // ── Read (operations) ───────────────────────────────────────────────────────
  async findAllOperations(
    consumer: GatewayConsumer,
    query: QueryLiquidityOperationsDto,
  ): Promise<{
    data: LiquidityPoolOperation[];
    total: number;
    take: number;
    skip: number;
  }> {
    const where = {
      consumer: { apisixUsername: consumer.username },
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.liquidityPoolOperation.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.liquidityPoolOperation.count({ where }),
    ]);
    return { data, total, take: query.take, skip: query.skip };
  }

  async findOneOperation(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<LiquidityOperationView> {
    return this.withQr(await this.findOwned(consumer, id));
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  /**
   * Relays the signed transaction to the network. The signed envelope must be
   * the one we built (hash-verified against the stored operation). A network
   * rejection finalizes the operation as FAILED **only if it is still
   * in-flight** — a concurrent observer that already marked it SUCCEEDED (and
   * captured cost basis) must not be overwritten. An unreachable network is a
   * 503 and leaves it re-submittable.
   */
  async submit(
    consumer: GatewayConsumer,
    id: string,
    signedXdr: string,
  ): Promise<LiquiditySubmitOutcome> {
    const op = await this.findOwned(consumer, id);

    if (op.status === 'SUCCEEDED') {
      return {
        submitted: true,
        status: 'SUCCEEDED',
        txHash: op.txHash,
        operation: await this.withQr(op),
      };
    }
    if (!['PENDING', 'SUBMITTED', 'FAILED'].includes(op.status)) {
      throw new BadRequestException(
        `Cannot submit a ${op.status} liquidity pool operation`,
      );
    }

    let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      tx = TransactionBuilder.fromXDR(
        signedXdr,
        this.stellar.passphrase(op.network as StellarNetwork),
      );
    } catch {
      throw new BadRequestException(
        'signedXdr is not a valid transaction envelope',
      );
    }
    if (tx.hash().toString('hex') !== op.txHash) {
      throw new BadRequestException(
        'The signed transaction does not match this operation',
      );
    }

    const submitted = await this.markSubmitted(op.id);
    // Observer may have liquidated the row between our read and this write.
    if (submitted.operation.status === 'SUCCEEDED') {
      return {
        submitted: true,
        status: 'SUCCEEDED',
        txHash: submitted.operation.txHash,
        operation: await this.withQr(submitted.operation),
      };
    }
    if (submitted.operation.status !== 'SUBMITTED') {
      throw new BadRequestException(
        `Cannot submit a ${submitted.operation.status} liquidity pool operation`,
      );
    }
    if (submitted.applied) {
      await this.emit(
        consumer.username,
        'LIQUIDITY_SUBMITTED',
        submitted.operation,
      );
    }

    try {
      const res = await this.stellar
        .server(op.network as StellarNetwork)
        .submitTransaction(tx);
      const succeeded = await this.finalizeSucceeded(
        op.id,
        consumer.username,
        res.hash,
      );
      this.logger.log(
        `LP operation ${op.id} submitted and confirmed (tx=${res.hash})`,
      );
      return {
        submitted: true,
        status: 'SUCCEEDED',
        txHash: succeeded.operation.txHash,
        operation: await this.withQr(succeeded.operation),
      };
    } catch (err) {
      const resultCodes = this.extractResultCodes(err);
      if (resultCodes) {
        const failed = await this.finalizeFailed(op.id, consumer.username);
        if (failed.operation.status === 'SUCCEEDED') {
          // Observer already settled this tx on-chain. Do not report failure
          // and do not touch the captured cost basis.
          this.logger.log(
            `LP operation ${op.id} Horizon rejection ignored; already SUCCEEDED`,
          );
          return {
            submitted: true,
            status: 'SUCCEEDED',
            txHash: failed.operation.txHash,
            operation: await this.withQr(failed.operation),
          };
        }
        this.logger.warn(
          `LP operation ${op.id} rejected on submit: ${resultCodes.join(', ')}`,
        );
        return {
          submitted: false,
          status: 'FAILED',
          reason: 'Transaction rejected by the network',
          resultCodes,
          operation: await this.withQr(failed.operation),
        };
      }
      this.logger.error(`LP operation ${op.id} submission error`, err);
      throw new ServiceUnavailableException(
        'Could not submit the transaction to the Stellar network',
      );
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────────────
  private async persist(
    consumer: GatewayConsumer,
    input: {
      consumerId: string;
      kind: 'DEPOSIT' | 'WITHDRAW';
      network: StellarNetwork;
      source: string;
      poolId: string;
      assetA: string;
      assetAIssuer: string | null;
      assetB: string;
      assetBIssuer: string | null;
      amountA: string;
      amountB: string;
      shares: string | null;
      minPrice: string | null;
      maxPrice: string | null;
      slippageBps: number;
      feeBps: number;
      feeAmountA: string;
      feeAmountB: string;
      feeWallet: string | null;
      tx: ReturnType<TransactionBuilder['build']>;
      timeoutSeconds: number;
    },
  ): Promise<LiquidityOperationView> {
    const { tx, timeoutSeconds, ...data } = input;
    const xdr = tx.toXDR();
    const op = await this.prisma.liquidityPoolOperation.create({
      data: {
        ...data,
        status: 'PENDING',
        xdr,
        uri: `web+stellar:tx?${new URLSearchParams({ xdr }).toString()}`,
        txHash: tx.hash().toString('hex'),
        // The tx is only valid for its timeout window; after that it can't settle.
        expiresAt: new Date(Date.now() + timeoutSeconds * 1000),
      },
    });
    await this.emit(consumer.username, 'LIQUIDITY_CREATED', op);
    return this.withQr(op);
  }

  // ── Status transitions ──────────────────────────────────────────────────────
  /**
   * Optimistic status guard: the UPDATE only matches rows still in `from`.
   * Never writes cost-basis columns (`sharesReceived` / `settledAmountA` /
   * `settledAmountB`), so an error transition cannot clobber a captured basis.
   */
  private async guardedUpdate(
    id: string,
    from: readonly LpOperationStatus[],
    data: { status: SwapStatus; txHash?: string },
  ): Promise<{ applied: boolean; operation: LiquidityPoolOperation }> {
    const result = await this.prisma.liquidityPoolOperation.updateMany({
      where: { id, status: { in: [...from] } },
      data,
    });
    const operation =
      await this.prisma.liquidityPoolOperation.findUniqueOrThrow({
        where: { id },
      });
    return { applied: result.count > 0, operation };
  }

  /**
   * PENDING → SUBMITTED keeps the epoch (same settlement attempt).
   * FAILED → SUBMITTED bumps it so a later LIQUIDITY_FAILED is a new event.
   */
  private async markSubmitted(
    id: string,
  ): Promise<{ applied: boolean; operation: LiquidityPoolOperation }> {
    const resent = await this.prisma.liquidityPoolOperation.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'SUBMITTED', settlementEpoch: { increment: 1 } },
    });
    if (resent.count > 0) {
      const operation =
        await this.prisma.liquidityPoolOperation.findUniqueOrThrow({
          where: { id },
        });
      return { applied: true, operation };
    }
    return this.guardedUpdate(id, ['PENDING'], { status: 'SUBMITTED' });
  }

  /**
   * Promotes an in-flight (or falsely-FAILED) operation to SUCCEEDED and
   * captures deposit cost basis. Idempotent if already SUCCEEDED. Used by
   * submit and the settlement observer so both writers share the same guard.
   */
  async finalizeSucceeded(
    id: string,
    username: string,
    txHash?: string,
  ): Promise<{ applied: boolean; operation: LiquidityPoolOperation }> {
    const { applied, operation } = await this.guardedUpdate(
      id,
      LP_CAN_SUCCEED_STATUSES,
      { status: 'SUCCEEDED', ...(txHash ? { txHash } : {}) },
    );
    if (applied) await this.emit(username, 'LIQUIDITY_SUCCEEDED', operation);
    if (operation.status === 'SUCCEEDED') {
      await this.captureDepositBasis(operation);
      const fresh = await this.prisma.liquidityPoolOperation.findUniqueOrThrow({
        where: { id },
      });
      return { applied, operation: fresh };
    }
    return { applied, operation };
  }

  /**
   * Marks FAILED only while the row is still in-flight. A liquidated
   * (`SUCCEEDED`) operation is left untouched — including its cost basis.
   */
  async finalizeFailed(
    id: string,
    username: string,
  ): Promise<{ applied: boolean; operation: LiquidityPoolOperation }> {
    const { applied, operation } = await this.guardedUpdate(
      id,
      LP_CAN_FAIL_STATUSES,
      { status: 'FAILED' },
    );
    if (applied) await this.emit(username, 'LIQUIDITY_FAILED', operation);
    return { applied, operation };
  }

  /**
   * Marks EXPIRED only while the row is still in-flight. Never degrades a
   * liquidated operation. Emits `LIQUIDITY_EXPIRED` when this writer wins.
   */
  async finalizeExpired(
    id: string,
    username: string,
  ): Promise<{ applied: boolean; operation: LiquidityPoolOperation }> {
    const { applied, operation } = await this.guardedUpdate(
      id,
      LP_IN_FLIGHT_STATUSES,
      { status: 'EXPIRED' },
    );
    if (applied) await this.emit(username, 'LIQUIDITY_EXPIRED', operation);
    return { applied, operation };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  /** Network follows the API key type (prod → public, dev → testnet). */
  private resolveNetwork(consumer: GatewayConsumer): StellarNetwork {
    if (consumer.environment === 'prod') return 'public';
    if (consumer.environment === 'dev') return 'testnet';
    return this.config.get('stellar', { infer: true }).network;
  }

  /** Mirror the APISIX consumer locally so operations can be scoped to it. */
  private resolveConsumer(consumer: GatewayConsumer) {
    return this.prisma.consumer.upsert({
      where: { apisixUsername: consumer.username },
      create: {
        apisixUsername: consumer.username,
        credentialId: consumer.credentialId,
      },
      update: { credentialId: consumer.credentialId },
    });
  }

  private feeWallet(): string {
    return this.config.get('stellar', { infer: true }).swap.feeWallet;
  }

  /**
   * The plan commission (bps) for this request — the same rate that governs
   * swaps. The gateway injects the organization's plan rate (`planSwapFeeBps`)
   * per consumer; it is NEVER a request parameter, so the caller cannot bypass
   * or undercut it. Only when the gateway didn't forward it (local dev without
   * APISIX) do we fall back to the configured default, gated on a fee wallet.
   */
  private resolveSwapFeeBps(consumer: GatewayConsumer): number {
    if (consumer.planSwapFeeBps !== null) {
      return consumer.planSwapFeeBps;
    }
    const swap = this.config.get('stellar', { infer: true }).swap;
    return swap.feeWallet ? swap.feeBps : 0;
  }

  /** The SDK Asset for a parsed reserve (native or issued). */
  private assetFromReserve(r: LiquidityPoolReserve): Asset {
    return r.issuer ? new Asset(r.asset, r.issuer) : Asset.native();
  }

  /**
   * Applies the transaction memo: the caller's MEMO_ID when supplied, otherwise
   * a default MEMO_TEXT commission label when a commission was collected — so
   * the platform fee is identifiable on-chain. No memo when neither applies.
   */
  private addMemo(
    builder: TransactionBuilder,
    memo: string | null,
    feeCollected: boolean,
  ): void {
    if (memo) {
      builder.addMemo(Memo.id(memo));
    } else if (feeCollected) {
      builder.addMemo(Memo.text(LIQUIDITY_COMMISSION_MEMO));
    }
  }

  /** Caller slippage, defaulted and clamped like swaps (same settings). */
  private resolveSlippage(requested?: number): number {
    const swap = this.config.get('stellar', { infer: true }).swap;
    const bps = requested ?? swap.slippageBps;
    if (bps > swap.maxSlippageBps) {
      throw new BadRequestException(
        `slippageBps ${bps} exceeds the maximum allowed (${swap.maxSlippageBps})`,
      );
    }
    return bps;
  }

  private resolveMemo(provided?: string): string | null {
    if (provided === undefined) return null;
    if (!/^\d+$/.test(provided) || BigInt(provided) > MAX_UINT64) {
      throw new BadRequestException('memo must be a MEMO_ID: a numeric uint64');
    }
    return provided;
  }

  /** No code (or XLM/native) → native lumens; any other code needs an issuer. */
  private resolveAsset(code?: string, issuer?: string): ResolvedAsset {
    const c = code?.trim();
    if (!c || c.toLowerCase() === 'xlm' || c.toLowerCase() === 'native') {
      return { code: 'native', issuer: null, asset: Asset.native() };
    }
    if (!issuer) {
      throw new BadRequestException(
        `An issuer is required for non-native asset "${c}"`,
      );
    }
    return { code: c, issuer, asset: new Asset(c, issuer) };
  }

  private assertPoolId(poolId: string): void {
    if (!/^[0-9a-f]{64}$/.test(poolId)) {
      throw new BadRequestException(
        'poolId must be a 64-character lowercase hex liquidity pool id',
      );
    }
  }

  /**
   * Average-cost basis of the shares `source` still holds in `poolId`, derived
   * from our own SUCCEEDED deposits (which recorded the shares + amounts at
   * settlement) and withdrawals. Only deposits with a captured `sharesReceived`
   * count — positions opened outside Cosmos Pay have no basis and are taxed
   * nothing. All values are stroop bigints.
   */
  private async costBasis(
    consumerId: string,
    source: string,
    poolId: string,
  ): Promise<{
    depositedShares: bigint;
    remainingShares: bigint;
    costA: bigint;
    costB: bigint;
  }> {
    const ops = await this.prisma.liquidityPoolOperation.findMany({
      where: { consumerId, source, poolId, status: 'SUCCEEDED' },
      select: {
        kind: true,
        shares: true,
        sharesReceived: true,
        settledAmountA: true,
        settledAmountB: true,
        amountA: true,
        amountB: true,
      },
    });
    return aggregateCostBasis(ops);
  }

  /**
   * Records a settled deposit's cost basis (shares minted + reserves actually
   * deposited) from its on-chain `liquidity_pool_deposited` effect, so a later
   * withdraw can be taxed only on the gain. Idempotent: a no-op unless this is a
   * SUCCEEDED DEPOSIT whose basis has not been captured yet. Best-effort — a
   * Horizon hiccup just leaves the basis uncaptured (that deposit is then taxed
   * nothing). The UPDATE is itself guarded: it will not write over an existing
   * basis or onto a row that is no longer SUCCEEDED.
   */
  async captureDepositBasis(op: LiquidityPoolOperation): Promise<void> {
    if (op.kind !== 'DEPOSIT' || op.sharesReceived != null) return;
    if (op.status !== 'SUCCEEDED') return;
    try {
      const page = await this.stellar
        .server(op.network as StellarNetwork)
        .effects()
        .forTransaction(op.txHash)
        .call();
      const eff = page.records.find(
        (e) => (e as { type?: string }).type === 'liquidity_pool_deposited',
      ) as
        | {
            reserves_deposited?: { asset: string; amount: string }[];
            shares_received?: string;
          }
        | undefined;
      if (!eff?.shares_received) return;
      const keyA =
        op.assetA === 'native' ? 'native' : `${op.assetA}:${op.assetAIssuer}`;
      const keyB =
        op.assetB === 'native' ? 'native' : `${op.assetB}:${op.assetBIssuer}`;
      const reserves = eff.reserves_deposited ?? [];
      const result = await this.prisma.liquidityPoolOperation.updateMany({
        where: {
          id: op.id,
          kind: 'DEPOSIT',
          status: 'SUCCEEDED',
          sharesReceived: null,
        },
        data: {
          sharesReceived: eff.shares_received,
          settledAmountA:
            reserves.find((r) => r.asset === keyA)?.amount ?? op.amountA,
          settledAmountB:
            reserves.find((r) => r.asset === keyB)?.amount ?? op.amountB,
        },
      });
      if (result.count > 0) {
        this.logger.log(
          `Captured cost basis for deposit ${op.id}: ${eff.shares_received} shares`,
        );
      }
    } catch {
      this.logger.warn(`Failed to capture cost basis for deposit ${op.id}`);
    }
  }

  /** Horizon reserve strings are `native` or `CODE:ISSUER`. */
  private parseReserve(r: {
    asset: string;
    amount: string;
  }): LiquidityPoolReserve {
    if (r.asset === 'native') {
      return { asset: 'native', issuer: null, amount: r.amount };
    }
    const [code, issuer] = r.asset.split(':');
    return { asset: code, issuer: issuer ?? null, amount: r.amount };
  }

  /** The pool's reserve amount for a given constituent asset. */
  private reserveOf(pool: PoolRecord, asset: ResolvedAsset): string {
    const key =
      asset.code === 'native' ? 'native' : `${asset.code}:${asset.issuer}`;
    const reserve = pool.reserves.find((r) => r.asset === key);
    return reserve?.amount ?? '0';
  }

  private toPoolEntity(
    network: StellarNetwork,
    pool: PoolRecord,
  ): LiquidityPoolEntity {
    return {
      id: pool.id,
      network,
      feeBp: pool.fee_bp,
      totalTrustlines: pool.total_trustlines,
      totalShares: pool.total_shares,
      reserves: pool.reserves.map((r) => this.parseReserve(r)),
    };
  }

  /** Fetches a pool by id; null when it does not exist (yet). */
  private async fetchPool(
    network: StellarNetwork,
    poolId: string,
  ): Promise<PoolRecord | null> {
    try {
      return await this.stellar
        .server(network)
        .liquidityPools()
        .liquidityPoolId(poolId)
        .call();
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) return null;
      this.logger.error('Failed to load liquidity pool from Horizon', error);
      throw new ServiceUnavailableException(
        'Could not reach the Stellar network',
      );
    }
  }

  private async loadAccount(network: StellarNetwork, address: string) {
    try {
      return await this.stellar.server(network).loadAccount(address);
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) {
        throw new BadRequestException(
          `Account ${address} not found or not funded on the ${network} network`,
        );
      }
      this.logger.error('Failed to load account from Horizon', error);
      throw new ServiceUnavailableException(
        'Could not reach the Stellar network',
      );
    }
  }

  private label(a: ResolvedAsset): string {
    return a.code === 'native' ? 'XLM' : a.code;
  }

  private async findOwned(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<LiquidityPoolOperation> {
    const op = await this.prisma.liquidityPoolOperation.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
    });
    if (!op) {
      throw new NotFoundException(`Liquidity pool operation ${id} not found`);
    }
    return op;
  }

  /** Pulls Horizon's transaction/operation result codes off a failed submit. */
  private extractResultCodes(err: unknown): string[] | null {
    const data = (
      err as {
        response?: {
          data?: { extras?: { result_codes?: ResultCodes } };
          extras?: { result_codes?: ResultCodes };
        };
      }
    )?.response;
    const rc = data?.data?.extras?.result_codes ?? data?.extras?.result_codes;
    if (!rc) return null;
    const codes: string[] = [];
    if (rc.transaction) codes.push(rc.transaction);
    if (Array.isArray(rc.operations)) codes.push(...rc.operations);
    return codes.length ? codes : null;
  }

  private async withQr(
    op: LiquidityPoolOperation,
  ): Promise<LiquidityOperationView> {
    return {
      ...op,
      qr: await QRCode.toDataURL(op.uri),
      // A collected commission (feeWallet set) is labelled with the memo text.
      commissionMemo: op.feeWallet ? LIQUIDITY_COMMISSION_MEMO : null,
    };
  }

  private emit(
    username: string,
    type: WebhookEventType,
    data: LiquidityPoolOperation,
  ): Promise<boolean> {
    return this.webhooks.emit(username, type, data);
  }
}

interface ResultCodes {
  transaction?: string;
  operations?: string[];
}
