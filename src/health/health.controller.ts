import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { StellarHealthIndicator } from './stellar-health.indicator';

/**
 * Liveness/readiness endpoints. Marked @Public() because the orchestrator
 * (k8s/docker) probes them directly, not through APISIX.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly stellarHealth: StellarHealthIndicator,
  ) {}

  @Get('liveness')
  @Public()
  @ApiOperation({ summary: 'Liveness probe' })
  liveness() {
    return { status: 'ok' };
  }

  @Get('readiness')
  @Public()
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe (database + Horizon per configured network)',
  })
  readiness() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      ...this.stellarHealth.checks(),
    ]);
  }
}
