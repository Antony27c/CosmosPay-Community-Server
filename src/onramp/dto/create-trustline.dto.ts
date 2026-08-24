import { ApiProperty } from '@nestjs/swagger';
import { IsStellarAddress } from '../../common/validators/is-stellar-address.validator';

/**
 * Builds an unsigned Stellar trustline transaction so a wallet can hold the
 * stablecoin before an onramp. Returns an XDR for the customer to sign — the
 * service never signs.
 */
export class CreateTrustlineDto {
  @ApiProperty({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
    description: 'Stellar address that needs the asset trustline.',
  })
  @IsStellarAddress()
  address!: string;
}
