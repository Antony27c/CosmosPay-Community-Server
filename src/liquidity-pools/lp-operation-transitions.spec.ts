import {
  LP_CAN_SUBMIT_STATUSES,
  LP_CAN_SUCCEED_STATUSES,
  LP_IN_FLIGHT_STATUSES,
  LP_LIQUIDATED_STATUS,
  LP_OPERATION_STATUSES,
  LP_OPERATION_TRANSITIONS,
  canTransitionLp,
  isLpLiquidated,
  type LpOperationStatus,
} from './lp-operation-transitions';

describe('LP operation state machine (issue #32)', () => {
  it('declares every SwapStatus exactly once in the graph', () => {
    expect(Object.keys(LP_OPERATION_TRANSITIONS).sort()).toEqual(
      [...LP_OPERATION_STATUSES].sort(),
    );
  });

  it('treats SUCCEEDED as liquidated with no outbound edges', () => {
    expect(isLpLiquidated(LP_LIQUIDATED_STATUS)).toBe(true);
    expect(LP_OPERATION_TRANSITIONS.SUCCEEDED).toEqual([]);
    expect(LP_IN_FLIGHT_STATUSES).not.toContain('SUCCEEDED');
    expect(LP_CAN_SUBMIT_STATUSES).not.toContain('SUCCEEDED');
  });

  it('never allows FAILED or EXPIRED from a liquidated operation', () => {
    expect(canTransitionLp('SUCCEEDED', 'FAILED')).toBe(false);
    expect(canTransitionLp('SUCCEEDED', 'EXPIRED')).toBe(false);
    expect(canTransitionLp('SUCCEEDED', 'SUBMITTED')).toBe(false);
    expect(canTransitionLp('SUCCEEDED', 'PENDING')).toBe(false);
  });

  it('lets the observer rescue a false EXPIRED to SUCCEEDED or FAILED', () => {
    expect(canTransitionLp('EXPIRED', 'SUCCEEDED')).toBe(true);
    expect(canTransitionLp('EXPIRED', 'FAILED')).toBe(true);
    expect(LP_CAN_SUCCEED_STATUSES).toEqual(
      expect.arrayContaining(['PENDING', 'SUBMITTED', 'FAILED', 'EXPIRED']),
    );
  });

  it('lets on-chain success heal a false FAILED, but not the reverse', () => {
    expect(canTransitionLp('FAILED', 'SUCCEEDED')).toBe(true);
    expect(LP_CAN_SUCCEED_STATUSES).toEqual(
      expect.arrayContaining(['PENDING', 'SUBMITTED', 'FAILED']),
    );
    expect(canTransitionLp('SUCCEEDED', 'FAILED')).toBe(false);
  });

  describe('canTransitionLp — adjacency matrix', () => {
    const cases: Array<{
      from: LpOperationStatus;
      to: LpOperationStatus;
      allowed: boolean;
    }> = [];
    for (const from of LP_OPERATION_STATUSES) {
      for (const to of LP_OPERATION_STATUSES) {
        cases.push({
          from,
          to,
          allowed: LP_OPERATION_TRANSITIONS[from].includes(to),
        });
      }
    }

    it.each(cases)(
      '$from → $to (allowed=$allowed)',
      ({ from, to, allowed }) => {
        expect(canTransitionLp(from, to)).toBe(allowed);
      },
    );
  });
});
