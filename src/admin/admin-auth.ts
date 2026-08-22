import { timingSafeEqual } from 'node:crypto';

/**
 * Executable spec for platform-admin auth (issue #34).
 *
 * Replaces the legacy plaintext `X-Cosmos-Admin: 1` marker with a real
 * shared-secret credential and an explicit read/write role. Deny-by-default:
 * no configured credentials ⇒ no admin access.
 */
export const ADMIN_ROLES = ['read', 'write'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface AdminCredential {
  /** Stable actor id recorded on audit rows. */
  id: string;
  /** Shared secret presented as `Authorization: Bearer <secret>`. */
  secret: string;
  role: AdminRole;
}

export interface AdminPrincipal {
  id: string;
  role: AdminRole;
}

/** Role lattice: write implies read. */
export function roleSatisfies(have: AdminRole, need: AdminRole): boolean {
  if (need === 'read') return have === 'read' || have === 'write';
  return have === 'write';
}

/**
 * Parse `ADMIN_API_CREDENTIALS` JSON.
 * Expected shape: [{"id":"viewer","secret":"…","role":"read"}, …]
 * Invalid / empty input ⇒ [] (fail closed).
 */
export function parseAdminCredentials(
  raw: string | undefined,
): AdminCredential[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: AdminCredential[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id.trim() : '';
      const secret = typeof rec.secret === 'string' ? rec.secret : '';
      const role = rec.role;
      if (!id || !secret) continue;
      if (role !== 'read' && role !== 'write') continue;
      // Reject trivially short secrets so "1" can never be a valid credential.
      if (secret.length < 16) continue;
      out.push({ id, secret, role });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Constant-time credential lookup. Returns the matching principal or null.
 * Pure — no Nest / no request object.
 */
export function verifyAdminBearer(
  authorizationHeader: string | undefined,
  credentials: readonly AdminCredential[],
): AdminPrincipal | null {
  const token = extractBearer(authorizationHeader);
  if (!token || credentials.length === 0) return null;

  let matched: AdminPrincipal | null = null;
  for (const cred of credentials) {
    if (timingSafeEqualString(token, cred.secret)) {
      matched ??= { id: cred.id, role: cred.role };
    }
  }
  return matched;
}

export function extractBearer(
  authorizationHeader: string | undefined,
): string | null {
  if (!authorizationHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return m?.[1]?.trim() ? m[1].trim() : null;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    const padded = Buffer.alloc(ab.length);
    bb.copy(padded);
    timingSafeEqual(ab, padded);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
