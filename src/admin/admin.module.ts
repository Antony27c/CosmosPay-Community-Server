import { Module } from '@nestjs/common';
import { KycModule } from '../kyc/kyc.module';
import { AdminAuditService } from './admin-audit.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from '../common/guards/admin.guard';

/**
 * Imports KycModule so the admin (owner) endpoints can reuse ReceiversService's
 * approve/enable logic across ANY consumer (the global fiat review tools).
 * AdminGuard is provided so Nest can inject ConfigService + Reflector into it.
 */
@Module({
  imports: [KycModule],
  controllers: [AdminController],
  providers: [AdminService, AdminAuditService, AdminGuard],
})
export class AdminModule {}
