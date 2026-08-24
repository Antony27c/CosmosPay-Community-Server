/**
 * Expiry gate for the settlement observer. A row may only move to EXPIRED after
 * its timebounds (plus a configured grace) have lapsed *and* Horizon has
 * returned 404 a streak of times — never because Horizon was unreachable.
 */

/** Consecutive `not_found` lookups required after expiresAt + grace. */
export const EXPIRY_NOT_FOUND_STREAK = 3;

/**
 * Next `notFoundStreak` value after one Horizon lookup. The streak only grows
 * on `not_found` once we are past `expiresAt + graceMs`; any other settlement
 * (including transient `unknown`) resets it to 0.
 */
export function nextExpiryStreak(
  settlement: 'succeeded' | 'failed' | 'not_found' | 'unknown',
  expiresAt: Date | null | undefined,
  now: Date,
  graceMs: number,
  current: number,
): number {
  if (settlement !== 'not_found' || !expiresAt) return 0;
  if (now.getTime() < expiresAt.getTime() + graceMs) return 0;
  return current + 1;
}

/** True once the post-grace `not_found` streak has reached K. */
export function shouldMarkExpired(streak: number): boolean {
  return streak >= EXPIRY_NOT_FOUND_STREAK;
}
