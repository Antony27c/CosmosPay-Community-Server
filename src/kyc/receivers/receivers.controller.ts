import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '../../common/decorators/current-consumer.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { ReceiversService, resolveTosCooldownMs } from './receivers.service';
import { CreateReceiverDto } from './dto/create-receiver.dto';
import { UpdateReceiverDto } from './dto/update-receiver.dto';
import { RequestTosDto } from './dto/request-tos.dto';
import { ApproveReceiverDto } from './dto/approve-receiver.dto';
import { EnableReceiverDto } from './dto/enable-receiver.dto';
import { SetAccessDto } from './dto/set-access.dto';
import { ReceiverEntity } from './entities/receiver.entity';

// /v1/kyc/receivers — the KYC/KYB entities required before any onramp/offramp.
@ApiTags('kyc')
@Controller({ path: 'kyc/receivers', version: '1' })
export class ReceiversController {
  constructor(private readonly receivers: ReceiversService) {}

  @Post()
  @RequirePermissions('kyc:write')
  @ApiOperation({ summary: 'Create a receiver (start KYC/KYB)' })
  @ApiCreatedResponse({ type: ReceiverEntity })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateReceiverDto,
  ) {
    return this.receivers.create(consumer, dto);
  }

  @Get()
  @RequirePermissions('kyc:read')
  @ApiOperation({ summary: "List the consumer's receivers" })
  @ApiOkResponse({ type: [ReceiverEntity] })
  findAll(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.receivers.findAll(consumer);
  }

  @Get(':id')
  @RequirePermissions('kyc:read')
  @ApiOperation({
    summary: 'Get a receiver (refreshes KYC status from BlindPay)',
  })
  @ApiOkResponse({ type: ReceiverEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.receivers.findOne(consumer, id);
  }

  @Post(':id/approve')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary:
      'Approve a pending-review receiver (owner/admin review gate); sends the customer the terms link and returns it',
  })
  @ApiOkResponse({ description: 'Receiver approved; terms link returned' })
  @ApiResponse({
    status: 409,
    description:
      "Invalid KYC status transition (e.g. receiver is not in 'pending_review')",
  })
  approve(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: ApproveReceiverDto,
  ) {
    return this.receivers.approve(consumer, id, dto.redirect_url);
  }

  @Post(':id/tos')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary:
      "Request a terms-of-service link for a receiver ('code' returns the URL; 'email' sends it, max once/day)",
  })
  requestTos(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: RequestTosDto,
    // Trusted dashboard-only resend cooldown (owner immediate, admin 1/min). Ignored for
    // external API keys — the marker header is stripped from client requests by APISIX.
    @Headers('x-cosmos-internal') internal?: string,
    @Headers('x-cosmos-tos-cooldown-ms') cooldown?: string,
  ) {
    return this.receivers.requestTos(
      consumer,
      id,
      dto,
      resolveTosCooldownMs(internal, cooldown),
    );
  }

  @Post(':id/enable')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary: 'Enable an inactive receiver with an accepted terms-of-service id',
  })
  @ApiOkResponse({ type: ReceiverEntity })
  @ApiResponse({
    status: 409,
    description:
      "Invalid KYC status transition (e.g. receiver is not in 'pending_user')",
  })
  enable(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: EnableReceiverDto,
  ) {
    return this.receivers.enable(consumer, id, dto.tos_id);
  }

  @Patch(':id/access')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary:
      'Enable or disable a fiat account (owner/admin kill-switch for onramp/offramp)',
  })
  @ApiOkResponse({ type: ReceiverEntity })
  setAccess(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: SetAccessDto,
  ) {
    return this.receivers.setAccess(consumer, id, dto.disabled);
  }

  @Patch(':id')
  @RequirePermissions('kyc:write')
  @ApiOperation({ summary: 'Update a receiver' })
  @ApiOkResponse({ type: ReceiverEntity })
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdateReceiverDto,
  ) {
    return this.receivers.update(consumer, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('kyc:write')
  @ApiOperation({ summary: 'Delete a receiver' })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.receivers.remove(consumer, id);
  }
}
