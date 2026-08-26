/**
 * Exponential backoff with full jitter for webhook retries.
 *
 * delay = min(maxBackoffMs, baseMs * 2 ** attempts) * (0.5 + random/2)
 *
 * The random factor spreads the cluster so a fleet of failed deliveries does
 * not retry in lock-step when an integrator comes back.
 */
export function computeWebhookBackoffMs(
  attempts: number,
  baseMs: number,
  maxBackoffMs: number,
  random: () => number = Math.random,
): number {
  const exponential = baseMs * 2 ** Math.max(0, attempts);
  const capped = Math.min(maxBackoffMs, exponential);
  const jittered = capped * (0.5 + random() / 2);
  return Math.floor(jittered);
}
