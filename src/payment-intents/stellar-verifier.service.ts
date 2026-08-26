import { Injectable } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { horizonHttpStatus, StellarService } from '../stellar/stellar.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PaymentIntent } from '../../generated/prisma/client';
import type { StellarNetwork } from '../config/configuration';

export interface VerificationResult {
  valid: boolean;
  txHash?: string;
  reason?: string;
  /** The payer (source) account of the matched on-chain payment, when valid. */
  payer?: string;
}

/**
 * Common shape for Horizon payment-like operations after field-name differences
 * (e.g. create_account's `account`/`funder`/`starting_balance`) are normalized.
 */
export type ReceivedPayment = {
  to: string;
  /** Base G… account when Horizon also returned `to_muxed` (defensive). */
  toMuxedBase?: string;
  from: string;
  amount: string;
  assetType: string;
  assetCode?: string;
  assetIssuer?: string;
};

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGES = 50;

const GENERIC_NO_MATCH =
  'No payment in this transaction matches the destination/amount';

/**
 * Maps a Horizon operation record to a ReceivedPayment, or null when the
 * operation type cannot fulfill a payment intent.
 */
export function normalizeOperation(
  op: Horizon.ServerApi.OperationRecord,
): ReceivedPayment | null {
  // Horizon types `type` as an enum; compare as string to avoid enum/literal lint.
  const type = String(op.type);

  if (
    type === 'payment' ||
    type === 'path_payment_strict_receive' ||
    type === 'path_payment_strict_send'
  ) {
    // Destination asset/amount fields (`amount`, `asset_*`), never source_*.
    // Structural cast: the three record types share these fields but diverge
    // on `type`, so an intersection collapses to `never`.
    const p = op as unknown as {
      to: string;
      from: string;
      amount: string;
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
      to_muxed?: string;
    };
    return {
      to: p.to,
      toMuxedBase: p.to_muxed ? p.to : undefined,
      from: p.from,
      amount: p.amount,
      assetType: p.asset_type,
      assetCode: p.asset_code,
      assetIssuer: p.asset_issuer,
    };
  }

  if (type === 'create_account') {
    const c = op as Horizon.ServerApi.CreateAccountOperationRecord;
    return {
      to: c.account,
      from: c.funder,
      amount: c.starting_balance,
      assetType: 'native',
    };
  }

  return null;
}

function formatAsset(
  assetType: string,
  code?: string | null,
  issuer?: string | null,
): string {
  if (assetType === 'native') return 'native';
  return `${code ?? ''}:${issuer ?? ''}`;
}

function formatIntentAsset(intent: PaymentIntent): string {
  if (intent.asset === 'native') return 'native';
  return `${intent.asset}:${intent.assetIssuer ?? ''}`;
}

/**
 * Confirms that an on-chain Stellar transaction actually fulfills a payment
 * intent: it must be successful, contain a payment to the intent's destination
 * in the intent's asset for the exact amount, and the transaction memo must
 * match. Each intent carries its own `network` (derived from the API key type),
 * so all Horizon calls target that network. Used both by the manual `validate`
 * endpoint and the permanent observer, so the rule lives in one place.
 */
@Injectable()
export class StellarVerifierService {
  constructor(
    private readonly stellar: StellarService,
    private readonly prisma: PrismaService,
  ) {}

  private network(intent: PaymentIntent): StellarNetwork {
    return intent.network as StellarNetwork;
  }

  /** Verifies a specific transaction hash against the intent. */
  async verifyByHash(
    intent: PaymentIntent,
    txHash: string,
  ): Promise<VerificationResult> {
    const network = this.network(intent);
    let tx: Horizon.ServerApi.TransactionRecord;
    try {
      tx = await this.stellar.call(network, (server) =>
        server.transactions().transaction(txHash).call(),
      );
    } catch (err) {
      if (horizonHttpStatus(err) === 404) {
        return { valid: false, reason: 'Transaction not found on-chain' };
      }
      throw err;
    }

    if (!tx.successful) {
      return { valid: false, reason: 'Transaction failed on-chain' };
    }

    const memoCheck = this.memoMatches(intent, tx.memo_type, tx.memo);
    if (!memoCheck.ok) {
      return { valid: false, reason: memoCheck.reason };
    }

    const payments = await this.stellar.call(network, (server) =>
      server.payments().forTransaction(txHash).call(),
    );

    let mismatchReason: string | undefined;
    for (const op of payments.records) {
      const evaluated = this.evaluatePayment(intent, op);
      if (evaluated.ok) {
        return { valid: true, txHash, payer: evaluated.received.from };
      }
      if (evaluated.reason) {
        mismatchReason = evaluated.reason;
      }
    }

    return {
      valid: false,
      reason: mismatchReason ?? GENERIC_NO_MATCH,
    };
  }

  /**
   * Scans payments to the intent's destination and returns the hash of the
   * first transaction that fully matches (used by the observer when no hash
   * was reported by the integrator).
   *
   * - Payments with `created_at` before `intent.createdAt` never credit.
   * - With a persisted Horizon cursor (per intent), scans ascending from that
   *   token so co-located intents on the same destination cannot consume each
   *   other's matching payments.
   * - Without a cursor (cold start), scans descending from the tip until
   *   past `intent.createdAt`, paginating so matches beyond a single page
   *   are not lost.
   * - The paging token is upserted so the next cycle resumes where this
   *   one left off (issue #27).
   */
  async findMatchingPayment(
    intent: PaymentIntent,
    pageSize = DEFAULT_PAGE_SIZE,
  ): Promise<VerificationResult> {
    const network = this.network(intent);
    const saved = await this.loadCursor(intent.id);
    const order: 'asc' | 'desc' = saved ? 'asc' : 'desc';
    let cursor: string | undefined = saved?.pagingToken;
    let lastToken: string | undefined = cursor;
    let matched: VerificationResult | undefined;

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const records = await this.fetchPaymentPage(
          network,
          intent.destination,
          order,
          pageSize,
          cursor,
        );
        if (records.length === 0) {
          break;
        }

        let hitTimeFloor = false;
        for (const op of records) {
          lastToken = op.paging_token;

          if (this.opCreatedAt(op) < intent.createdAt.getTime()) {
            if (order === 'desc') {
              hitTimeFloor = true;
              break;
            }
            continue;
          }

          const result = await this.tryMatchOp(intent, network, op);
          if (result) {
            matched = result;
            break;
          }
        }

        if (matched || hitTimeFloor) {
          break;
        }
        if (records.length < pageSize) {
          break;
        }
        cursor = records[records.length - 1].paging_token;
      }
    } catch (err) {
      if (horizonHttpStatus(err) === 404) {
        return { valid: false, reason: 'Destination account not found' };
      }
      throw err;
    }

    if (lastToken && lastToken !== saved?.pagingToken) {
      await this.saveCursor(intent, lastToken);
    }

    return matched ?? { valid: false, reason: 'No matching payment found yet' };
  }

  private async fetchPaymentPage(
    network: StellarNetwork,
    account: string,
    order: 'asc' | 'desc',
    pageSize: number,
    cursor?: string,
  ): Promise<Horizon.ServerApi.OperationRecord[]> {
    const page = await this.stellar.call(network, (server) => {
      let builder = server
        .payments()
        .forAccount(account)
        .order(order)
        .limit(pageSize);
      if (cursor) {
        builder = builder.cursor(cursor);
      }
      return builder.call();
    });
    return page.records;
  }

  private async tryMatchOp(
    intent: PaymentIntent,
    network: StellarNetwork,
    op: Horizon.ServerApi.OperationRecord,
  ): Promise<VerificationResult | undefined> {
    const evaluated = this.evaluatePayment(intent, op);
    if (!evaluated.ok) {
      return undefined;
    }
    const tx = await this.stellar.call(network, (server) =>
      server.transactions().transaction(op.transaction_hash).call(),
    );
    if (!tx.successful) {
      return undefined;
    }
    if (!this.memoMatches(intent, tx.memo_type, tx.memo).ok) {
      return undefined;
    }
    return {
      valid: true,
      txHash: op.transaction_hash,
      payer: evaluated.received.from,
    };
  }

  private opCreatedAt(op: Horizon.ServerApi.OperationRecord): number {
    return new Date(op.created_at).getTime();
  }

  private async loadCursor(
    intentId: string,
  ): Promise<{ pagingToken: string } | null> {
    return this.prisma.horizonAccountCursor.findUnique({
      where: { intentId },
      select: { pagingToken: true },
    });
  }

  private async saveCursor(
    intent: PaymentIntent,
    pagingToken: string,
  ): Promise<void> {
    await this.prisma.horizonAccountCursor.upsert({
      where: { intentId: intent.id },
      create: {
        intentId: intent.id,
        network: this.network(intent),
        account: intent.destination,
        pagingToken,
      },
      update: { pagingToken },
    });
  }

  /**
   * A payment to the right destination, in the intent's asset, for the exact
   * amount. The amount check is skipped for open intents (no fixed amount).
   * When the op is aimed at the destination but asset/amount fail, `reason`
   * carries an actionable mismatch string for verifyByHash / observer logs.
   */
  private evaluatePayment(
    intent: PaymentIntent,
    op: Horizon.ServerApi.OperationRecord,
  ): { ok: true; received: ReceivedPayment } | { ok: false; reason?: string } {
    const received = normalizeOperation(op);
    if (!received) {
      return { ok: false };
    }

    if (!this.destinationMatches(intent, received)) {
      return { ok: false };
    }

    const receivedAsset = formatAsset(
      received.assetType,
      received.assetCode,
      received.assetIssuer,
    );
    const expectedAsset = formatIntentAsset(intent);
    if (receivedAsset !== expectedAsset) {
      return {
        ok: false,
        reason: `asset mismatch (received ${receivedAsset}, expected ${expectedAsset})`,
      };
    }

    if (
      intent.amount != null &&
      Number(received.amount) !== Number(intent.amount)
    ) {
      return {
        ok: false,
        reason: `amount mismatch (received ${received.amount}, expected ${intent.amount})`,
      };
    }

    return { ok: true, received };
  }

  private destinationMatches(
    intent: PaymentIntent,
    received: ReceivedPayment,
  ): boolean {
    if (received.to === intent.destination) return true;
    if (
      received.toMuxedBase != null &&
      received.toMuxedBase === intent.destination
    ) {
      return true;
    }
    return false;
  }

  /**
   * The transaction must carry the intent's MEMO_ID. The memo is mandatory and
   * is exactly how a payment is tied back to its intent on-chain.
   */
  private memoMatches(
    intent: PaymentIntent,
    memoType: string | undefined,
    memo: string | undefined,
  ): { ok: boolean; reason?: string } {
    if (memoType !== 'id' || String(memo ?? '') !== intent.memo) {
      return {
        ok: false,
        reason: `Memo mismatch (expected id memo "${intent.memo}")`,
      };
    }
    return { ok: true };
  }
}
