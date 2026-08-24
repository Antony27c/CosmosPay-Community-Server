/**
 * True for a Prisma unique-constraint violation (P2002).
 * Shared by payment intents, swaps, and webhook terminal dedup.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002';
}

/** Field names Prisma reports on a P2002 (`meta.target`), when present. */
export function uniqueViolationTarget(err: unknown): string[] {
  const target = (err as { meta?: { target?: unknown } })?.meta?.target;
  if (Array.isArray(target)) {
    return target.filter((t): t is string => typeof t === 'string');
  }
  if (typeof target === 'string') return [target];
  return [];
}
