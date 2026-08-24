import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentConsumer } from '../common/decorators/current-consumer.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { CreateSwapDto } from './dto/create-swap.dto';
import { QuerySwapsDto } from './dto/query-swaps.dto';
import { QuoteSwapDto } from './dto/quote-swap.dto';
import { SubmitSwapDto } from './dto/submit-swap.dto';
import {
  SwapEntity,
  SwapListEntity,
  SwapQuoteEntity,
  SwapSubmitResultEntity,
} from './entities/swap.entity';
import { SwapsService } from './swaps.service';

// URI versioning => /v1/swaps
@ApiTags('swaps')
@Controller({ path: 'swaps', version: '1' })
export class SwapsController {
  constructor(private readonly swaps: SwapsService) {}

  @Post('quote')
  @RequirePermissions('swaps:read')
  @ApiOperation({
    summary:
      'Quote a swap (Horizon strict-send path search + fee/slippage); persists nothing',
  })
  @ApiOkResponse({ type: SwapQuoteEntity })
  quote(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: QuoteSwapDto,
  ) {
    return this.swaps.quote(consumer, dto);
  }

  @Post()
  @RequirePermissions('swaps:write')
  @ApiOperation({
    summary:
      'Create a swap → unsigned XDR + SEP-7 tx URI + QR for the wallet to sign',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional idempotency key. Retries with the same key return the existing ' +
      'swap (same id and txHash). Takes precedence over body.idempotencyKey.',
    example: 'swap-retry-2026-08-23-001',
  })
  @ApiCreatedResponse({ type: SwapEntity })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateSwapDto,
    // Read via @Req (not @Headers) so Swagger does not auto-emit a second
    // required `idempotency-key` parameter alongside @ApiHeader.
    @Req() req: Request,
  ) {
    return this.swaps.create(
      consumer,
      dto,
      headerValue(req, 'idempotency-key'),
    );
  }

  @Get()
  @RequirePermissions('swaps:read')
  @ApiOperation({ summary: "List the consumer's swaps" })
  @ApiOkResponse({ type: SwapListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QuerySwapsDto,
  ) {
    return this.swaps.findAll(consumer, query);
  }

  @Get(':id')
  @RequirePermissions('swaps:read')
  @ApiOperation({ summary: 'Get a swap by id' })
  @ApiOkResponse({ type: SwapEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.swaps.findOne(consumer, id);
  }

  @Post(':id/submit')
  @RequirePermissions('swaps:write')
  @ApiOperation({
    summary:
      'Relay the signed swap transaction to the network (hash-checked); finalizes status',
  })
  @ApiOkResponse({ type: SwapSubmitResultEntity })
  submit(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: SubmitSwapDto,
  ) {
    return this.swaps.submit(consumer, id, dto.signedXdr);
  }
}

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}
