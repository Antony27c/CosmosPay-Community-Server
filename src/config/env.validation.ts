import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

/**
 * Schema used by ConfigModule to fail fast at boot if the environment is
 * misconfigured. APISIX_GATEWAY_SECRET is always required — the whole point of
 * the service is to only trust requests carrying the secret the gateway injects.
 */
class EnvironmentVariables {
  @IsOptional()
  @IsString()
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
  @IsString()
  STELLAR_HORIZON_URL?: string;

  @IsOptional()
  @IsString()
  STELLAR_BASE_FEE?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  STELLAR_TX_TIMEOUT?: number;

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
  @IsString()
  BLINDPAY_BASE_URL?: string;

  @IsOptional()
  @IsString()
  BLINDPAY_WEBHOOK_SECRET?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  BLINDPAY_TIMEOUT_MS?: number;

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
  WEBHOOK_TIMEOUT_MS?: number;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${errors
        .map((e) => Object.values(e.constraints ?? {}).join(', '))
        .join('\n')}`,
    );
  }

  if (!validated.APISIX_GATEWAY_SECRET) {
    throw new Error(
      'APISIX_GATEWAY_SECRET is required: the service only trusts requests that ' +
        'carry the shared secret APISIX injects. Set it to match the dev platform ' +
        "(COSMOS_GATEWAY_SECRET) and the gateway route's X-Gateway-Secret.",
    );
  }

  return validated;
}
