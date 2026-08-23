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
  Memo,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import QRCode from 'qrcode';
import { AppConfig, StellarNetwork } from '../config/configuration';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import type {
  Prisma,
  Swap,
  SwapStatus,
  WebhookEventType,
} from '../../generated/prisma/client';
import { WebhookTerminalEmitter } from '../webhooks/webhook-terminal-emitter.service';
import { CreateSwapDto } from './dto/create-swap.dto';
import { QuerySwapsDto } from './dto/query-swaps.dto';
import { QuoteSwapDto } from './dto/quote-swap.dto';
import {
  SWAP_CAN_SUCCEED_STATUSES,
  SWAP_IN_FLIGHT_STATUSES,
} from './swap-transitions';
import {
  SwapAssetAmount,
  SwapPathHop,
  SwapQuoteEntity,
} from './entities/swap.entity';
import { applySlippage, computeFee, fromStroops, toStroops } from './swap-math';

const MAX_UINT64 = 18446744073709551615n;

/**
 * On-chain MEMO_TEXT stamped on a swap that collects the platform commission
 * when the caller did not supply their own MEMO_ID — so the commission is
 * identifiable on the ledger. English by design (the canonical label). ≤ 28
 * bytes (the MEMO_TEXT limit).
 */
export const SWAP_COMMISSION_MEMO = 'Cosmos Swap Commission';

/** A stored swap plus its derived QR — the shape API responses return. */
export type SwapView = Swap & {
  qr: string;
  /** The commission MEMO_TEXT label when a commission was collected, else null. */
  commissionMemo: string | null;
};

/**
 * Result of relaying a signed swap (the service-side counterpart of
 * SwapSubmitResultEntity, which only describes the OpenAPI shape).
 */
export interface SwapSubmitOutcome {
  submitted: boolean;
  status: SwapStatus;
  txHash?: string;
  reason?: string;
  resultCodes?: string[];
  swap: SwapView;
}

/** Resolved asset: its stored code/issuer and the SDK Asset for building txs. */
interface ResolvedAsset {
  code: string;
  issuer: string | null;
  asset: Asset;
}

/** A priced swap — everything quote and create both need. */
interface PricedSwap {
  send: ResolvedAsset;
  dest: ResolvedAsset;
  feeBps: number;
  slippageBps: number;
  sendAmount: string; // gross input
  feeAmount: string; // taken from the source asset
  swapAmount: string; // routed (input − fee)
  estimated: string; // quoted destination amount
  destMin: string; // slippage-protected minimum
  path: SwapPathHop[];
}

/** Minimal shape we read off a Horizon path record. */
interface PathRecord {
  destination_amount: string;
  path: { asset_type: string; asset_code?: string; asset_issuer?: string }[];
}

/**
 * Stellar native swaps. Stellar has no swap primitive — asset exchange is a
 * `PathPaymentStrictSend` routed through the DEX/AMM. This service is
 * **non-custodial**: it quotes via Horizon, assembles the unsigned transaction
 * (an optional platform fee payment + the path payment), and relays the signed
 * transaction the customer hands back. Funds never pass through Cosmos Pay.
 */
@Injectable()
export class SwapsService {
  private readonly logger = new Logger(SwapsService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookTerminalEmitter,
    private readonly stellar: StellarService,
  ) {}

  // ── Quote ───────────────────────────────────────────────────────────────────
  /** Prices a swap (Horizon path search + fee/slippage math). Persists nothing. */
  async quote(
    consumer: GatewayConsumer,
    dto: QuoteSwapDto,
  ): Promise<SwapQuoteEntity> {
    const network = this.resolveNetwork(consumer);
    const priced = await this.priceSwap(
      network,
      dto,
      this.resolveSwapFeeBps(consumer),
    );
    return this.toQuoteEntity(network, priced);
  }

  // ── Create ────────────────────────────────────────────────────────────────
  /**
   * Builds the unsigned swap transaction and persists it. Returns the XDR + a
   * SEP-7 `tx` URI + QR for the customer's wallet to sign, then submitted back
   * via {@link submit}.
   */
  async create(
    consumer: GatewayConsumer,
    dto: CreateSwapDto,
  ): Promise<SwapView> {
    const network = this.resolveNetwork(consumer);
    const local = await this.resolveConsumer(consumer);
    const priced = await this.priceSwap(
      network,
      dto,
      this.resolveSwapFeeBps(consumer),
    );

    const destination = dto.destination ?? dto.source;
    const memo = this.resolveMemo(dto.memo);
    const feeWallet = this.feeWallet();
    const feeStroops = toStroops(priced.feeAmount);

    // A configured fee with nowhere to send it is a misconfiguration, not a
    // silent no-op — fail loudly so the operator notices.
    if (feeStroops > 0n && !feeWallet) {
      throw new ServiceUnavailableException(
        'A swap fee is configured (STELLAR_SWAP_FEE_BPS) but STELLAR_SWAP_FEE_WALLET is not set',
      );
    }

    const stellarCfg = this.config.get('stellar', { infer: true });
    const account = await this.loadAccount(network, dto.source);

    // The destination must already trust a non-native asset, or the path payment
    // would fail on-chain. Catch it now with a clear message.
    await this.assertDestinationCanReceive(network, destination, priced.dest, {
      account,
      address: dto.source,
    });

    const builder = new TransactionBuilder(account, {
      fee: stellarCfg.baseFee,
      networkPassphrase: this.stellar.passphrase(network),
    });
    // Operation 1: collect the platform fee in the source asset (skipped at 0%).
    if (feeStroops > 0n && feeWallet) {
      builder.addOperation(
        Operation.payment({
          destination: feeWallet,
          asset: priced.send.asset,
          amount: priced.feeAmount,
        }),
      );
    }
    // Operation 2: the swap itself — send the net amount, receive ≥ destMin.
    builder.addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: priced.send.asset,
        sendAmount: priced.swapAmount,
        destination,
        destAsset: priced.dest.asset,
        destMin: priced.destMin,
        path: this.pathToAssets(priced.path),
      }),
    );
    // Caller MEMO_ID when supplied; otherwise a default commission MEMO_TEXT so
    // the platform fee is identifiable on-chain. No memo when neither applies.
    if (memo) {
      builder.addMemo(Memo.id(memo));
    } else if (feeStroops > 0n) {
      builder.addMemo(Memo.text(SWAP_COMMISSION_MEMO));
    }

    const tx = builder.setTimeout(stellarCfg.timeoutSeconds).build();
    const xdr = tx.toXDR();
    const txHash = tx.hash().toString('hex');
    const uri = `web+stellar:tx?${new URLSearchParams({ xdr }).toString()}`;

    const swap = await this.prisma.swap.create({
      data: {
        consumerId: local.id,
        network,
        source: dto.source,
        destination,
        sendAsset: priced.send.code,
        sendAssetIssuer: priced.send.issuer,
        sendAmount: priced.sendAmount,
        feeAmount: priced.feeAmount,
        feeBps: priced.feeBps,
        swapAmount: priced.swapAmount,
        destAsset: priced.dest.code,
        destAssetIssuer: priced.dest.issuer,
        destEstimated: priced.estimated,
        destMin: priced.destMin,
        slippageBps: priced.slippageBps,
        path: priced.path as unknown as Prisma.InputJsonValue,
        memo,
        status: 'PENDING',
        xdr,
        uri,
        txHash,
        // The tx is only valid for its timeout window; after that it can't settle.
        expiresAt: new Date(Date.now() + stellarCfg.timeoutSeconds * 1000),
      },
    });

    this.logger.log(
      `Created swap ${swap.id}: ${priced.sendAmount} ${this.label(priced.send)} → ` +
        `~${priced.estimated} ${this.label(priced.dest)} (consumer=${consumer.username}, network=${network})`,
    );
    await this.emit(consumer.username, 'SWAP_CREATED', swap);
    return this.withQr(swap);
  }

  // ── Read (list) ─────────────────────────────────────────────────────────────
  async findAll(
    consumer: GatewayConsumer,
    query: QuerySwapsDto,
  ): Promise<{ data: Swap[]; total: number; take: number; skip: number }> {
    const where = {
      consumer: { apisixUsername: consumer.username },
      ...(query.status ? { status: query.status } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.swap.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.swap.count({ where }),
    ]);
    return { data, total, take: query.take, skip: query.skip };
  }

  // ── Read (one) ──────────────────────────────────────────────────────────────
  async findOne(consumer: GatewayConsumer, id: string): Promise<SwapView> {
    const swap = await this.findOwned(consumer, id);
    return this.withQr(swap);
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  /**
   * Relays the signed transaction to the network. The signed envelope must be the
   * one we built (its hash is verified against the stored swap), so a caller can't
   * have us broadcast an arbitrary transaction. A network rejection finalizes the
   * swap as FAILED (with the result codes); an unreachable network is a 503 and
   * leaves the swap re-submittable.
   */
  async submit(
    consumer: GatewayConsumer,
    id: string,
    signedXdr: string,
  ): Promise<SwapSubmitOutcome> {
    const swap = await this.findOwned(consumer, id);

    // Already settled — return current state without touching the network.
    if (swap.status === 'SUCCEEDED') {
      return {
        submitted: true,
        status: 'SUCCEEDED',
        txHash: swap.txHash,
        swap: await this.withQr(swap),
      };
    }
    if (!['PENDING', 'SUBMITTED', 'FAILED'].includes(swap.status)) {
      throw new BadRequestException(`Cannot submit a ${swap.status} swap`);
    }

    let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
    try {
      tx = TransactionBuilder.fromXDR(
        signedXdr,
        this.stellar.passphrase(swap.network as StellarNetwork),
      );
    } catch {
      throw new BadRequestException(
        'signedXdr is not a valid transaction envelope',
      );
    }

    // Integrity: signing does not change the hash, so the signed tx must hash to
    // the same value as the one we built and stored.
    if (tx.hash().toString('hex') !== swap.txHash) {
      throw new BadRequestException(
        'The signed transaction does not match this swap',
      );
    }

    // Mark in-flight before broadcasting; on an unreachable network we leave it
    // here (re-submittable), only advancing to a terminal state on a real result.
    // Observer may have liquidated the row between our read and this write.
    const submitted = await this.markSubmitted(swap.id);
    if (submitted.swap.status === 'SUCCEEDED') {
      return {
        submitted: true,
        status: 'SUCCEEDED',
        txHash: submitted.swap.txHash,
        swap: await this.withQr(submitted.swap),
      };
    }
    if (submitted.swap.status !== 'SUBMITTED') {
      throw new BadRequestException(
        `Cannot submit a ${submitted.swap.status} swap`,
      );
    }
    if (submitted.applied) {
      await this.emit(consumer.username, 'SWAP_SUBMITTED', submitted.swap);
    }

    try {
      const res = await this.stellar
        .server(swap.network as StellarNetwork)
        .submitTransaction(tx);
      const succeeded = await this.finalizeSucceeded(
        swap.id,
        consumer.username,
        res.hash,
      );
      this.logger.log(
        `Swap ${swap.id} submitted and confirmed (tx=${res.hash})`,
      );
      return {
        submitted: true,
        status: 'SUCCEEDED',
        txHash: succeeded.swap.txHash,
        swap: await this.withQr(succeeded.swap),
      };
    } catch (err) {
      const resultCodes = this.extractResultCodes(err);
      if (resultCodes) {
        const failed = await this.finalizeFailed(swap.id, consumer.username);
        if (failed.swap.status === 'SUCCEEDED') {
          // Observer already settled this tx on-chain. Do not report failure.
          this.logger.log(
            `Swap ${swap.id} Horizon rejection ignored; already SUCCEEDED`,
          );
          return {
            submitted: true,
            status: 'SUCCEEDED',
            txHash: failed.swap.txHash,
            swap: await this.withQr(failed.swap),
          };
        }
        this.logger.warn(
          `Swap ${swap.id} rejected on submit: ${resultCodes.join(', ')}`,
        );
        return {
          submitted: false,
          status: 'FAILED',
          reason: 'Transaction rejected by the network',
          resultCodes,
          swap: await this.withQr(failed.swap),
        };
      }
      // Couldn't reach Horizon — leave it SUBMITTED so it can be retried.
      this.logger.error(`Swap ${swap.id} submission error`, err);
      throw new ServiceUnavailableException(
        'Could not submit the transaction to the Stellar network',
      );
    }
  }

  // ── Pricing ──────────────────────────────────────────────────────────────
  private async priceSwap(
    network: StellarNetwork,
    dto: QuoteSwapDto,
    feeBps: number,
  ): Promise<PricedSwap> {
    const send = this.resolveAsset(dto.sourceAssetCode, dto.sourceAssetIssuer);
    const dest = this.resolveAsset(dto.destAssetCode, dto.destAssetIssuer);
    if (send.code === dest.code && send.issuer === dest.issuer) {
      throw new BadRequestException(
        'Source and destination assets must differ for a swap',
      );
    }

    const slippageBps = this.resolveSlippage(dto.slippageBps);
    const sendStroops = toStroops(dto.amount);
    const feeStroops = computeFee(sendStroops, feeBps);
    const swapStroops = sendStroops - feeStroops;
    if (swapStroops <= 0n) {
      throw new BadRequestException(
        'amount is too small to cover the swap fee',
      );
    }
    const swapAmount = fromStroops(swapStroops);

    const best = await this.findBestPath(network, send, swapAmount, dest);
    const estStroops = toStroops(best.destination_amount);
    const destMinStroops = applySlippage(estStroops, slippageBps);

    return {
      send,
      dest,
      feeBps,
      slippageBps,
      sendAmount: fromStroops(sendStroops),
      feeAmount: fromStroops(feeStroops),
      swapAmount,
      estimated: fromStroops(estStroops),
      destMin: fromStroops(destMinStroops),
      path: best.path.map((p) =>
        p.asset_type === 'native'
          ? { code: 'native', issuer: null }
          : { code: p.asset_code ?? '', issuer: p.asset_issuer ?? null },
      ),
    };
  }

  private async findBestPath(
    network: StellarNetwork,
    send: ResolvedAsset,
    swapAmount: string,
    dest: ResolvedAsset,
  ): Promise<PathRecord> {
    let records: PathRecord[];
    try {
      const page = await this.stellar
        .server(network)
        .strictSendPaths(send.asset, swapAmount, [dest.asset])
        .call();
      records = page.records;
    } catch (err) {
      this.logger.error('strictSendPaths failed', err);
      throw new ServiceUnavailableException(
        'Could not reach the Stellar network for a quote',
      );
    }
    if (!records.length) {
      throw new BadRequestException(
        'No swap path found for this asset pair and amount',
      );
    }
    // Best price = the most destination asset for our fixed send amount.
    return records.reduce((best, r) =>
      toStroops(r.destination_amount) > toStroops(best.destination_amount)
        ? r
        : best,
    );
  }

  private toQuoteEntity(
    network: StellarNetwork,
    priced: PricedSwap,
  ): SwapQuoteEntity {
    const sideOf = (a: ResolvedAsset, amount: string): SwapAssetAmount => ({
      asset: a.code,
      issuer: a.issuer,
      amount,
    });
    return {
      network,
      source: sideOf(priced.send, priced.sendAmount),
      fee: {
        asset: priced.send.code,
        issuer: priced.send.issuer,
        amount: priced.feeAmount,
        bps: priced.feeBps,
        wallet: this.feeWallet() || null,
        label: SWAP_COMMISSION_MEMO,
      },
      swap: sideOf(priced.send, priced.swapAmount),
      destination: {
        asset: priced.dest.code,
        issuer: priced.dest.issuer,
        estimated: priced.estimated,
        minimum: priced.destMin,
        slippageBps: priced.slippageBps,
      },
      path: priced.path,
    };
  }

  // ── Status transitions ──────────────────────────────────────────────────────
  /**
   * Optimistic status guard: the UPDATE only matches rows still in `from`.
   * Winning this write is what authorizes a terminal webhook — arriving at
   * SUCCEEDED/FAILED by a stale read must not emit.
   */
  private async guardedUpdate(
    id: string,
    from: readonly SwapStatus[],
    data: { status: SwapStatus; txHash?: string },
  ): Promise<{ applied: boolean; swap: Swap }> {
    const result = await this.prisma.swap.updateMany({
      where: { id, status: { in: [...from] } },
      data,
    });
    const swap = await this.prisma.swap.findUniqueOrThrow({ where: { id } });
    return { applied: result.count > 0, swap };
  }

  /**
   * PENDING → SUBMITTED does not bump the epoch (same settlement attempt).
   * FAILED → SUBMITTED does: that is a new attempt, so a later SWAP_FAILED
   * must not share the previous attempt's dedup key.
   */
  private async markSubmitted(
    id: string,
  ): Promise<{ applied: boolean; swap: Swap }> {
    const resent = await this.prisma.swap.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'SUBMITTED', settlementEpoch: { increment: 1 } },
    });
    if (resent.count > 0) {
      const swap = await this.prisma.swap.findUniqueOrThrow({ where: { id } });
      return { applied: true, swap };
    }
    return this.guardedUpdate(id, ['PENDING'], { status: 'SUBMITTED' });
  }

  /**
   * Promotes an in-flight (or falsely-FAILED) swap to SUCCEEDED. Idempotent if
   * already SUCCEEDED. Used by submit and the settlement observer so both
   * writers share the same guard and the same emit function.
   */
  async finalizeSucceeded(
    id: string,
    username: string,
    txHash?: string,
  ): Promise<{ applied: boolean; swap: Swap }> {
    const { applied, swap } = await this.guardedUpdate(
      id,
      SWAP_CAN_SUCCEED_STATUSES,
      { status: 'SUCCEEDED', ...(txHash ? { txHash } : {}) },
    );
    if (applied) await this.emit(username, 'SWAP_SUCCEEDED', swap);
    return { applied, swap };
  }

  /**
   * Marks FAILED only while the row is still in-flight. A settled
   * (`SUCCEEDED`) swap is left untouched.
   */
  async finalizeFailed(
    id: string,
    username: string,
  ): Promise<{ applied: boolean; swap: Swap }> {
    const { applied, swap } = await this.guardedUpdate(
      id,
      SWAP_IN_FLIGHT_STATUSES,
      { status: 'FAILED' },
    );
    if (applied) await this.emit(username, 'SWAP_FAILED', swap);
    return { applied, swap };
  }

  /**
   * Marks EXPIRED only while the row is still in-flight. Never degrades a
   * settled swap.
   */
  async finalizeExpired(id: string): Promise<{ applied: boolean; swap: Swap }> {
    return this.guardedUpdate(id, SWAP_IN_FLIGHT_STATUSES, {
      status: 'EXPIRED',
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  /** Network follows the API key type (prod → public, dev → testnet). */
  private resolveNetwork(consumer: GatewayConsumer): StellarNetwork {
    if (consumer.environment === 'prod') return 'public';
    if (consumer.environment === 'dev') return 'testnet';
    return this.config.get('stellar', { infer: true }).network;
  }

  /** Mirror the APISIX consumer locally so swaps can be scoped to it. */
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
   * The swap commission (bps) for this request. The gateway injects the
   * organization's plan rate (`planSwapFeeBps`) per consumer — it is NEVER a
   * request parameter, so the rate cannot be bypassed or undercut by the caller.
   * Only when the gateway didn't forward it (local dev without APISIX) do we fall
   * back to the configured default, and only then gate it on having a fee wallet.
   */
  private resolveSwapFeeBps(consumer: GatewayConsumer): number {
    if (consumer.planSwapFeeBps !== null) {
      return consumer.planSwapFeeBps;
    }
    const swap = this.config.get('stellar', { infer: true }).swap;
    return swap.feeWallet ? swap.feeBps : 0;
  }

  /** Caller slippage, defaulted and clamped to the configured maximum. */
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

  private pathToAssets(path: SwapPathHop[]): Asset[] {
    return path.map((h) =>
      h.issuer ? new Asset(h.code, h.issuer) : Asset.native(),
    );
  }

  private label(a: ResolvedAsset): string {
    return a.code === 'native' ? 'XLM' : a.code;
  }

  private async findOwned(
    consumer: GatewayConsumer,
    id: string,
  ): Promise<Swap> {
    const swap = await this.prisma.swap.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
    });
    if (!swap) {
      throw new NotFoundException(`Swap ${id} not found`);
    }
    return swap;
  }

  /**
   * Ensures the destination can receive a non-native asset (has a trustline).
   * Native XLM needs none. Reuses the already-loaded source account when the
   * destination is the source (a self-swap).
   */
  private async assertDestinationCanReceive(
    network: StellarNetwork,
    destination: string,
    dest: ResolvedAsset,
    source: { account: { balances: unknown[] }; address: string },
  ): Promise<void> {
    if (dest.code === 'native' || !dest.issuer) return;
    const balances =
      destination === source.address
        ? source.account.balances
        : (await this.loadAccount(network, destination)).balances;
    const trusts = (balances as Array<Record<string, unknown>>).some(
      (b) => b.asset_code === dest.code && b.asset_issuer === dest.issuer,
    );
    if (!trusts) {
      throw new BadRequestException(
        `Destination ${destination} has no trustline for ${dest.code}:${dest.issuer} — ` +
          'it must trust the asset before it can receive the swap',
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

  private async withQr(swap: Swap): Promise<SwapView> {
    return {
      ...swap,
      qr: await QRCode.toDataURL(swap.uri),
      // A collected commission (feeAmount > 0) with no caller memo is labelled
      // on-chain with the commission memo text.
      commissionMemo:
        toStroops(swap.feeAmount) > 0n && !swap.memo
          ? SWAP_COMMISSION_MEMO
          : null,
    };
  }

  private emit(
    username: string,
    type: WebhookEventType,
    data: Swap,
  ): Promise<boolean> {
    return this.webhooks.emit(username, type, data);
  }
}

interface ResultCodes {
  transaction?: string;
  operations?: string[];
}
