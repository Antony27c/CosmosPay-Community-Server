import 'reflect-metadata';
import { validateEnv } from './env.validation';

/** Valid Stellar testnet address (from .env.example). */
const VALID_FEE_WALLET =
  'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';

function validEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    DATABASE_URL:
      'postgresql://postgres:postgres@localhost:5432/cosmos_payments',
    APISIX_GATEWAY_SECRET: 'test-gateway-secret',
    NODE_ENV: 'test',
    STELLAR_SWAP_FEE_WALLET: VALID_FEE_WALLET,
    ...overrides,
  };
}

function expectEnvError(env: Record<string, string>, variable: string): void {
  expect(() => validateEnv(env)).toThrow(new RegExp(variable, 'i'));
}

describe('validateEnv', () => {
  it('accepts a minimal valid environment', () => {
    const result = validateEnv(validEnv());
    expect(typeof result.DATABASE_URL).toBe('string');
    expect(result.APISIX_GATEWAY_SECRET).toBe('test-gateway-secret');
  });

  it('requires APISIX_GATEWAY_SECRET', () => {
    expectEnvError(
      validEnv({ APISIX_GATEWAY_SECRET: '' }),
      'APISIX_GATEWAY_SECRET',
    );
  });

  describe('NODE_ENV', () => {
    it('rejects NODE_ENV=prod', () => {
      expectEnvError(validEnv({ NODE_ENV: 'prod' }), 'NODE_ENV');
    });

    it('accepts development, test, and production', () => {
      for (const nodeEnv of ['development', 'test', 'production'] as const) {
        expect(validateEnv(validEnv({ NODE_ENV: nodeEnv })).NODE_ENV).toBe(
          nodeEnv,
        );
      }
    });
  });

  describe('deprecated STELLAR_HORIZON_URL', () => {
    it('rejects the legacy single Horizon URL variable', () => {
      expect(() =>
        validateEnv(
          validEnv({ STELLAR_HORIZON_URL: 'https://horizon.example.com' }),
        ),
      ).toThrow(/STELLAR_HORIZON_URL.*STELLAR_HORIZON_URL_PUBLIC/i);
    });
  });

  describe('observer tuning', () => {
    it('rejects OBSERVER_INTERVAL_MS=abc', () => {
      expectEnvError(
        validEnv({ OBSERVER_INTERVAL_MS: 'abc' }),
        'OBSERVER_INTERVAL_MS',
      );
    });

    it('rejects OBSERVER_INTERVAL_MS below minimum', () => {
      expectEnvError(
        validEnv({ OBSERVER_INTERVAL_MS: '5' }),
        'OBSERVER_INTERVAL_MS',
      );
    });

    it('accepts OBSERVER_INTERVAL_MS=15000', () => {
      expect(
        validateEnv(validEnv({ OBSERVER_INTERVAL_MS: '15000' }))
          .OBSERVER_INTERVAL_MS,
      ).toBe(15000);
    });

    it('rejects OBSERVER_BATCH_SIZE=abc', () => {
      expectEnvError(
        validEnv({ OBSERVER_BATCH_SIZE: 'abc' }),
        'OBSERVER_BATCH_SIZE',
      );
    });

    it('rejects OBSERVER_BATCH_SIZE=0', () => {
      expectEnvError(
        validEnv({ OBSERVER_BATCH_SIZE: '0' }),
        'OBSERVER_BATCH_SIZE',
      );
    });

    it('rejects invalid OBSERVER_ENABLED values', () => {
      expectEnvError(
        validEnv({ OBSERVER_ENABLED: 'fasle' }),
        'OBSERVER_ENABLED',
      );
    });

    it('accepts OBSERVER_ENABLED=true and false', () => {
      expect(
        validateEnv(validEnv({ OBSERVER_ENABLED: 'true' })).OBSERVER_ENABLED,
      ).toBe('true');
      expect(
        validateEnv(validEnv({ OBSERVER_ENABLED: 'false' })).OBSERVER_ENABLED,
      ).toBe('false');
    });
  });

  describe('request log retention', () => {
    it('rejects REQUEST_LOG_RETENTION_DAYS=abc', () => {
      expectEnvError(
        validEnv({ REQUEST_LOG_RETENTION_DAYS: 'abc' }),
        'REQUEST_LOG_RETENTION_DAYS',
      );
    });

    it('accepts REQUEST_LOG_RETENTION_DAYS=0 (prune disabled)', () => {
      expect(
        validateEnv(validEnv({ REQUEST_LOG_RETENTION_DAYS: '0' }))
          .REQUEST_LOG_RETENTION_DAYS,
      ).toBe(0);
    });

    it('rejects REQUEST_LOG_PRUNE_INTERVAL_MS=abc', () => {
      expectEnvError(
        validEnv({ REQUEST_LOG_PRUNE_INTERVAL_MS: 'abc' }),
        'REQUEST_LOG_PRUNE_INTERVAL_MS',
      );
    });

    it('rejects REQUEST_LOG_PRUNE_BATCH_SIZE=0', () => {
      expectEnvError(
        validEnv({ REQUEST_LOG_PRUNE_BATCH_SIZE: '0' }),
        'REQUEST_LOG_PRUNE_BATCH_SIZE',
      );
    });

    it('rejects REQUEST_LOG_PRUNE_MAX_PER_CYCLE=abc', () => {
      expectEnvError(
        validEnv({ REQUEST_LOG_PRUNE_MAX_PER_CYCLE: 'abc' }),
        'REQUEST_LOG_PRUNE_MAX_PER_CYCLE',
      );
    });
  });

  describe('payment intent TTL', () => {
    it('rejects PAYMENT_INTENT_TTL_SECONDS=abc', () => {
      expectEnvError(
        validEnv({ PAYMENT_INTENT_TTL_SECONDS: 'abc' }),
        'PAYMENT_INTENT_TTL_SECONDS',
      );
    });

    it('rejects PAYMENT_INTENT_TTL_SECONDS=0', () => {
      expectEnvError(
        validEnv({ PAYMENT_INTENT_TTL_SECONDS: '0' }),
        'PAYMENT_INTENT_TTL_SECONDS',
      );
    });
  });

  describe('webhook tuning', () => {
    it('rejects WEBHOOK_TIMEOUT_MS=abc', () => {
      expectEnvError(
        validEnv({ WEBHOOK_TIMEOUT_MS: 'abc' }),
        'WEBHOOK_TIMEOUT_MS',
      );
    });

    it('rejects WEBHOOK_MAX_ATTEMPTS=abc', () => {
      expectEnvError(
        validEnv({ WEBHOOK_MAX_ATTEMPTS: 'abc' }),
        'WEBHOOK_MAX_ATTEMPTS',
      );
    });

    it('rejects WEBHOOK_BACKOFF_MS=abc', () => {
      expectEnvError(
        validEnv({ WEBHOOK_BACKOFF_MS: 'abc' }),
        'WEBHOOK_BACKOFF_MS',
      );
    });
  });

  describe('Horizon and OpenAPI URLs', () => {
    it('rejects invalid STELLAR_HORIZON_URL_PUBLIC', () => {
      expectEnvError(
        validEnv({ STELLAR_HORIZON_URL_PUBLIC: 'not-a-url' }),
        'STELLAR_HORIZON_URL_PUBLIC',
      );
    });

    it('accepts valid Horizon override URLs', () => {
      expect(
        validateEnv(
          validEnv({
            STELLAR_HORIZON_URL_PUBLIC: 'https://horizon.stellar.org',
            STELLAR_HORIZON_URL_TESTNET: 'https://horizon-testnet.stellar.org',
          }),
        ).STELLAR_HORIZON_URL_PUBLIC,
      ).toBe('https://horizon.stellar.org');
    });

    it('rejects STELLAR_HTTP_TIMEOUT_MS=abc', () => {
      expectEnvError(
        validEnv({ STELLAR_HTTP_TIMEOUT_MS: 'abc' }),
        'STELLAR_HTTP_TIMEOUT_MS',
      );
    });

    it('rejects STELLAR_MAX_ATTEMPTS=0', () => {
      expectEnvError(
        validEnv({ STELLAR_MAX_ATTEMPTS: '0' }),
        'STELLAR_MAX_ATTEMPTS',
      );
    });

    it('accepts STELLAR_HTTP_TIMEOUT_MS and STELLAR_MAX_ATTEMPTS', () => {
      const result = validateEnv(
        validEnv({
          STELLAR_HTTP_TIMEOUT_MS: '10000',
          STELLAR_MAX_ATTEMPTS: '3',
        }),
      );
      expect(result.STELLAR_HTTP_TIMEOUT_MS).toBe(10000);
      expect(result.STELLAR_MAX_ATTEMPTS).toBe(3);
    });

    it('rejects invalid OPENAPI_SERVER_URL', () => {
      expectEnvError(
        validEnv({ OPENAPI_SERVER_URL: 'not-a-url' }),
        'OPENAPI_SERVER_URL',
      );
    });
  });

  describe('APISIX header overrides', () => {
    it('accepts optional APISIX header overrides', () => {
      expect(
        validateEnv(
          validEnv({
            APISIX_ENVIRONMENT_HEADER: 'x-custom-env',
            APISIX_ROLE_HEADER: 'x-custom-role',
            APISIX_PERMISSIONS_HEADER: 'x-custom-permissions',
          }),
        ).APISIX_ENVIRONMENT_HEADER,
      ).toBe('x-custom-env');
    });
  });

  describe('SWAGGER_ENABLED', () => {
    it('accepts true and false', () => {
      expect(
        validateEnv(validEnv({ SWAGGER_ENABLED: 'true' })).SWAGGER_ENABLED,
      ).toBe('true');
      expect(
        validateEnv(validEnv({ SWAGGER_ENABLED: 'false' })).SWAGGER_ENABLED,
      ).toBe('false');
    });

    it('rejects invalid SWAGGER_ENABLED values', () => {
      expectEnvError(validEnv({ SWAGGER_ENABLED: 'yes' }), 'SWAGGER_ENABLED');
    });
  });

  describe('cross-field rules', () => {
    it('requires STELLAR_SWAP_FEE_WALLET when STELLAR_SWAP_FEE_BPS > 0', () => {
      expect(() =>
        validateEnv(
          validEnv({
            STELLAR_SWAP_FEE_BPS: '50',
            STELLAR_SWAP_FEE_WALLET: '',
          }),
        ),
      ).toThrow(/STELLAR_SWAP_FEE_WALLET/i);
    });

    it('requires STELLAR_SWAP_FEE_WALLET when fee bps defaults to 50', () => {
      expect(() =>
        validateEnv(
          validEnv({
            STELLAR_SWAP_FEE_WALLET: '',
          }),
        ),
      ).toThrow(/STELLAR_SWAP_FEE_WALLET/i);
    });

    it('allows zero fee without a wallet', () => {
      expect(
        validateEnv(
          validEnv({
            STELLAR_SWAP_FEE_BPS: '0',
            STELLAR_SWAP_FEE_WALLET: '',
          }),
        ).STELLAR_SWAP_FEE_BPS,
      ).toBe(0);
    });

    it('rejects an invalid fee wallet when fee > 0', () => {
      expect(() =>
        validateEnv(
          validEnv({
            STELLAR_SWAP_FEE_BPS: '50',
            STELLAR_SWAP_FEE_WALLET: 'GXXX-invalida',
          }),
        ),
      ).toThrow(/STELLAR_SWAP_FEE_WALLET/i);
    });

    it('requires BlindPay webhook secret when API key is set', () => {
      expect(() =>
        validateEnv(
          validEnv({
            BLINDPAY_API_KEY: 'bp_test_key',
            BLINDPAY_INSTANCE_ID: 'in_test',
            BLINDPAY_WEBHOOK_SECRET: '',
          }),
        ),
      ).toThrow(/BLINDPAY_WEBHOOK_SECRET/i);
    });

    it('requires BlindPay instance id when API key is set', () => {
      expect(() =>
        validateEnv(
          validEnv({
            BLINDPAY_API_KEY: 'bp_test_key',
            BLINDPAY_INSTANCE_ID: '',
            BLINDPAY_WEBHOOK_SECRET: 'whsec_test',
          }),
        ),
      ).toThrow(/BLINDPAY_INSTANCE_ID/i);
    });

    it('rejects slippage above max slippage', () => {
      expect(() =>
        validateEnv(
          validEnv({
            STELLAR_SWAP_SLIPPAGE_BPS: '600',
            STELLAR_SWAP_MAX_SLIPPAGE_BPS: '500',
          }),
        ),
      ).toThrow(/STELLAR_SWAP_SLIPPAGE_BPS/i);
    });
  });
});
