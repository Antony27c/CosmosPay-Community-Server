import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { AdminPrincipal } from './admin-auth';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordAdminAuditInput {
  actor: AdminPrincipal;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Prisma.InputJsonValue;
}

export type AdminAuditData = {
  actorId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Prisma.InputJsonValue;
};

/** Build the Prisma create payload for an audit row from a principal + action. */
export function toAuditData(
  actor: AdminPrincipal,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata?: Prisma.InputJsonValue,
): AdminAuditData {
  return {
    actorId: actor.id,
    actorRole: actor.role,
    action,
    resourceType,
    resourceId,
    metadata,
  };
}

/** Insert an audit row using an interactive-transaction client. */
export function recordAuditInTransaction(
  tx: Prisma.TransactionClient,
  data: AdminAuditData,
) {
  return tx.adminAuditLog.create({ data });
}

/**
 * Append-only platform-admin audit trail (issue #34).
 * There is intentionally no delete/update API — rows are immutable history.
 * Prefer {@link recordAuditInTransaction} inside the same `$transaction` as the
 * mutation it describes so the two cannot diverge.
 */
@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Standalone insert (prefer {@link recordAuditInTransaction} for mutations). */
  async record(input: RecordAdminAuditInput) {
    return this.prisma.adminAuditLog.create({
      data: toAuditData(
        input.actor,
        input.action,
        input.resourceType,
        input.resourceId,
        input.metadata,
      ),
    });
  }

  async list(opts: { take?: number; skip?: number } = {}) {
    const take = !opts.take || opts.take < 1 ? 50 : Math.min(opts.take, 200);
    const skip = !opts.skip || opts.skip < 0 ? 0 : opts.skip;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.adminAuditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.adminAuditLog.count(),
    ]);
    return { data, total, take, skip };
  }
}
