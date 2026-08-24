import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { ApisixGuard } from './common/guards/apisix.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { ApisixContextMiddleware } from './common/middleware/apisix-context.middleware';
import { PrismaModule } from './prisma/prisma.module';
import { StellarModule } from './stellar/stellar.module';
import { HealthModule } from './health/health.module';
import { PaymentIntentsModule } from './payment-intents/payment-intents.module';
import { SwapsModule } from './swaps/swaps.module';
import { LiquidityPoolsModule } from './liquidity-pools/liquidity-pools.module';
import { ObserverModule } from './observer/observer.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AdminModule } from './admin/admin.module';
import { ProductsModule } from './products/products.module';
import { CustomersModule } from './customers/customers.module';
import { BlindpayModule } from './blindpay/blindpay.module';
import { KycModule } from './kyc/kyc.module';
import { OnrampModule } from './onramp/onramp.module';
import { OfframpModule } from './offramp/offramp.module';
import { CommonModule } from './common/common.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
    }),
    // Wildcard so the webhook dispatcher can listen to `webhook.*` events.
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    PrismaModule,
    StellarModule,
    HealthModule,
    PaymentIntentsModule,
    SwapsModule,
    LiquidityPoolsModule,
    // Background reconciler: flips swaps/LP ops to SUCCEEDED/FAILED/EXPIRED by
    // checking their txHash on Horizon, even when the customer self-broadcasts.
    ObserverModule,
    // Request-log retention prune (bounded deleteMany on a timer).
    CommonModule,
    WebhooksModule,
    AnalyticsModule,
    AdminModule,
    ProductsModule,
    CustomersModule,
    // BlindPay rails: onramp / offramp / KYC. BlindpayModule is global and hosts
    // the shared client + inbound webhook endpoint; the feature modules below use
    // it. OnrampModule imports KycModule (receiver resolution).
    BlindpayModule,
    KycModule,
    OnrampModule,
    OfframpModule,
  ],
  providers: [
    // Persist a RequestLog row per request (powers the API logs view).
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    // Enforce the "only APISIX" check on every route by default.
    // Routes opt out with @Public().
    {
      provide: APP_GUARD,
      useClass: ApisixGuard,
    },
    // Then authorize against the API key's scopes (declared with
    // @RequirePermissions). Registered after ApisixGuard so the consumer is
    // already attached to the request.
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Attach the gateway consumer context to every request before guards run.
    consumer.apply(ApisixContextMiddleware).forRoutes('*');
  }
}
