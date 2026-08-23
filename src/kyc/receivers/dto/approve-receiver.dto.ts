import { ApiProperty } from '@nestjs/swagger';
import { IsRedirectUrl } from '../../../common/validators/is-redirect-url.validator';

/**
 * Approves a `pending_review` receiver (our owner/admin review gate). The platform
 * has reviewed the uploaded KYC data; approving sends the customer BlindPay's
 * terms-of-service link and moves the receiver to `pending_user`. `redirect_url` is
 * where BlindPay returns the customer (with `?tos_id=...`) after they accept.
 */
export class ApproveReceiverDto {
  @ApiProperty({
    example: 'https://dev.cosmospay.lat/kyc/return/org/dev/clz9xreceiver01',
    description:
      'Where BlindPay redirects the customer after they accept the terms. Must be https and on the consumer allow-list.',
  })
  @IsRedirectUrl()
  redirect_url!: string;
}
