import { plainToInstance } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  validateSync,
  type ValidationError,
} from 'class-validator';
import { StrKey } from '@stellar/stellar-sdk';

const URL_OPTIONS = {
  require_protocol: true,
  protocols: ['http', 'https'],
  require_tld: false,
};

const DEFAULT_SWAP_FEE_BPS = 50;
const DEFAULT_SWAP_SLIPPAGE_BPS = 50;
const DEFAULT_SWAP_MAX_SLIPPAGE_BPS = 500;

/**
 * Schema used by ConfigModule to fail fast at boot if the environment is
 * misconfigured. APISIX_GATEWAY_SECRET is always required — the whole point of
 * the service is to only trust requests carrying the secret the gateway injects.
 */
class EnvironmentVariables {
  @IsOptional()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT?: number;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsOptional()
  @IsString()
  APISIX_GATEWAY_SECRET?: string;

  @IsOptional()
  @IsString()
  APISIX_GATEWAY_SECRET_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_CONSUMER_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_CREDENTIAL_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_ENVIRONMENT_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_ROLE_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_PERMISSIONS_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_ORGANIZATION_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_PLAN_HEADER?: string;

  @IsOptional()
  @IsString()
  APISIX_SWAP_FEE_BPS_HEADER?: string;

  @IsOptional()
  @IsIn(['public', 'testnet'])
  STELLAR_NETWORK?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  STELLAR_HORIZON_URL_PUBLIC?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  STELLAR_HORIZON_URL_TESTNET?: string;

  @IsOptional()
  @IsString()
  STELLAR_BASE_FEE?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  STELLAR_TX_TIMEOUT?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  STELLAR_HTTP_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  STELLAR_MAX_ATTEMPTS?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  STELLAR_RETRY_BASE_MS?: number;

  // --- Stellar native swaps (path-payment asset exchange) ---
  @IsOptional()
  @IsString()
  STELLAR_SWAP_FEE_WALLET?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  STELLAR_SWAP_FEE_BPS?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  STELLAR_SWAP_SLIPPAGE_BPS?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  STELLAR_SWAP_MAX_SLIPPAGE_BPS?: number;

  /** When "true", at most one non-expired PENDING swap per (consumer, source, network). */
  @IsOptional()
  @IsBooleanString()
  STELLAR_SWAP_SINGLE_INFLIGHT?: string;

  // --- On-chain observer + payment intent lifetime ---
  @IsOptional()
  @IsBooleanString()
  OBSERVER_ENABLED?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  OBSERVER_INTERVAL_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  OBSERVER_BATCH_SIZE?: number;

  // --- Request log retention (PII prune) ---
  @IsOptional()
  @IsInt()
  @Min(0)
  REQUEST_LOG_RETENTION_DAYS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  REQUEST_LOG_PRUNE_INTERVAL_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  REQUEST_LOG_PRUNE_BATCH_SIZE?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  REQUEST_LOG_PRUNE_MAX_PER_CYCLE?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  PAYMENT_INTENT_TTL_SECONDS?: number;

  // --- Outbound webhooks ---
  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_CONNECT_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_READ_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_MAX_RESPONSE_BYTES?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_MAX_ATTEMPTS?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  WEBHOOK_BACKOFF_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  WEBHOOK_MAX_BACKOFF_MS?: number;

  @IsOptional()
  @IsString()
  WEBHOOK_SIGNATURE_HEADER?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  WEBHOOK_SECRET_GRACE_SECONDS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_WORKER_INTERVAL_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_WORKER_BATCH_SIZE?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_LEASE_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_FANOUT_CONCURRENCY?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  WEBHOOK_PAUSE_AFTER_FAILURES?: number;

  // --- OpenAPI / Swagger ---
  @IsOptional()
  @IsUrl(URL_OPTIONS)
  OPENAPI_SERVER_URL?: string;

  @IsOptional()
  @IsBooleanString()
  SWAGGER_ENABLED?: string;

  // --- BlindPay (onramp / offramp / KYC rails) ---
  // All optional: the service boots without them; the BlindPay client fails with
  // a clear 503 only when a BlindPay-backed route is actually exercised.
  @IsOptional()
  @IsString()
  BLINDPAY_API_KEY?: string;

  @IsOptional()
  @IsString()
  BLINDPAY_INSTANCE_ID?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  BLINDPAY_BASE_URL?: string;

  @IsOptional()
  @IsString()
  BLINDPAY_WEBHOOK_SECRET?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  BLINDPAY_TIMEOUT_MS?: number;

  /**
   * Platform-admin credentials JSON (issue #34). Optional at boot — empty means
   * admin routes fail closed. Shape:
   * [{"id":"viewer","secret":"…","role":"read"},{"id":"owner","secret":"…","role":"write"}]
   */
  @IsOptional()
  @IsString()
  ADMIN_API_CREDENTIALS?: string;

  /**
   * Per-consumer KYC redirect_url host allow-list (issue #33). Optional at boot —
   * missing/empty means every consumer fails closed until configured. Shape:
   * {"cosmos_acme":["acme.com","app.acme.com"]}
   */
  @IsOptional()
  @IsString()
  KYC_REDIRECT_URL_WHITELIST?: string;
}

function formatValidationErrors(errors: ValidationError[]): string {
  return errors
    .flatMap((error) => {
      const property = error.property;
      const constraints = Object.values(error.constraints ?? {});
      return constraints.map((message) => `${property}: ${message}`);
    })
    .join('\n');
}

function isNonEmpty(value: string | undefined): boolean {
  return value != null && value.trim() !== '';
}

function effectiveSwapFeeBps(validated: EnvironmentVariables): number {
  return validated.STELLAR_SWAP_FEE_BPS ?? DEFAULT_SWAP_FEE_BPS;
}

function effectiveSlippageBps(validated: EnvironmentVariables): number {
  return validated.STELLAR_SWAP_SLIPPAGE_BPS ?? DEFAULT_SWAP_SLIPPAGE_BPS;
}

function effectiveMaxSlippageBps(validated: EnvironmentVariables): number {
  return (
    validated.STELLAR_SWAP_MAX_SLIPPAGE_BPS ?? DEFAULT_SWAP_MAX_SLIPPAGE_BPS
  );
}

export function validateEnv(config: Record<string, unknown>) {
  const legacyHorizonUrl = config.STELLAR_HORIZON_URL;
  if (typeof legacyHorizonUrl === 'string' && legacyHorizonUrl.trim() !== '') {
    throw new Error(
      'STELLAR_HORIZON_URL is no longer used: rename it to ' +
        'STELLAR_HORIZON_URL_PUBLIC or STELLAR_HORIZON_URL_TESTNET so the ' +
        'service actually points at your Horizon instance.',
    );
  }

  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${formatValidationErrors(errors)}`,
    );
  }

  if (!validated.APISIX_GATEWAY_SECRET) {
    throw new Error(
      'APISIX_GATEWAY_SECRET is required: the service only trusts requests that ' +
        'carry the shared secret APISIX injects. Set it to match the dev platform ' +
        "(COSMOS_GATEWAY_SECRET) and the gateway route's X-Gateway-Secret.",
    );
  }

  const feeBps = effectiveSwapFeeBps(validated);
  if (feeBps > 0) {
    const wallet = validated.STELLAR_SWAP_FEE_WALLET?.trim() ?? '';
    if (!wallet) {
      throw new Error(
        'STELLAR_SWAP_FEE_WALLET is required when STELLAR_SWAP_FEE_BPS is greater ' +
          'than zero: swap fees are paid to this Stellar account (G...). Set the ' +
          'wallet or disable the fee with STELLAR_SWAP_FEE_BPS=0.',
      );
    }
    if (!StrKey.isValidEd25519PublicKey(wallet)) {
      throw new Error(
        'STELLAR_SWAP_FEE_WALLET must be a valid Stellar account address (G...) ' +
          'when STELLAR_SWAP_FEE_BPS is greater than zero.',
      );
    }
  }

  const slippageBps = effectiveSlippageBps(validated);
  const maxSlippageBps = effectiveMaxSlippageBps(validated);
  if (slippageBps > maxSlippageBps) {
    throw new Error(
      'STELLAR_SWAP_SLIPPAGE_BPS must be less than or equal to ' +
        'STELLAR_SWAP_MAX_SLIPPAGE_BPS so callers cannot request slippage ' +
        'above the configured hard cap.',
    );
  }

  if (isNonEmpty(validated.BLINDPAY_API_KEY)) {
    if (!isNonEmpty(validated.BLINDPAY_INSTANCE_ID)) {
      throw new Error(
        'BLINDPAY_INSTANCE_ID is required when BLINDPAY_API_KEY is set: every ' +
          'BlindPay API call is scoped to a platform instance id (in_...).',
      );
    }
    if (!isNonEmpty(validated.BLINDPAY_WEBHOOK_SECRET)) {
      throw new Error(
        'BLINDPAY_WEBHOOK_SECRET is required when BLINDPAY_API_KEY is set: inbound ' +
          'BlindPay webhooks are verified with the Svix signing secret (whsec_...).',
      );
    }
  }

  return validated;
}
