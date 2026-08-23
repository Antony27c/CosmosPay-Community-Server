import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { LiquidityPoolsController } from './liquidity-pools.controller';
import { LiquidityPoolsService } from './liquidity-pools.service';

@Module({
  imports: [WebhooksModule],
  controllers: [LiquidityPoolsController],
  providers: [LiquidityPoolsService],
  exports: [LiquidityPoolsService],
})
export class LiquidityPoolsModule {}
