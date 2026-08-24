import { Injectable } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { horizonHttpStatus, StellarService } from '../stellar/stellar.service';
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
 * Confirms that an on-chain Stellar transaction actually fulfills a payment
 * intent: it must be successful, contain a payment to the intent's destination
 * in the intent's asset for the exact amount, and the transaction memo must
 * match. Each intent carries its own `network` (derived from the API key type),
 * so all Horizon calls target that network. Used both by the manual `validate`
 * endpoint and the permanent observer, so the rule lives in one place.
 */
@Injectable()
export class StellarVerifierService {
  constructor(private readonly stellar: StellarService) {}

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
   * Scans recent payments to the intent's destination and returns the hash of
   * the first transaction that fully matches (used by the observer when no hash
   * was reported by the integrator).
   */
  async findMatchingPayment(
    intent: PaymentIntent,
    limit = 50,
  ): Promise<VerificationResult> {
    const network = this.network(intent);
    let page: Horizon.ServerApi.CollectionPage<Horizon.ServerApi.OperationRecord>;
    try {
      page = await this.stellar.call(network, (server) =>
        server
          .payments()
          .forAccount(intent.destination)
          .order('desc')
          .limit(limit)
          .call(),
      );
    } catch (err) {
      if (horizonHttpStatus(err) === 404) {
        return { valid: false, reason: 'Destination account not found' };
      }
      throw err;
    }

    for (const op of page.records) {
      if (!this.paymentMatches(intent, op)) {
        continue;
      }
      // Confirm success + memo on the owning transaction.
      const tx = await this.stellar.call(network, (server) =>
        server.transactions().transaction(op.transaction_hash).call(),
      );
      if (!tx.successful) {
        continue;
      }
      if (!this.memoMatches(intent, tx.memo_type, tx.memo).ok) {
        continue;
      }
      const payer = (op as Horizon.ServerApi.PaymentOperationRecord).from;
      return { valid: true, txHash: op.transaction_hash, payer };
    }

    return { valid: false, reason: 'No matching payment found yet' };
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
