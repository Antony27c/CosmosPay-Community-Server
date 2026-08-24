import { ApiProperty } from '@nestjs/swagger';
import { SwapStatus } from '../../../generated/prisma/client';

/** One asset hop on the chosen path (empty array = direct order-book swap). */
export class SwapPathHop {
  @ApiProperty({ example: 'yXLM', description: 'Asset code, or "native".' })
  code!: string;

  @ApiProperty({
    nullable: true,
    example: 'GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55',
    description: 'Issuer for a non-native hop (null for native).',
  })
  issuer!: string | null;
}

/** An asset + amount pair used on both sides of a quote. */
export class SwapAssetAmount {
  @ApiProperty({ example: 'native', description: 'Asset code, or "native".' })
  asset!: string;

  @ApiProperty({ nullable: true, example: null })
  issuer!: string | null;

  @ApiProperty({ example: '100' })
  amount!: string;
}

/** The platform fee taken from the source asset. */
export class SwapFeeBreakdown {
  @ApiProperty({ example: 'native' })
  asset!: string;

  @ApiProperty({ nullable: true, example: null })
  issuer!: string | null;

  @ApiProperty({ example: '0.5' })
  amount!: string;

  @ApiProperty({ example: 50, description: 'Fee in basis points (50 = 0.5%).' })
  bps!: number;

  @ApiProperty({
    nullable: true,
    example: 'GBFEE...WALLET',
    description: 'Fee collector account (null when the fee is disabled).',
  })
  wallet!: string | null;

  @ApiProperty({
    example: 'Cosmos Swap Commission',
    description:
      'Human-readable commission label, mirrored as the on-chain MEMO_TEXT ' +
      'when the caller supplies no memo.',
  })
  label!: string;
}

/** The bought asset with its estimate and slippage-protected minimum. */
export class SwapDestinationQuote {
  @ApiProperty({ example: 'USDC' })
  asset!: string;

  @ApiProperty({
    nullable: true,
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTR6F3DSZL5A3W4G4M4N4A5U4QY3T6',
  })
  issuer!: string | null;

  @ApiProperty({
    example: '24.81',
    description: 'Quoted amount received for the routed (post-fee) input.',
  })
  estimated!: string;

  @ApiProperty({
    example: '24.68595',
    description:
      'On-chain minimum (destMin) after slippage — swap reverts below it.',
  })
  minimum!: string;

  @ApiProperty({ example: 50 })
  slippageBps!: number;
}

/** Response of `POST /v1/swaps/quote` — pricing only, nothing is persisted. */
export class SwapQuoteEntity {
  @ApiProperty({ example: 'testnet' })
  network!: string;

  @ApiProperty({ type: SwapAssetAmount, description: 'Gross source input.' })
  source!: SwapAssetAmount;

  @ApiProperty({ type: SwapFeeBreakdown })
  fee!: SwapFeeBreakdown;

  @ApiProperty({
    type: SwapAssetAmount,
    description: 'Net amount routed (input − fee).',
  })
  swap!: SwapAssetAmount;

  @ApiProperty({ type: SwapDestinationQuote })
  destination!: SwapDestinationQuote;

  @ApiProperty({
    type: [SwapPathHop],
    description: 'Intermediate hops (may be empty).',
  })
  path!: SwapPathHop[];
}

/** A persisted swap (the `swap` table row) plus its derived QR. */
export class SwapEntity {
  @ApiProperty({ example: 'clx9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ enum: SwapStatus, example: 'PENDING' })
  status!: SwapStatus;

  @ApiProperty({ example: 'testnet' })
  network!: string;

  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  source!: string;

  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  destination!: string;

  @ApiProperty({ example: 'native' })
  sendAsset!: string;

  @ApiProperty({ nullable: true, example: null })
  sendAssetIssuer!: string | null;

  @ApiProperty({ example: '100', description: 'Gross source amount.' })
  sendAmount!: string;

  @ApiProperty({ example: '0.5' })
  feeAmount!: string;

  @ApiProperty({ example: 50 })
  feeBps!: number;

  @ApiProperty({
    example: '99.5',
    description: 'Amount routed through the DEX/AMM.',
  })
  swapAmount!: string;

  @ApiProperty({ example: 'USDC' })
  destAsset!: string;

  @ApiProperty({
    nullable: true,
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTR6F3DSZL5A3W4G4M4N4A5U4QY3T6',
  })
  destAssetIssuer!: string | null;

  @ApiProperty({ example: '24.81' })
  destEstimated!: string;

  @ApiProperty({ example: '24.68595' })
  destMin!: string;

  @ApiProperty({ example: 50 })
  slippageBps!: number;

  @ApiProperty({ type: [SwapPathHop] })
  path!: SwapPathHop[];

  @ApiProperty({ nullable: true, example: null })
  memo!: string | null;

  @ApiProperty({
    nullable: true,
    required: false,
    example: 'swap-retry-2026-08-23-001',
    description:
      'Client idempotency key when supplied via Idempotency-Key / body (null otherwise).',
  })
  idempotencyKey?: string | null;

  @ApiProperty({
    nullable: true,
    example: 'Cosmos Swap Commission',
    description:
      'On-chain MEMO_TEXT label stamped when a commission is collected and no ' +
      'caller memo was supplied (null otherwise).',
  })
  commissionMemo!: string | null;

  @ApiProperty({
    description: 'Unsigned transaction envelope (base64 XDR) to sign.',
    example: 'AAAAAgAAAABx…(base64 XDR)…AAAAAAAAAAA=',
  })
  xdr!: string;

  @ApiProperty({ example: 'web+stellar:tx?xdr=AAAAAgAAAABx…' })
  uri!: string;

  @ApiProperty({
    description: 'Deterministic transaction hash (verified on submit).',
    example: '3389e9f0...64hex',
  })
  txHash!: string;

  @ApiProperty({ example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA…' })
  qr!: string;

  @ApiProperty({ example: '2026-06-29T12:34:56.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-06-29T12:34:56.000Z' })
  updatedAt!: Date;
}

export class SwapListEntity {
  @ApiProperty({ type: [SwapEntity] })
  data!: SwapEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

/** Result of `POST /v1/swaps/:id/submit`. */
export class SwapSubmitResultEntity {
  @ApiProperty({ example: true })
  submitted!: boolean;

  @ApiProperty({ enum: SwapStatus, example: 'SUCCEEDED' })
  status!: SwapStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    example: '3389e9f0...64hex',
    description: 'The on-chain transaction hash once submitted.',
  })
  txHash?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    example: null,
    description: 'Why submission failed, when `submitted` is false.',
  })
  reason?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    type: [String],
    example: ['op_under_dest_min'],
    description: 'Horizon transaction/operation result codes on a rejection.',
  })
  resultCodes?: string[];

  @ApiProperty({ type: SwapEntity })
  swap!: SwapEntity;
}
