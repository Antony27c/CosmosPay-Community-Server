import {
  parseAdminCredentials,
  type AdminCredential,
} from '../admin/admin-auth';
import {
  parseRedirectUrlWhitelist,
  type RedirectUrlWhitelist,
} from '../kyc/redirect-url-whitelist';

/**
 * Centralized, typed configuration loaded from environment variables.
 * Consumed via Nest's ConfigService<AppConfig, true>.
 */
export type StellarNetwork = 'public' | 'testnet';

export interface AppConfig {
  nodeEnv: string;
  /** When true, mounts /docs (Express middleware — not behind Nest guards). */
  swaggerEnabled: boolean;
  port: number;
  databaseUrl: string;
  apisix: {
    gatewaySecret: string;
    gatewaySecretHeader: string;
    consumerHeader: string;
    credentialHeader: string;
    environmentHeader: string;
    roleHeader: string;
    permissionsHeader: string;
    // Organization the API key belongs to, and the org's plan + plan-derived swap
    // commission. APISIX injects these per consumer (the dev platform sets them
    // from the org's plan); the client cannot supply them. This is how the swap
    // fee is enforced per organization and can never be passed as a request param.
    organizationHeader: string;
    planHeader: string;
    swapFeeBpsHeader: string;
  };
  admin: {
    /**
     * Platform-admin credentials (issue #34). Empty ⇒ fail closed (no admin access).
     * Presented as `Authorization: Bearer <secret>`.
     */
    credentials: AdminCredential[];
  };
  kyc: {
    /**
     * Per-consumer redirect_url host allow-list (issue #33).
     * Empty map ⇒ every consumer fails closed until configured.
     */
    redirectUrlWhitelist: RedirectUrlWhitelist;
  };
  stellar: {
    // Fallback network when the API key environment is not forwarded
    // (e.g. local dev without the gateway). Otherwise the key type decides.
    network: StellarNetwork;
    horizon: Record<StellarNetwork, string>;
    baseFee: string;
    timeoutSeconds: number;
    /**
     * Per-request budget for Horizon. stellar-sdk v16 CallBuilder.call() has
     * no AbortSignal, so StellarService.call() races the request against this.
     */
    httpTimeoutMs: number;
    /** Max attempts (initial + retries) for 429 / 5xx / network errors. */
    maxAttempts: number;
    /** Base of the exponential backoff between Horizon retries (plus jitter). */
    retryBaseMs: number;
    swap: {
      // Platform account that collects the swap fee. When unset the fee is
      // disabled (no fee operation is added regardless of feeBps).
      feeWallet: string;
      // Swap fee in basis points (50 = 0.5%) taken from the source asset.
      feeBps: number;
      // Default slippage tolerance (bps) applied to the quote to derive destMin.
      slippageBps: number;
      // Hard cap on caller-supplied slippage, to bound how much they can lose.
      maxSlippageBps: number;
      /**
       * When true, reject create if the same (consumer, source, network) already
       * has a non-expired PENDING swap (409). Off by default — concurrent
       * distinct swaps from one account are legitimate; prefer Idempotency-Key.
       */
      singleInflight: boolean;
    };
  };
  observer: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    // Extra wait after tx timebounds before a still-unseen hash can expire.
    expiryGraceMs: number;
  };
  requestLogRetention: {
    // Days to keep RequestLog rows. 0 disables the prune job entirely.
    retentionDays: number;
    // How often the prune cycle runs.
    pruneIntervalMs: number;
    // Rows deleted per deleteMany (keeps each lock short).
    batchSize: number;
    // Hard cap on total rows deleted in one tick (catch-up without unbounded work).
    maxPerCycle: number;
  };
  paymentIntents: {
    // Lifetime of a payment intent; unpaid intents past this are marked EXPIRED.
    ttlSeconds: number;
  };
  webhooks: {
    // Overall AbortController budget ≈ connect + read (defense in depth).
    timeoutMs: number;
    connectTimeoutMs: number;
    readTimeoutMs: number;
    maxResponseBytes: number;
    maxAttempts: number;
    backoffMs: number;
    /** Ceiling for exponential retry delay (ms). */
    maxBackoffMs: number;
    signatureHeader: string;
    // Max overlap (seconds) after rotate-secret during which deliveries are
    // signed with both the new and previous secrets. Callers may request a
    // shorter window; 0 revokes the previous secret immediately.
    secretGraceSeconds: number;
    /** Retry-worker poll interval (ms). */
    workerIntervalMs: number;
    /** Max due deliveries claimed per worker tick. */
    workerBatchSize: number;
    /** Exclusive claim duration so a dead replica's row is reclaimed (ms). */
    leaseMs: number;
    /** Max in-flight enqueue / delivery POSTs per fan-out or worker tick. */
    fanoutConcurrency: number;
    /** Consecutive exhausted deliveries after which the endpoint is paused. */
    pauseAfterFailures: number;
  };
  blindpay: {
    // BlindPay is the fiat<->stablecoin rails provider powering onramp/offramp/KYC.
    // We operate a single platform instance: one API key + one instance id shared
    // by every consumer, with each receiver/payin/payout attributed internally to
    // the APISIX consumer that created it.
    apiKey: string;
    instanceId: string;
    baseUrl: string;
    // Svix endpoint secret (whsec_...) used to verify inbound BlindPay webhooks.
    webhookSecret: string;
    timeoutMs: number;
  };
}

const DEFAULT_HORIZON: Record<StellarNetwork, string> = {
  public: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
};

function parseSwaggerEnabled(): boolean {
  const raw = process.env.SWAGGER_ENABLED;
  if (raw !== undefined) {
    return raw.toLowerCase() === 'true';
  }
  return (process.env.NODE_ENV ?? 'development') !== 'production';
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  swaggerEnabled: parseSwaggerEnabled(),
  port: parseInt(process.env.PORT ?? '3000', 10),
  databaseUrl: process.env.DATABASE_URL ?? '',
  apisix: {
    gatewaySecret: process.env.APISIX_GATEWAY_SECRET ?? '',
    gatewaySecretHeader: (
      process.env.APISIX_GATEWAY_SECRET_HEADER ?? 'x-gateway-secret'
    ).toLowerCase(),
    consumerHeader: (
      process.env.APISIX_CONSUMER_HEADER ?? 'x-consumer-username'
    ).toLowerCase(),
    credentialHeader: (
      process.env.APISIX_CREDENTIAL_HEADER ?? 'x-credential-identifier'
    ).toLowerCase(),
    environmentHeader: (
      process.env.APISIX_ENVIRONMENT_HEADER ?? 'x-consumer-env'
    ).toLowerCase(),
    roleHeader: (
      process.env.APISIX_ROLE_HEADER ?? 'x-consumer-role'
    ).toLowerCase(),
    permissionsHeader: (
      process.env.APISIX_PERMISSIONS_HEADER ?? 'x-consumer-permissions'
    ).toLowerCase(),
    organizationHeader: (
      process.env.APISIX_ORGANIZATION_HEADER ?? 'x-consumer-org'
    ).toLowerCase(),
    planHeader: (
      process.env.APISIX_PLAN_HEADER ?? 'x-consumer-plan'
    ).toLowerCase(),
    swapFeeBpsHeader: (
      process.env.APISIX_SWAP_FEE_BPS_HEADER ?? 'x-plan-swap-fee-bps'
    ).toLowerCase(),
  },
  admin: {
    credentials: parseAdminCredentials(process.env.ADMIN_API_CREDENTIALS),
  },
  kyc: {
    redirectUrlWhitelist: parseRedirectUrlWhitelist(
      process.env.KYC_REDIRECT_URL_WHITELIST,
    ),
  },
  stellar: {
    network:
      (process.env.STELLAR_NETWORK ?? 'testnet').toLowerCase() === 'public'
        ? 'public'
        : 'testnet',
    horizon: {
      public: process.env.STELLAR_HORIZON_URL_PUBLIC ?? DEFAULT_HORIZON.public,
      testnet:
        process.env.STELLAR_HORIZON_URL_TESTNET ?? DEFAULT_HORIZON.testnet,
    },
    baseFee: process.env.STELLAR_BASE_FEE ?? '100',
    timeoutSeconds: parseInt(process.env.STELLAR_TX_TIMEOUT ?? '300', 10),
    httpTimeoutMs: parseInt(process.env.STELLAR_HTTP_TIMEOUT_MS ?? '10000', 10),
    maxAttempts: parseInt(process.env.STELLAR_MAX_ATTEMPTS ?? '3', 10),
    retryBaseMs: parseInt(process.env.STELLAR_RETRY_BASE_MS ?? '250', 10),
    swap: {
      feeWallet: process.env.STELLAR_SWAP_FEE_WALLET ?? '',
      feeBps: parseInt(process.env.STELLAR_SWAP_FEE_BPS ?? '50', 10),
      slippageBps: parseInt(process.env.STELLAR_SWAP_SLIPPAGE_BPS ?? '50', 10),
      maxSlippageBps: parseInt(
        process.env.STELLAR_SWAP_MAX_SLIPPAGE_BPS ?? '500',
        10,
      ),
      singleInflight:
        (process.env.STELLAR_SWAP_SINGLE_INFLIGHT ?? 'false').toLowerCase() ===
        'true',
    },
  },
  observer: {
    // Permanent reconciler that watches Stellar and finalizes paid intents.
    enabled: (process.env.OBSERVER_ENABLED ?? 'true').toLowerCase() !== 'false',
    intervalMs: parseInt(process.env.OBSERVER_INTERVAL_MS ?? '15000', 10),
    batchSize: parseInt(process.env.OBSERVER_BATCH_SIZE ?? '50', 10),
    expiryGraceMs: parseInt(
      process.env.OBSERVER_EXPIRY_GRACE_MS ?? '60000',
      10,
    ),
  },
  requestLogRetention: {
    // Append-only API access log (ip / userAgent). Pruned so PII is not kept forever.
    retentionDays: parseInt(process.env.REQUEST_LOG_RETENTION_DAYS ?? '30', 10),
    pruneIntervalMs: parseInt(
      process.env.REQUEST_LOG_PRUNE_INTERVAL_MS ?? '3600000',
      10,
    ),
    // Each deleteMany is capped so locks stay short; the tick loops until the
    // backlog is drained or maxPerCycle is hit (catches up after long outages).
    batchSize: parseInt(process.env.REQUEST_LOG_PRUNE_BATCH_SIZE ?? '1000', 10),
    maxPerCycle: parseInt(
      process.env.REQUEST_LOG_PRUNE_MAX_PER_CYCLE ?? '50000',
      10,
    ),
  },
  paymentIntents: {
    ttlSeconds: parseInt(process.env.PAYMENT_INTENT_TTL_SECONDS ?? '3600', 10),
  },
  webhooks: {
    // Legacy single timeout kept for callers that still read timeoutMs;
    // prefer connectTimeoutMs + readTimeoutMs for outbound delivery.
    timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS ?? '5000', 10),
    connectTimeoutMs: parseInt(
      process.env.WEBHOOK_CONNECT_TIMEOUT_MS ??
        process.env.WEBHOOK_TIMEOUT_MS ??
        '3000',
      10,
    ),
    readTimeoutMs: parseInt(
      process.env.WEBHOOK_READ_TIMEOUT_MS ??
        process.env.WEBHOOK_TIMEOUT_MS ??
        '5000',
      10,
    ),
    maxResponseBytes: parseInt(
      process.env.WEBHOOK_MAX_RESPONSE_BYTES ?? '65536',
      10,
    ),
    maxAttempts: parseInt(process.env.WEBHOOK_MAX_ATTEMPTS ?? '8', 10),
    backoffMs: parseInt(process.env.WEBHOOK_BACKOFF_MS ?? '2000', 10),
    maxBackoffMs: parseInt(process.env.WEBHOOK_MAX_BACKOFF_MS ?? '3600000', 10),
    signatureHeader: (
      process.env.WEBHOOK_SIGNATURE_HEADER ?? 'x-cosmos-signature'
    ).toLowerCase(),
    secretGraceSeconds: parseInt(
      process.env.WEBHOOK_SECRET_GRACE_SECONDS ?? '86400',
      10,
    ),
    workerIntervalMs: parseInt(
      process.env.WEBHOOK_WORKER_INTERVAL_MS ?? '1000',
      10,
    ),
    workerBatchSize: parseInt(
      process.env.WEBHOOK_WORKER_BATCH_SIZE ?? '50',
      10,
    ),
    leaseMs: parseInt(process.env.WEBHOOK_LEASE_MS ?? '30000', 10),
    fanoutConcurrency: parseInt(
      process.env.WEBHOOK_FANOUT_CONCURRENCY ?? '5',
      10,
    ),
    pauseAfterFailures: parseInt(
      process.env.WEBHOOK_PAUSE_AFTER_FAILURES ?? '5',
      10,
    ),
  },
  blindpay: {
    apiKey: process.env.BLINDPAY_API_KEY ?? '',
    instanceId: process.env.BLINDPAY_INSTANCE_ID ?? '',
    baseUrl: (
      process.env.BLINDPAY_BASE_URL ?? 'https://api.blindpay.com/v1'
    ).replace(/\/+$/, ''),
    webhookSecret: process.env.BLINDPAY_WEBHOOK_SECRET ?? '',
    timeoutMs: parseInt(process.env.BLINDPAY_TIMEOUT_MS ?? '15000', 10),
  },
});
