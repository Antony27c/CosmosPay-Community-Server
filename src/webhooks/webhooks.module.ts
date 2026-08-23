import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDestinationGuard } from './webhook-destination.guard';
import { WebhookTerminalEmitter } from './webhook-terminal-emitter.service';

@Module({
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WebhookDispatcherService,
    WebhookDestinationGuard,
    WebhookTerminalEmitter,
  ],
  // Terminal emitter is the single claim+emit path for observer and submit.
  exports: [WebhookDispatcherService, WebhookTerminalEmitter],
})
export class WebhooksModule {}
