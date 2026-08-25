import { createHmac } from 'node:crypto';

/**
 * Stripe-style signature over `${timestamp}.${body}` with the endpoint secret(s).
 * Integrators recompute this and constant-time compare against the
 * `X-Cosmos-Signature` header to authenticate the payload.
 *
 *   header value: `t=<unixSeconds>,v1=<hexHmacSha256>[,v1=<hexHmacSha256>]`
 *
 * During a secret-rotation grace window the header carries one `v1=` token per
 * active secret (current, then previous) so a handler still verifying the old
 * secret keeps accepting deliveries.
 */
export function buildSignatureHeader(
  secrets: readonly string[],
  body: string,
  timestampSeconds: number,
): string {
  const tokens = secrets
    .filter((secret) => secret.length > 0)
    .map((secret) => `v1=${signPayload(secret, body, timestampSeconds)}`);
  return `t=${timestampSeconds},${tokens.join(',')}`;
}

/**
 * Secrets that must sign an outbound delivery right now: the current secret
 * always, plus `previousSecret` while its grace window is still open.
 * An endpoint that has never rotated (previousSecret is null) yields a
 * single-element list, so the header stays `t=<ts>,v1=<sig>`.
 */
export function signingSecretsFor(
  endpoint: {
    secret: string;
    previousSecret?: string | null;
    previousSecretExpiresAt?: Date | null;
  },
  now: Date = new Date(),
): string[] {
  const secrets = [endpoint.secret];
  if (
    endpoint.previousSecret &&
    endpoint.previousSecretExpiresAt &&
    endpoint.previousSecretExpiresAt.getTime() > now.getTime()
  ) {
    secrets.push(endpoint.previousSecret);
  }
  return secrets;
}

export function signPayload(
  secret: string,
  body: string,
  timestampSeconds: number,
): string {
  return createHmac('sha256', secret)
    .update(`${timestampSeconds}.${body}`)
    .digest('hex');
}
