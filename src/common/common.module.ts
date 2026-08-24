import { Module } from '@nestjs/common';
import { RequestLogRetentionService } from './services/request-log-retention.service';

/**
 * Hosts background jobs that belong to common infra (not a domain module).
 * PrismaService and ConfigService are global.
 */
@Module({
  providers: [RequestLogRetentionService],
})
export class CommonModule {}
