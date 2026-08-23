import { BadRequestException, Logger } from '@nestjs/common';

const log = new Logger('RedirectUrlWhitelist');

/**
 * Per-consumer allow-list of redirect_url hostnames for the KYC ToS flow
 * (issue #33). Env shape:
 * `KYC_REDIRECT_URL_WHITELIST={"cosmos_acme":["acme.com","app.acme.com"]}`
 */
export type RedirectUrlWhitelist = Readonly<Record<string, readonly string[]>>;

/**
 * Parse `KYC_REDIRECT_URL_WHITELIST` JSON. Invalid / empty input ⇒ {}
 * (callers fail closed per consumer when the list is missing/empty).
 */
export function parseRedirectUrlWhitelist(
  raw: string | undefined,
): Record<string, string[]> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(
      'KYC_REDIRECT_URL_WHITELIST is not valid JSON; treating as empty (fail closed per consumer)',
    );
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn(
      'KYC_REDIRECT_URL_WHITELIST must be a JSON object; treating as empty (fail closed per consumer)',
    );
    return {};
  }

  const out: Record<string, string[]> = {};
  for (const [consumer, domains] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const key = consumer.trim();
    if (!key || !Array.isArray(domains)) continue;
    const cleaned = domains
      .filter((d): d is string => typeof d === 'string')
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0);
    out[key] = cleaned;
  }
  return out;
}

/** Label-safe hostname match: exact or subdomain of an allowed domain. */
export function hostnameAllowed(
  hostname: string,
  allowedDomains: readonly string[],
): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  for (const domain of allowedDomains) {
    const allowed = domain.trim().toLowerCase();
    if (!allowed) continue;
    if (host === allowed || host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

/**
 * Ensures `redirectUrl` targets a hostname on the consumer's allow-list.
 * Throws {@link BadRequestException} (HTTP 400) on failure.
 */
export function assertRedirectAllowed(
  consumerUsername: string,
  redirectUrl: string,
  whitelist: RedirectUrlWhitelist,
): void {
  const allowed = whitelist[consumerUsername] ?? [];
  if (allowed.length === 0) {
    throw new BadRequestException(
      'no redirect_url domains are configured for this consumer',
    );
  }

  let hostname: string;
  try {
    hostname = new URL(redirectUrl).hostname;
  } catch {
    throw new BadRequestException(
      'redirect_url must be a valid https URL without embedded credentials',
    );
  }

  if (!hostnameAllowed(hostname, allowed)) {
    throw new BadRequestException(
      `redirect_url hostname '${hostname}' is not allowed for this consumer`,
    );
  }
}
