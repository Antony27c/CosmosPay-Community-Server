import { ServiceUnavailableException } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { StellarHealthIndicator } from './stellar-health.indicator';

describe('StellarHealthIndicator', () => {
  const horizon = {
    public: 'https://horizon.example/public',
    testnet: 'https://horizon.example/testnet',
  };

  function make(call: jest.Mock) {
    const stellar = { call } as any;
    const config = { get: () => ({ horizon }) } as any;
    return new StellarHealthIndicator(
      new HealthIndicatorService(),
      stellar,
      config,
    );
  }

  it('reports horizon.testnet and horizon.public as up when root() succeeds', async () => {
    const call = jest.fn().mockResolvedValue({ core_latest_ledger: 1 });
    const indicator = make(call);

    const testnet = await indicator.ping('testnet');
    const pub = await indicator.ping('public');

    expect(testnet['horizon.testnet'].status).toBe('up');
    expect(pub['horizon.public'].status).toBe('up');
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][2]).toEqual({ maxAttempts: 1 });
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

  it('registers one check per configured network', () => {
    const indicator = make(jest.fn());
    expect(indicator.checks()).toHaveLength(2);
  });
});
