import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { AdminPrincipal } from './admin-auth';
import { AdminAuditService } from './admin-audit.service';
import { AdminService } from './admin.service';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import { RequireAdminRole } from '../common/decorators/require-admin-role.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { ApproveReceiverDto } from '../kyc/receivers/dto/approve-receiver.dto';
import { EnableReceiverDto } from '../kyc/receivers/dto/enable-receiver.dto';
import { RequestTosDto } from '../kyc/receivers/dto/request-tos.dto';
import { SetAccessDto } from '../kyc/receivers/dto/set-access.dto';
import { resolveTosCooldownMs } from '../kyc/receivers/receivers.service';

/**
 * Platform-admin (owner) endpoints: a global, cross-consumer view of everything in the
 * service. Gated by {@link AdminGuard} — real Bearer credentials from
 * `ADMIN_API_CREDENTIALS` with explicit read/write roles (issue #34). Not part of the
 * public API surface, so excluded from the OpenAPI spec.
 */
@ApiExcludeController()
@UseGuards(AdminGuard)
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get('summary')
  summary(@Query('network') network?: string) {
    return this.admin.summary(network);
  }

  @Get('consumers')
  consumers(@Query('take') take?: string, @Query('skip') skip?: string) {
    return this.admin.consumers(toNum(take), toNum(skip));
  }

  @Get('payment-intents')
  paymentIntents(
    @Query('consumer') consumer?: string,
    @Query('network') network?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.paymentIntents({
      consumer,
      network,
      status,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('swaps')
  swaps(
    @Query('consumer') consumer?: string,
    @Query('network') network?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.swaps({
      consumer,
      network,
      status,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('customers')
  customers(
    @Query('consumer') consumer?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.customers({
      consumer,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('products')
  products(
    @Query('consumer') consumer?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.products({
      consumer,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('receivers')
  receivers(
    @Query('consumer') consumer?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.receivers({
      consumer,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('payins')
  payins(
    @Query('consumer') consumer?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.payins({
      consumer,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('payouts')
  payouts(
    @Query('consumer') consumer?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.payouts({
      consumer,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  /**
   * Consultable, append-only admin audit trail. Intentionally read-only —
   * there is no DELETE/PATCH route for these rows (issue #34).
   */
  @Get('audit-logs')
  auditLogs(@Query('take') take?: string, @Query('skip') skip?: string) {
    return this.audit.list({ take: toNum(take), skip: toNum(skip) });
  }

  @Patch('receivers/:id/access')
  @RequireAdminRole('write')
  async setReceiverAccess(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: SetAccessDto,
  ) {
    const result = await this.admin.setReceiverAccess(id, dto.disabled);
    await this.audit.record({
      actor,
      action: 'receivers.setAccess',
      resourceType: 'receiver',
      resourceId: id,
      metadata: { disabled: dto.disabled },
    });
    return result;
  }

  @Post('receivers/:id/approve')
  @RequireAdminRole('write')
  async approveReceiver(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: ApproveReceiverDto,
  ) {
    const result = await this.admin.approveReceiver(id, dto.redirect_url);
    await this.audit.record({
      actor,
      action: 'receivers.approve',
      resourceType: 'receiver',
      resourceId: id,
      metadata: { redirect_url: dto.redirect_url },
    });
    return result;
  }

  @Post('receivers/:id/enable')
  @RequireAdminRole('write')
  async enableReceiver(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: EnableReceiverDto,
  ) {
    const result = await this.admin.enableReceiver(id, dto.tos_id);
    await this.audit.record({
      actor,
      action: 'receivers.enable',
      resourceType: 'receiver',
      resourceId: id,
      metadata: { tos_id: dto.tos_id },
    });
    return result;
  }

  @Post('receivers/:id/tos')
  @RequireAdminRole('write')
  async requestReceiverTos(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: RequestTosDto,
    @Headers('x-cosmos-internal') internal?: string,
    @Headers('x-cosmos-tos-cooldown-ms') cooldown?: string,
  ) {
    const result = await this.admin.requestReceiverTos(
      id,
      dto,
      resolveTosCooldownMs(internal, cooldown),
    );
    await this.audit.record({
      actor,
      action: 'receivers.requestTos',
      resourceType: 'receiver',
      resourceId: id,
      metadata: {
        channel: dto.channel ?? 'code',
        redirect_url: dto.redirect_url,
      },
    });
    return result;
  }
}

function toNum(v?: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
