/**
 * Shared outbound HTTP helpers for webhook delivery.
 * Redirects are never followed by the caller (`redirect: 'manual'`).
 * Connect and read budgets come from env and are applied via AbortSignal.
 */
export type WebhookHttpLimits = {
  connectTimeoutMs: number;
  readTimeoutMs: number;
  maxResponseBytes: number;
};

/** Combined abort budget: connect phase + read phase. */
export function webhookAbortSignal(
  limits: Pick<WebhookHttpLimits, 'connectTimeoutMs' | 'readTimeoutMs'>,
): AbortSignal {
  return AbortSignal.timeout(limits.connectTimeoutMs + limits.readTimeoutMs);
}

/** Drain the response body up to `maxBytes`, aborting if the limit is exceeded. */
export async function consumeResponseBody(
  res: Response,
  maxBytes: number,
): Promise<void> {
  if (!res.body) {
    return;
  }

  const reader = res.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(
          `Webhook response exceeded size limit of ${maxBytes} bytes`,
        );
      }
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // ignore cancel errors
    }
    throw err;
  }
}
