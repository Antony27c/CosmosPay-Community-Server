import { Horizon } from '@stellar/stellar-sdk';
import { ServiceUnavailableException } from '@nestjs/common';
import { StellarService } from '../stellar/stellar.service';
import { StellarVerifierService } from './stellar-verifier.service';

describe('StellarVerifierService.verifyByHash', () => {
  const intent: any = {
    id: 'pi_1',
    network: 'testnet',
    destination: 'GDEST',
    amount: '25.5',
    asset: 'native',
    assetIssuer: null,
    memo: '123456789',
  };
  const config = {
    get: () => ({
      horizon: {
        public: 'https://horizon.test',
        testnet: 'https://horizon.test',
      },
      httpTimeoutMs: 1000,
      maxAttempts: 1,
      retryBaseMs: 1,
    }),
  } as any;
  const stellar = new StellarService(config);
  const make = () => new StellarVerifierService(stellar);

  function mockHorizon(
    tx: { successful: boolean; memo_type?: string; memo?: string },
    paymentRecords: any[],
  ) {
    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: () => ({ call: async () => tx }),
    } as any);
    jest.spyOn(Horizon.Server.prototype, 'payments').mockReturnValue({
      forTransaction: () => ({
        call: async () => ({ records: paymentRecords }),
      }),
    } as any);
  }

  const nativeTo = (to: string, amount: string) => ({
    type: 'payment',
    asset_type: 'native',
    to,
    amount,
  });

  afterEach(() => jest.restoreAllMocks());

  it('accepts a successful tx with matching destination, amount and memo', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      nativeTo('GDEST', '25.5000000'),
    ]);
    const res = await make().verifyByHash(intent, 'a'.repeat(64));
    expect(res.valid).toBe(true);
  });

  it('rejects a memo mismatch', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '999' }, [
      nativeTo('GDEST', '25.5'),
    ]);
    const res = await make().verifyByHash(intent, 'b'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/Memo mismatch/);
  });

  it('rejects when no payment matches destination/amount', async () => {
    mockHorizon({ successful: true, memo_type: 'id', memo: '123456789' }, [
      nativeTo('GOTHER', '25.5'),
      nativeTo('GDEST', '10'),
    ]);
    const res = await make().verifyByHash(intent, 'c'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/No native payment/);
  });

  it('marks a failed on-chain tx as not valid', async () => {
    mockHorizon({ successful: false }, []);
    const res = await make().verifyByHash(intent, 'd'.repeat(64));
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('Transaction failed on-chain');
  });

  it('maps Horizon 429 through StellarService.call to ServiceUnavailableException', async () => {
    jest.spyOn(Horizon.Server.prototype, 'transactions').mockReturnValue({
      transaction: () => ({
        call: async () => {
          const err = new Error('rate limited') as Error & {
            response: { status: number };
          };
          err.response = { status: 429 };
          throw err;
        },
      }),
    } as any);
    await expect(
      make().verifyByHash(intent, 'e'.repeat(64)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
