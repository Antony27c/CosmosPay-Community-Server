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
import { StellarService } from '../stellar/stellar.service';

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
    private readonly stellar: StellarService,
  ) {}

  @Get('summary')
  summary(@Query('network') network?: string) {
    return this.admin.summary(network);
  }

  /**
   * In-memory reconciler + Horizon error counters (issue #10). Process-local:
   * resets on deploy. Complements the structured observer cycle log.
   */
  @Get('observer-metrics')
  observerMetrics() {
    return this.stellar.metrics();
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
  setReceiverAccess(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: SetAccessDto,
  ) {
    return this.admin.setReceiverAccess(id, dto.disabled, actor);
  }

  @Post('receivers/:id/approve')
  @RequireAdminRole('write')
  approveReceiver(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: ApproveReceiverDto,
  ) {
    return this.admin.approveReceiver(id, dto.redirect_url, actor);
  }

  @Post('receivers/:id/enable')
  @RequireAdminRole('write')
  enableReceiver(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: EnableReceiverDto,
  ) {
    return this.admin.enableReceiver(id, dto.tos_id, actor);
  }

  @Post('receivers/:id/tos')
  @RequireAdminRole('write')
  requestReceiverTos(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: RequestTosDto,
    @Headers('x-cosmos-internal') internal?: string,
    @Headers('x-cosmos-tos-cooldown-ms') cooldown?: string,
  ) {
    return this.admin.requestReceiverTos(
      id,
      dto,
      actor,
      resolveTosCooldownMs(internal, cooldown),
    );
  }
}

function toNum(v?: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
