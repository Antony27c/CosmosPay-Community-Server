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

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGES = 50;

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
    const match = payments.records.find((op) =>
      this.paymentMatches(intent, op),
    );
    if (!match) {
      return {
        valid: false,
        reason:
          'No native payment in this transaction matches the destination/amount',
      };
    }

    const payer = (match as Horizon.ServerApi.PaymentOperationRecord).from;
    return { valid: true, txHash, payer };
  }

  /**
   * Scans payments to the intent's destination and returns the hash of the
   * first transaction that fully matches (used by the observer when no hash
   * was reported by the integrator).
   *
   * - Payments with `created_at` before `intent.createdAt` never credit.
   * - With a persisted Horizon cursor, scans ascending from that token.
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
    const saved = await this.loadCursor(network, intent.destination);
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
      await this.saveCursor(network, intent.destination, lastToken);
    }

    return (
      matched ?? { valid: false, reason: 'No matching payment found yet' }
    );
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
    if (!this.paymentMatches(intent, op)) {
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
    const payer = (op as Horizon.ServerApi.PaymentOperationRecord).from;
    return { valid: true, txHash: op.transaction_hash, payer };
  }

  private opCreatedAt(op: Horizon.ServerApi.OperationRecord): number {
    return new Date(op.created_at).getTime();
  }

  private async loadCursor(
    network: StellarNetwork,
    account: string,
  ): Promise<{ pagingToken: string } | null> {
    return this.prisma.horizonAccountCursor.findUnique({
      where: { network_account: { network, account } },
      select: { pagingToken: true },
    });
  }

  private async saveCursor(
    network: StellarNetwork,
    account: string,
    pagingToken: string,
  ): Promise<void> {
    await this.prisma.horizonAccountCursor.upsert({
      where: { network_account: { network, account } },
      create: { network, account, pagingToken },
      update: { pagingToken },
    });
  }

  /**
   * A payment to the right destination, in the intent's asset, for the exact
   * amount. The amount check is skipped for open intents (no fixed amount).
   */
  private paymentMatches(
    intent: PaymentIntent,
    op: Horizon.ServerApi.OperationRecord,
  ): boolean {
    if (op.type !== 'payment') {
      return false;
    }
    const p = op;

    if (p.to !== intent.destination) {
      return false;
    }

    // Asset must match: native, or exact code + issuer.
    if (intent.asset === 'native') {
      if (p.asset_type !== 'native') return false;
    } else if (
      p.asset_code !== intent.asset ||
      p.asset_issuer !== intent.assetIssuer
    ) {
      return false;
    }

    // Exact amount only when the intent fixed one.
    if (intent.amount != null && Number(p.amount) !== Number(intent.amount)) {
      return false;
    }

    return true;
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
