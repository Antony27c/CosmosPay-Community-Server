import { Module } from '@nestjs/common';
import { LiquidityPoolsController } from './liquidity-pools.controller';
import { LiquidityPoolsService } from './liquidity-pools.service';

@Module({
  controllers: [LiquidityPoolsController],
  providers: [LiquidityPoolsService],
  exports: [LiquidityPoolsService],
})
export class LiquidityPoolsModule {}
