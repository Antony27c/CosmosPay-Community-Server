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
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '../common/decorators/current-consumer.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { QueryDeliveriesDto } from './dto/query-deliveries.dto';
import { RotateWebhookSecretDto } from './dto/rotate-webhook-secret.dto';
import {
  WebhookDeletedEntity,
  WebhookDeliveryEntity,
  WebhookDeliveryListEntity,
  WebhookEndpointEntity,
  WebhookEndpointWithSecretEntity,
  WebhookPingEntity,
} from './entities/webhook.entity';
import { WebhooksService } from './webhooks.service';

// URI versioning => /v1/webhooks
@ApiTags('webhooks')
@Controller({ path: 'webhooks', version: '1' })
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post()
  @RequirePermissions('webhooks:write')
  @ApiOperation({
    summary:
      'Register a webhook endpoint (returns the signing secret — shown once)',
  })
  @ApiCreatedResponse({ type: WebhookEndpointWithSecretEntity })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateWebhookEndpointDto,
  ) {
    return this.webhooks.create(consumer, dto);
  }

  @Get()
  @RequirePermissions('webhooks:read')
  @ApiOperation({ summary: "List the consumer's webhook endpoints" })
  @ApiOkResponse({ type: [WebhookEndpointEntity] })
  findAll(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.webhooks.findAll(consumer);
  }

  @Get(':id')
  @RequirePermissions('webhooks:read')
  @ApiOperation({ summary: 'Get a webhook endpoint' })
  @ApiOkResponse({ type: WebhookEndpointEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.webhooks.findOne(consumer, id);
  }

  @Patch(':id')
  @RequirePermissions('webhooks:write')
  @ApiOperation({
    summary: 'Update a webhook endpoint (url/description/enabled/eventTypes)',
  })
  @ApiOkResponse({ type: WebhookEndpointEntity })
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookEndpointDto,
  ) {
    return this.webhooks.update(consumer, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('webhooks:write')
  @ApiOperation({ summary: 'Delete a webhook endpoint' })
  @ApiOkResponse({ type: WebhookDeletedEntity })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.webhooks.remove(consumer, id);
  }

  @Post(':id/rotate-secret')
  @RequirePermissions('webhooks:write')
  @ApiOperation({
    summary:
      'Rotate the signing secret (returns the new secret). The previous secret keeps signing deliveries until previousSecretExpiresAt, unless graceSeconds=0.',
  })
  @ApiBody({ type: RotateWebhookSecretDto, required: false })
  @ApiCreatedResponse({ type: WebhookEndpointWithSecretEntity })
  rotateSecret(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto?: RotateWebhookSecretDto,
  ) {
    return this.webhooks.rotateSecret(consumer, id, dto ?? {});
  }

  @Post(':id/ping')
  @RequirePermissions('webhooks:write')
  @ApiOperation({ summary: 'Send a test event to verify the endpoint' })
  @ApiCreatedResponse({ type: WebhookPingEntity })
  ping(@CurrentConsumer() consumer: GatewayConsumer, @Param('id') id: string) {
    return this.webhooks.ping(consumer, id);
  }

  @Get(':id/deliveries')
  @RequirePermissions('webhooks:read')
  @ApiOperation({
    summary: 'List delivery attempts for an endpoint (audit trail)',
  })
  @ApiOkResponse({ type: WebhookDeliveryListEntity })
  listDeliveries(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Query() query: QueryDeliveriesDto,
  ) {
    return this.webhooks.listDeliveries(consumer, id, query);
  }

  @Post(':id/deliveries/:deliveryId/redeliver')
  @RequirePermissions('webhooks:write')
  @ApiOperation({ summary: 'Manually re-send a past delivery' })
  @ApiCreatedResponse({ type: WebhookDeliveryEntity })
  redeliver(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Param('deliveryId') deliveryId: string,
  ) {
    return this.webhooks.redeliver(consumer, id, deliveryId);
  }
}
