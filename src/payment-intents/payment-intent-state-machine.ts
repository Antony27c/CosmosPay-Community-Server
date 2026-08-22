import {
  PAYMENT_INTENT_TRANSITIONS,
  SUCCESS_REQUIRES_TX_HASH,
  TERMINAL_STATUSES,
  type PaymentIntentStatusName,
} from './payment-intent-transitions';

export class InvalidPaymentIntentTransitionError extends Error {
  readonly code = 'INVALID_PAYMENT_INTENT_TRANSITION' as const;

  constructor(
    readonly from: PaymentIntentStatusName,
    readonly to: PaymentIntentStatusName,
    readonly reason: string,
  ) {
    super(
      `Invalid payment intent transition ${from} → ${to}: ${reason}`,
    );
    this.name = 'InvalidPaymentIntentTransitionError';
  }
}

export interface TransitionEvidence {
  /** On-chain Stellar transaction hash. Required when targeting SUCCEEDED. */
  txHash?: string | null;
}

/**
 * Returns whether `from → to` is declared in the transition graph.
 * Pure predicate — does not enforce evidence rules.
 */
export function canTransition(
  from: PaymentIntentStatusName,
  to: PaymentIntentStatusName,
): boolean {
  return PAYMENT_INTENT_TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(
  status: PaymentIntentStatusName,
): boolean {
  return (TERMINAL_STATUSES as readonly PaymentIntentStatusName[]).includes(
    status,
  );
}

/**
 * Asserts that a transition is allowed by the graph and by evidence rules.
 * Throws {@link InvalidPaymentIntentTransitionError} on any violation.
 */
export function assertTransition(
  from: PaymentIntentStatusName,
  to: PaymentIntentStatusName,
  evidence: TransitionEvidence = {},
): void {
  if (!canTransition(from, to)) {
    const reason = isTerminalStatus(from)
      ? `status ${from} is terminal and cannot be abandoned`
      : `transition is not declared in the payment intent graph`;
    throw new InvalidPaymentIntentTransitionError(from, to, reason);
  }

  if (
    SUCCESS_REQUIRES_TX_HASH &&
    to === 'SUCCEEDED' &&
    !hasTxHash(evidence.txHash)
  ) {
    throw new InvalidPaymentIntentTransitionError(
      from,
      to,
      'SUCCEEDED requires a non-empty on-chain txHash',
    );
  }
}

function hasTxHash(txHash: string | null | undefined): boolean {
  return typeof txHash === 'string' && txHash.trim().length > 0;
}
