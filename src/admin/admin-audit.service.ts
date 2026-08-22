import { Injectable } from '@nestjs/common';
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

/**
 * Append-only platform-admin audit trail (issue #34).
 * There is intentionally no delete/update API — rows are immutable history.
 */
@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAdminAuditInput) {
    return this.prisma.adminAuditLog.create({
      data: {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadata: input.metadata ?? undefined,
      },
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
