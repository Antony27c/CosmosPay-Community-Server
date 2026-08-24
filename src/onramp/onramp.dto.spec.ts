import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreatePayinDto } from './dto/create-payin.dto';
import { CreatePayinQuoteDto } from './dto/create-payin-quote.dto';
import { CreateTrustlineDto } from './dto/create-trustline.dto';
import { CreateVirtualAccountDto } from './dto/create-virtual-account.dto';

/**
 * Same pipe the app runs (whitelist + forbidNonWhitelisted). Guards onramp DTO
 * rules (Stellar trustline address, payer_rules vs payment_method).
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
/** Same length/prefix as a real G-address but with a broken checksum. */
const STELLAR_BAD_CHECKSUM =
  'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AO0';

describe('Onramp DTOs — validation', () => {
  describe('CreatePayinDto', () => {
    it('accepts the minimal payload', async () => {
      await expect(
        run(CreatePayinDto, {
          payin_quote_id: 'qu_000000000000',
        }),
      ).resolves.toBeDefined();
    });

    it('accepts the maximal payload', async () => {
      await expect(
        run(CreatePayinDto, {
          payin_quote_id: 'qu_000000000000',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects an unknown field', async () => {
      await expect(
        run(CreatePayinDto, {
          payin_quote_id: 'qu_000000000000',
          not_a_real_field: 'x',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('CreateTrustlineDto', () => {
    it('accepts the minimal payload', async () => {
      await expect(
        run(CreateTrustlineDto, { address: STELLAR }),
      ).resolves.toBeDefined();
    });

    it('accepts the maximal payload', async () => {
      await expect(
        run(CreateTrustlineDto, { address: STELLAR }),
      ).resolves.toBeDefined();
    });

    it('rejects a Stellar address with a broken checksum', async () => {
      await expect(
        run(CreateTrustlineDto, { address: STELLAR_BAD_CHECKSUM }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown field', async () => {
      await expect(
        run(CreateTrustlineDto, {
          address: STELLAR,
          not_a_real_field: 'x',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('CreateVirtualAccountDto', () => {
    it('accepts the minimal payload', async () => {
      await expect(
        run(CreateVirtualAccountDto, {
          banking_partner: 'cfsb',
          token: 'USDC',
          blockchain_wallet_id: 'clz9xwallet001',
        }),
      ).resolves.toBeDefined();
    });

    it('accepts the maximal payload', async () => {
      await expect(
        run(CreateVirtualAccountDto, {
          banking_partner: 'jpmorgan',
          token: 'USDT',
          blockchain_wallet_id: 'clz9xwallet001',
          signed_agreement_id: 'sa_000000000000',
          sole_proprietor_doc_type: 'bank_statement',
          sole_proprietor_doc_file: 'https://f/1',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects an unknown field', async () => {
      await expect(
        run(CreateVirtualAccountDto, {
          banking_partner: 'cfsb',
          token: 'USDC',
          blockchain_wallet_id: 'clz9xwallet001',
          not_a_real_field: 'x',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('CreatePayinQuoteDto — payer_rules cross rules', () => {
    it('accepts pix without payer_rules', async () => {
      await expect(
        run(CreatePayinQuoteDto, {
          blockchain_wallet_id: 'w1',
          currency_type: 'sender',
          payment_method: 'pix',
          token: 'USDB',
          request_amount: 50000,
        }),
      ).resolves.toBeDefined();
    });

    it('rejects transfers without transfers_allowed_tax_id', async () => {
      await expect(
        run(CreatePayinQuoteDto, {
          blockchain_wallet_id: 'w1',
          currency_type: 'sender',
          payment_method: 'transfers',
          token: 'USDB',
          request_amount: 50000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      try {
        await run(CreatePayinQuoteDto, {
          blockchain_wallet_id: 'w1',
          currency_type: 'sender',
          payment_method: 'transfers',
          token: 'USDB',
          request_amount: 50000,
        });
      } catch (err) {
        const body = (err as BadRequestException).getResponse() as {
          message: string | string[];
        };
        const messages = Array.isArray(body.message)
          ? body.message
          : [body.message];
        expect(
          messages.some((m) => m.includes('transfers_allowed_tax_id')),
        ).toBe(true);
        expect(JSON.stringify(body)).not.toContain('transfers_tax_id_required');
        expect(JSON.stringify(body)).not.toContain('blindpay');
      }
    });

    it('accepts transfers with transfers_allowed_tax_id', async () => {
      await expect(
        run(CreatePayinQuoteDto, {
          blockchain_wallet_id: 'w1',
          currency_type: 'sender',
          payment_method: 'transfers',
          token: 'USDB',
          request_amount: 50000,
          payer_rules: { transfers_allowed_tax_id: '20123456786' },
        }),
      ).resolves.toBeDefined();
    });

    it('rejects pse without identity and bank fields', async () => {
      await expect(
        run(CreatePayinQuoteDto, {
          blockchain_wallet_id: 'w1',
          currency_type: 'sender',
          payment_method: 'pse',
          token: 'USDB',
          request_amount: 50000,
          payer_rules: { pse_full_name: 'Jane Doe' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      try {
        await run(CreatePayinQuoteDto, {
          blockchain_wallet_id: 'w1',
          currency_type: 'sender',
          payment_method: 'pse',
          token: 'USDB',
          request_amount: 50000,
        });
      } catch (err) {
        const body = (err as BadRequestException).getResponse() as {
          message: string | string[];
        };
        const messages = Array.isArray(body.message)
          ? body.message
          : [body.message];
        expect(messages.some((m) => m.includes('pse_full_name'))).toBe(true);
        expect(JSON.stringify(body)).not.toContain('pse_requires');
        expect(JSON.stringify(body)).not.toContain('blindpay');
      }
    });

    it('accepts pse with all required payer_rules fields', async () => {
      await expect(
        run(CreatePayinQuoteDto, {
          blockchain_wallet_id: 'w1',
          currency_type: 'sender',
          payment_method: 'pse',
          token: 'USDB',
          request_amount: 50000,
          payer_rules: {
            pse_full_name: 'Jane Doe',
            pse_document_type: 'CC',
            pse_document_number: '123456789',
            pse_email: 'a@b.com',
            pse_bank_code: '9',
          },
        }),
      ).resolves.toBeDefined();
    });
  });
});
