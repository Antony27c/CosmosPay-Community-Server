import 'reflect-metadata';
import { validateEnv } from '../src/config/env.validation';

const base: Record<string, string> = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/cosmos_payments',
  APISIX_GATEWAY_SECRET: 'test-gateway-secret-for-evidence',
  STELLAR_SWAP_FEE_WALLET:
    'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76',
};

function runCase(name: string, env: Record<string, string>): void {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`CASE: ${name}`);
  console.log('='.repeat(72));
  try {
    validateEnv({ ...base, ...env });
    console.error('UNEXPECTED: validation passed (expected crash)');
    process.exitCode = 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
  }
}

runCase('OBSERVER_INTERVAL_MS=abc', { OBSERVER_INTERVAL_MS: 'abc' });
runCase('NODE_ENV=prod', { NODE_ENV: 'prod' });
