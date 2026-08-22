import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '../common/decorators/current-consumer.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { CreateTxPaymentIntentDto } from './dto/create-tx-payment-intent.dto';
import { CreatePayPaymentIntentDto } from './dto/create-pay-payment-intent.dto';
import { QueryPaymentIntentsDto } from './dto/query-payment-intents.dto';
import { UpdatePaymentIntentDto } from './dto/update-payment-intent.dto';
import { ValidatePaymentIntentDto } from './dto/validate-payment-intent.dto';
import {
  DeletedEntity,
  PaymentIntentEntity,
  PaymentIntentListEntity,
  PaymentIntentTransitionListEntity,
  PayPaymentIntentEntity,
  TxPaymentIntentEntity,
  ValidationOutcomeEntity,
} from './entities/payment-intent.entity';
import { PaymentIntentsService } from './payment-intents.service';

// URI versioning => /v1/payment-intents
@ApiTags('payment-intents')
@Controller({ path: 'payment-intents', version: '1' })
export class PaymentIntentsController {
  constructor(private readonly paymentIntents: PaymentIntentsService) {}

  @Post('tx')
  @RequirePermissions('payments:write')
  @ApiOperation({
    summary:
      'Create a SEP-7 `tx` intent (source known → unsigned XDR + tx URI + QR)',
  })
  @ApiCreatedResponse({ type: TxPaymentIntentEntity })
  createTx(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateTxPaymentIntentDto,
  ) {
    return this.paymentIntents.createTx(consumer, dto);
  }

  @Post('pay')
  @RequirePermissions('payments:write')
  @ApiOperation({
    summary: 'Create a SEP-7 `pay` intent (no source → pay URI + QR, no XDR)',
  })
  @ApiCreatedResponse({ type: PayPaymentIntentEntity })
  createPay(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreatePayPaymentIntentDto,
  ) {
    return this.paymentIntents.createPay(consumer, dto);
  }

  @Get()
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: "List the consumer's payment intents" })
  @ApiOkResponse({ type: PaymentIntentListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryPaymentIntentsDto,
  ) {
    return this.paymentIntents.findAll(consumer, query);
  }

  @Get(':id/transitions')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'List the status-transition history for a payment intent',
  })
  @ApiOkResponse({ type: PaymentIntentTransitionListEntity })
  listTransitions(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.paymentIntents.listTransitions(consumer, id);
  }

  @Get(':id')
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: 'Get a payment intent by id' })
  @ApiOkResponse({ type: PaymentIntentEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.paymentIntents.findOne(consumer, id);
  }

  @Post(':id/validate')
  @RequirePermissions('payments:write')
  @ApiOperation({
    summary:
      'Validate a submitted tx against the intent (tx success + destination + amount + memo); finalizes status and fires the event',
  })
  @ApiOkResponse({ type: ValidationOutcomeEntity })
  validate(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: ValidatePaymentIntentDto,
  ) {
    return this.paymentIntents.validate(consumer, id, dto.txHash);
  }

  @Patch(':id')
  @RequirePermissions('payments:write')
  @ApiOperation({
    summary: 'Update a payment intent (status / txHash / reference)',
  })
  @ApiOkResponse({ type: PaymentIntentEntity })
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdatePaymentIntentDto,
  ) {
    return this.paymentIntents.update(consumer, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('payments:write')
  @ApiOperation({ summary: 'Delete a payment intent' })
  @ApiOkResponse({ type: DeletedEntity })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.paymentIntents.remove(consumer, id);
  }
}
