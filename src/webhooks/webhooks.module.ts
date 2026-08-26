import { Global, Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDestinationGuard } from './webhook-destination.guard';
import { WebhookTerminalEmitter } from './webhook-terminal-emitter.service';
import { WebhookSecretCleanupService } from './webhook-secret-cleanup.service';
import { WebhookRetryWorkerService } from './webhook-retry-worker.service';

@Global()
@Module({
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WebhookDispatcherService,
    WebhookDestinationGuard,
    WebhookTerminalEmitter,
    WebhookSecretCleanupService,
    WebhookRetryWorkerService,
  ],
  // Terminal emitter is the single claim+emit path for observer and submit.
  exports: [WebhookDispatcherService, WebhookTerminalEmitter],
})
export class WebhooksModule {}
