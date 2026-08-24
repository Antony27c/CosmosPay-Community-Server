import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AuthorizePayoutDto } from './dto/authorize-payout.dto';
import { CreatePayoutDto } from './dto/create-payout.dto';

/**
 * Same pipe the app runs (whitelist + forbidNonWhitelisted). Guards offramp DTO
 * cross-field rules (chain ↔ address, chain ↔ signed_transaction).
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const run = (metatype: any, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype, data: '' });

const STELLAR = 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO';
const EVM = '0x1234567890123456789012345678901234567890';
const SOLANA = 'So11111111111111111111111111111111111111112';

describe('Offramp DTOs — validation', () => {
  describe('CreatePayoutDto', () => {
    it('accepts the minimal payload (evm without signed_transaction)', async () => {
      await expect(
        run(CreatePayoutDto, {
          quote_id: 'qe_000000000000',
          sender_wallet_address: EVM,
          chain: 'evm',
        }),
      ).resolves.toBeDefined();
    });

    it('accepts the maximal payload (stellar with signed_transaction)', async () => {
      await expect(
        run(CreatePayoutDto, {
          quote_id: 'qe_000000000000',
          sender_wallet_address: STELLAR,
          chain: 'stellar',
          signed_transaction: 'AAAAAgAAAABsigned-xdr-example',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects stellar without signed_transaction (must name authorize)', async () => {
      await expect(
        run(CreatePayoutDto, {
          quote_id: 'qe_000000000000',
          sender_wallet_address: STELLAR,
          chain: 'stellar',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      try {
        await run(CreatePayoutDto, {
          quote_id: 'qe_000000000000',
          sender_wallet_address: STELLAR,
          chain: 'stellar',
        });
      } catch (err) {
        const body = (err as BadRequestException).getResponse() as {
          message: string | string[];
        };
        const messages = Array.isArray(body.message)
          ? body.message
          : [body.message];
        expect(
          messages.some((m) =>
            m.includes('POST /v1/offramp/payouts/authorize'),
          ),
        ).toBe(true);
        expect(JSON.stringify(body)).not.toContain('blindpay');
      }
    });

    it('rejects stellar with an EVM sender_wallet_address', async () => {
      await expect(
        run(CreatePayoutDto, {
          quote_id: 'qe_000000000000',
          sender_wallet_address: EVM,
          chain: 'stellar',
          signed_transaction: 'AAAAAgAAAABsigned-xdr-example',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects solana without signed_transaction', async () => {
      await expect(
        run(CreatePayoutDto, {
          quote_id: 'qe_000000000000',
          sender_wallet_address: SOLANA,
          chain: 'solana',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown field', async () => {
      await expect(
        run(CreatePayoutDto, {
          quote_id: 'qe_000000000000',
          sender_wallet_address: EVM,
          chain: 'evm',
          not_a_real_field: 'x',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('AuthorizePayoutDto', () => {
    it('accepts the minimal payload (stellar)', async () => {
      await expect(
        run(AuthorizePayoutDto, {
          quote_id: 'qe_000000000000',
          sender_wallet_address: STELLAR,
          chain: 'stellar',
        }),
      ).resolves.toBeDefined();
    });

    it('accepts the maximal payload (solana)', async () => {
      await expect(
        run(AuthorizePayoutDto, {
          quote_id: 'qe_000000000000',
          sender_wallet_address: SOLANA,
          chain: 'solana',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects stellar with an EVM sender_wallet_address', async () => {
      await expect(
        run(AuthorizePayoutDto, {
          quote_id: 'qe_000000000000',
          sender_wallet_address: EVM,
          chain: 'stellar',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown field', async () => {
      await expect(
        run(AuthorizePayoutDto, {
          quote_id: 'qe_000000000000',
          sender_wallet_address: STELLAR,
          chain: 'stellar',
          not_a_real_field: 'x',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
