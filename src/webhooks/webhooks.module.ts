import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDestinationGuard } from './webhook-destination.guard';

@Module({
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WebhookDispatcherService,
    WebhookDestinationGuard,
  ],
  // Exported so other modules could dispatch directly if ever needed; events
  // are the primary integration path though.
  exports: [WebhookDispatcherService],
})
export class WebhooksModule {}
