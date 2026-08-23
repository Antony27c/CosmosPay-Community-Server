import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { SwapsController } from './swaps.controller';
import { SwapsService } from './swaps.service';

@Module({
  imports: [WebhooksModule],
  controllers: [SwapsController],
  providers: [SwapsService],
  exports: [SwapsService],
})
export class SwapsModule {}
