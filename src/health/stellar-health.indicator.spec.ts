import { ServiceUnavailableException } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { StellarNetwork } from '../config/configuration';
import {
  HORIZON_READINESS_TIMEOUT_MS,
  StellarHealthIndicator,
} from './stellar-health.indicator';

describe('StellarHealthIndicator', () => {
  const horizon = {
    public: 'https://horizon.example/public',
    testnet: 'https://horizon.example/testnet',
  };

  function make(call: jest.Mock, network: StellarNetwork = 'testnet') {
    const stellar = { call } as any;
    const config = { get: () => ({ network, horizon }) } as any;
    return new StellarHealthIndicator(
      new HealthIndicatorService(),
      stellar,
      config,
    );
  }

  it('reports the probed network as up when root() succeeds', async () => {
    const call = jest.fn().mockResolvedValue({ core_latest_ledger: 1 });
    const indicator = make(call);

    const testnet = await indicator.ping('testnet');

    expect(testnet['horizon.testnet'].status).toBe('up');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][2]).toEqual({
      maxAttempts: 1,
      timeoutMs: HORIZON_READINESS_TIMEOUT_MS,
    });
  });

  it('reports the network as down when Horizon is unreachable', async () => {
    const call = jest
      .fn()
      .mockRejectedValue(
        new ServiceUnavailableException('Could not reach the Stellar network'),
      );
    const indicator = make(call);

    const result = await indicator.ping('testnet');
    const detail = result['horizon.testnet'];
    expect(detail.status).toBe('down');
    expect('message' in detail ? detail.message : '').toMatch(
      /Could not reach/,
    );
  });

  it('registers one check for the configured STELLAR_NETWORK only', () => {
    expect(make(jest.fn(), 'testnet').checks()).toHaveLength(1);
    expect(make(jest.fn(), 'public').checks()).toHaveLength(1);
  });
});
