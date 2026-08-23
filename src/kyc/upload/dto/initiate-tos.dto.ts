import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { IsRedirectUrl } from '../../../common/validators/is-redirect-url.validator';

/**
 * Starts BlindPay's terms-of-service acceptance flow. Returns a hosted URL the
 * end user must visit and accept; BlindPay then redirects to `redirect_url` with
 * a `tos_id` query param, which you pass to `POST /v1/kyc/receivers`. A receiver
 * cannot be created without a `tos_id`, so this is the first step of KYC.
 */
export class InitiateTosDto {
  @ApiProperty({
    example: 'https://yourapp.com/kyc/return',
    description:
      'Where BlindPay redirects after acceptance (gets ?tos_id=...). Must be https and on the consumer allow-list.',
  })
  @IsRedirectUrl()
  redirect_url!: string;

  @ApiPropertyOptional({
    description: 'Existing receiver to (re)accept updated terms for.',
  })
  @IsOptional()
  @IsString()
  receiver_id?: string;

  @ApiPropertyOptional({
    description: 'UUID for idempotency. Auto-generated when omitted.',
  })
  @IsOptional()
  @IsUUID()
  idempotency_key?: string;
}
