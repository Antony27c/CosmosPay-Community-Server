import { Module } from '@nestjs/common';
import { SwapsController } from './swaps.controller';
import { SwapsService } from './swaps.service';

@Module({
  controllers: [SwapsController],
  providers: [SwapsService],
  exports: [SwapsService],
})
export class SwapsModule {}
