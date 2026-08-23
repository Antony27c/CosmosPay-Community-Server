import { Module } from '@nestjs/common';
import { LiquidityPoolsModule } from '../liquidity-pools/liquidity-pools.module';
import { SwapsModule } from '../swaps/swaps.module';
import { SettlementObserverService } from './settlement-observer.service';

/**
 * Hosts the background settlement observer that reconciles swaps and liquidity
 * pool operations against Horizon. Prisma and Stellar are global; it imports
 * the domain services so observer and submit share the same finalize+emit path.
 */
@Module({
  imports: [LiquidityPoolsModule, SwapsModule],
  providers: [SettlementObserverService],
})
export class ObserverModule {}
