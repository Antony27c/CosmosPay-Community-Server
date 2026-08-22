import {
  PAYMENT_INTENT_STATUSES,
  PAYMENT_INTENT_TRANSITIONS,
  SUCCESS_REQUIRES_TX_HASH,
  TERMINAL_STATUSES,
  type PaymentIntentStatusName,
} from './payment-intent-transitions';
import {
  assertTransition,
  canTransition,
  InvalidPaymentIntentTransitionError,
  isTerminalStatus,
} from './payment-intent-state-machine';

describe('PaymentIntent state machine (spec / graph)', () => {
  it('declares every Prisma status exactly once in the graph', () => {
    expect(Object.keys(PAYMENT_INTENT_TRANSITIONS).sort()).toEqual(
      [...PAYMENT_INTENT_STATUSES].sort(),
    );
  });

  it('marks SUCCEEDED, FAILED, CANCELLED, EXPIRED as terminal', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminalStatus(status)).toBe(true);
      expect(PAYMENT_INTENT_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('requires on-chain evidence to reach SUCCEEDED', () => {
    expect(SUCCESS_REQUIRES_TX_HASH).toBe(true);
  });

  describe('canTransition — full adjacency matrix', () => {
    const cases: Array<{
      from: PaymentIntentStatusName;
      to: PaymentIntentStatusName;
      allowed: boolean;
    }> = [];

    for (const from of PAYMENT_INTENT_STATUSES) {
      for (const to of PAYMENT_INTENT_STATUSES) {
        cases.push({
          from,
          to,
          allowed: PAYMENT_INTENT_TRANSITIONS[from].includes(to),
        });
      }
    }

    it.each(cases)(
      '$from → $to (allowed=$allowed)',
      ({ from, to, allowed }) => {
        expect(canTransition(from, to)).toBe(allowed);
      },
    );
  });

  describe('assertTransition — valid edges', () => {
    const valid: Array<{
      from: PaymentIntentStatusName;
      to: PaymentIntentStatusName;
      evidence?: { txHash?: string };
    }> = [];

    for (const from of PAYMENT_INTENT_STATUSES) {
      for (const to of PAYMENT_INTENT_TRANSITIONS[from]) {
        valid.push({
          from,
          to,
          evidence:
            to === 'SUCCEEDED'
              ? { txHash: 'a'.repeat(64) }
              : undefined,
        });
      }
    }

    it.each(valid)(
      'allows $from → $to',
      ({ from, to, evidence }) => {
        expect(() => assertTransition(from, to, evidence)).not.toThrow();
      },
    );
  });

  describe('assertTransition — invalid edges', () => {
    const invalid: Array<{
      from: PaymentIntentStatusName;
      to: PaymentIntentStatusName;
    }> = [];

    for (const from of PAYMENT_INTENT_STATUSES) {
      for (const to of PAYMENT_INTENT_STATUSES) {
        if (!PAYMENT_INTENT_TRANSITIONS[from].includes(to)) {
          invalid.push({ from, to });
        }
      }
    }

    it.each(invalid)(
      'rejects undeclared $from → $to with an explicit error',
      ({ from, to }) => {
        expect(() =>
          assertTransition(from, to, {
            txHash: to === 'SUCCEEDED' ? 'a'.repeat(64) : undefined,
          }),
        ).toThrow(InvalidPaymentIntentTransitionError);

        try {
          assertTransition(from, to, {
            txHash: to === 'SUCCEEDED' ? 'a'.repeat(64) : undefined,
          });
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidPaymentIntentTransitionError);
          const e = err as InvalidPaymentIntentTransitionError;
          expect(e.code).toBe('INVALID_PAYMENT_INTENT_TRANSITION');
          expect(e.from).toBe(from);
          expect(e.to).toBe(to);
          expect(e.message).toMatch(/Invalid payment intent transition/);
        }
      },
    );
  });

  describe('assertTransition — terminal immutability', () => {
    it.each(TERMINAL_STATUSES)(
      'cannot leave terminal status %s',
      (from) => {
        for (const to of PAYMENT_INTENT_STATUSES) {
          expect(() =>
            assertTransition(from, to, {
              txHash: 'b'.repeat(64),
            }),
          ).toThrow(InvalidPaymentIntentTransitionError);
        }
      },
    );
  });

  describe('assertTransition — on-chain evidence for SUCCEEDED', () => {
    it.each(['PENDING', 'SUBMITTED'] as const)(
      'rejects %s → SUCCEEDED without txHash',
      (from) => {
        expect(() => assertTransition(from, 'SUCCEEDED')).toThrow(
          InvalidPaymentIntentTransitionError,
        );
        expect(() =>
          assertTransition(from, 'SUCCEEDED', { txHash: null }),
        ).toThrow(InvalidPaymentIntentTransitionError);
        expect(() =>
          assertTransition(from, 'SUCCEEDED', { txHash: '' }),
        ).toThrow(InvalidPaymentIntentTransitionError);
        expect(() =>
          assertTransition(from, 'SUCCEEDED', { txHash: '   ' }),
        ).toThrow(InvalidPaymentIntentTransitionError);
      },
    );

    it.each(['PENDING', 'SUBMITTED'] as const)(
      'allows %s → SUCCEEDED with a non-empty txHash',
      (from) => {
        expect(() =>
          assertTransition(from, 'SUCCEEDED', {
            txHash: 'c'.repeat(64),
          }),
        ).not.toThrow();
      },
    );
  });
});
