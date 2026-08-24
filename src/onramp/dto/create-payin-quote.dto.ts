import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  BLINDPAY_TOKENS,
  CURRENCY_TYPES,
  PAYIN_METHODS,
  type BlindpayToken,
  type CurrencyType,
  type PayinMethod,
} from '../../blindpay/blindpay.constants';
import { PayerRulesMatchPaymentMethod } from '../../common/validators/payer-rules-match-payment-method.validator';

/**
 * Payer constraints / details some payin methods require. Argentina Transfers
 * needs the payer's CUIT/CUIL (`transfers_allowed_tax_id`); Colombia PSE needs
 * the payer's identity + bank. Verified live: without these, the quote/payin is
 * rejected with `transfers_tax_id_required` / `pse_requires_...`.
 */
export class PayerRulesDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pix_allowed_tax_ids?: string[];

  @ApiPropertyOptional({
    example: '20123456786',
    description: 'Argentine payer CUIT/CUIL (Transfers 3.0).',
  })
  @IsOptional()
  @IsString()
  transfers_allowed_tax_id?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pse_allowed_tax_ids?: string[];

  @ApiPropertyOptional({ example: 'Jane Doe' })
  @IsOptional()
  @IsString()
  pse_full_name?: string;

  @ApiPropertyOptional({ example: 'CC', description: 'CC | NIT' })
  @IsOptional()
  @IsIn(['CC', 'NIT'])
  pse_document_type?: 'CC' | 'NIT';

  @ApiPropertyOptional({ example: '123456789' })
  @IsOptional()
  @IsString()
  pse_document_number?: string;

  @ApiPropertyOptional({ example: 'jane@acme.com' })
  @IsOptional()
  @IsString()
  pse_email?: string;

  @ApiPropertyOptional({ example: '+573001234567' })
  @IsOptional()
  @IsString()
  pse_phone?: string;

  @ApiPropertyOptional({ example: '9' })
  @IsOptional()
  @IsString()
  pse_bank_code?: string;
}

/**
 * Prices an onramp (fiat -> stablecoin). The resulting quote expires in ~5
 * minutes; create the payin from it before then. Amounts are integers in minor
 * units (e.g. $123.45 -> 12345).
 */
@PayerRulesMatchPaymentMethod()
export class CreatePayinQuoteDto {
  @ApiProperty({
    example: 'clz9xwallet001',
    description:
      'Cosmos Pay wallet id (from POST /v1/kyc/receivers/:id/wallets) that receives the minted stablecoin.',
  })
  @IsString()
  blockchain_wallet_id!: string;

  @ApiProperty({ enum: CURRENCY_TYPES, example: 'sender' })
  @IsIn(CURRENCY_TYPES)
  currency_type!: CurrencyType;

  @ApiProperty({
    enum: PAYIN_METHODS,
    example: 'pix',
    description:
      'Fiat-in method. Note: payins use `spei`/`transfers`/`pse` (not the `_bitso` payout rails).',
  })
  @IsIn(PAYIN_METHODS)
  payment_method!: PayinMethod;

  @ApiProperty({ enum: BLINDPAY_TOKENS, example: 'USDC' })
  @IsIn(BLINDPAY_TOKENS)
  token!: BlindpayToken;

  @ApiProperty({
    example: 10000,
    description: 'Amount in minor units (integer).',
  })
  @IsInt()
  @Min(1)
  request_amount!: number;

  @ApiPropertyOptional({
    example: false,
    description: 'When true, the sender absorbs the fees.',
  })
  @IsOptional()
  @IsBoolean()
  cover_fees?: boolean;

  @ApiPropertyOptional({
    type: PayerRulesDto,
    description:
      'Required for Transfers (AR): transfers_allowed_tax_id. Required for PSE (CO): pse_full_name, pse_document_type, pse_document_number, pse_email, pse_bank_code. Optional for other methods (e.g. pix).',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PayerRulesDto)
  payer_rules?: PayerRulesDto;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  is_otc?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  partner_fee_id?: string;

  @ApiPropertyOptional({ description: 'Optional custodial wallet id.' })
  @IsOptional()
  @IsString()
  wallet_id?: string;
}
