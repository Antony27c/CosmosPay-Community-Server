import { ApiProperty } from '@nestjs/swagger';
import {
  PaymentIntentKind,
  PaymentIntentStatus,
} from '../../../generated/prisma/client';

/**
 * Response shape for a payment intent. Annotated with examples so the generated
 * OpenAPI/Swagger shows a concrete sample response (not just an empty body).
 */
export class PaymentIntentEntity {
  @ApiProperty({ example: 'clx9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ enum: PaymentIntentKind, example: 'TX' })
  kind!: PaymentIntentKind;

  @ApiProperty({ enum: PaymentIntentStatus, example: 'PENDING' })
  status!: PaymentIntentStatus;

  @ApiProperty({ example: 'testnet' })
  network!: string;

  @ApiProperty({
    nullable: true,
    example: 'Greally…56charpublickey',
    description: 'Payer account (null for PAY intents).',
  })
  source!: string | null;

  @ApiProperty({ example: 'GASMERCHANT…56charpublickey' })
  destination!: string;

  @ApiProperty({ nullable: true, example: '25.5' })
  amount!: string | null;

  @ApiProperty({
    example: 'native',
    description: 'Asset code, or "native" for XLM.',
  })
  asset!: string;

  @ApiProperty({ nullable: true, example: null })
  assetIssuer!: string | null;

  @ApiProperty({
    example: '123456789',
    description: 'Mandatory MEMO_ID (auto-generated if not provided).',
  })
  memo!: string;

  @ApiProperty({ nullable: true, example: null, description: 'SEP-7 msg.' })
  msg!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'SEP-7 callback.',
  })
  callback!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Unsigned transaction envelope (null for PAY intents).',
    example: 'AAAAAgAAAABx…(base64 XDR)…AAAAAAAAAAA=',
  })
  xdr!: string | null;

  @ApiProperty({
    description:
      'SEP-7 deep link (`tx` for TX intents, `pay` for PAY intents).',
    example: 'web+stellar:tx?xdr=AAAAAgAAAABx…',
  })
  uri!: string;

  @ApiProperty({
    description: 'QR code of the SEP-7 URI (PNG data URL), derived on read.',
    example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA…',
  })
  qr!: string;

  @ApiProperty({ nullable: true, example: null })
  txHash!: string | null;

  @ApiProperty({ nullable: true, example: null })
  reference!: string | null;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' })
  updatedAt!: Date;
}

/** Creation response for a SEP-7 `tx` intent (always has source + xdr). */
export class TxPaymentIntentEntity {
  @ApiProperty({ example: 'clx9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ enum: PaymentIntentKind, example: 'TX' })
  kind!: PaymentIntentKind;

  @ApiProperty({ enum: PaymentIntentStatus, example: 'PENDING' })
  status!: PaymentIntentStatus;

  @ApiProperty({ example: 'testnet' })
  network!: string;

  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  source!: string;

  @ApiProperty({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
  })
  destination!: string;

  @ApiProperty({ example: '120.1234567' })
  amount!: string;

  @ApiProperty({ example: 'native' })
  asset!: string;

  @ApiProperty({ nullable: true, example: null })
  assetIssuer!: string | null;

  @ApiProperty({ example: '123456789', description: 'Mandatory MEMO_ID.' })
  memo!: string;

  @ApiProperty({ nullable: true, example: 'Order #24' })
  msg!: string | null;

  @ApiProperty({ nullable: true, example: null })
  callback!: string | null;

  @ApiProperty({
    description: 'Unsigned transaction envelope (base64 XDR).',
    example: 'AAAAAgAAAABx…(base64 XDR)…AAAAAAAAAAA=',
  })
  xdr!: string;

  @ApiProperty({ example: 'web+stellar:tx?xdr=AAAAAgAAAABx…' })
  uri!: string;

  @ApiProperty({ example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA…' })
  qr!: string;

  @ApiProperty({ nullable: true, example: null })
  txHash!: string | null;

  @ApiProperty({ nullable: true, example: null })
  reference!: string | null;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' })
  updatedAt!: Date;
}

/** Creation response for a SEP-7 `pay` intent (no source, no xdr). */
export class PayPaymentIntentEntity {
  @ApiProperty({ example: 'clx9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ enum: PaymentIntentKind, example: 'PAY' })
  kind!: PaymentIntentKind;

  @ApiProperty({ enum: PaymentIntentStatus, example: 'PENDING' })
  status!: PaymentIntentStatus;

  @ApiProperty({ example: 'testnet' })
  network!: string;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Always null for PAY.',
  })
  source!: string | null;

  @ApiProperty({
    example: 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO',
  })
  destination!: string;

  @ApiProperty({ nullable: true, example: '120.1234567' })
  amount!: string | null;

  @ApiProperty({ example: 'native' })
  asset!: string;

  @ApiProperty({ nullable: true, example: null })
  assetIssuer!: string | null;

  @ApiProperty({ example: '123456789', description: 'Mandatory MEMO_ID.' })
  memo!: string;

  @ApiProperty({ nullable: true, example: 'pay me with lumens' })
  msg!: string | null;

  @ApiProperty({ nullable: true, example: null })
  callback!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'Always null for PAY.',
  })
  xdr!: string | null;

  @ApiProperty({
    example:
      'web+stellar:pay?destination=GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO&amount=120.1234567',
  })
  uri!: string;

  @ApiProperty({ example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA…' })
  qr!: string;

  @ApiProperty({ nullable: true, example: null })
  txHash!: string | null;

  @ApiProperty({ nullable: true, example: null })
  reference!: string | null;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-06-21T12:34:56.000Z' })
  updatedAt!: Date;
}

export class PaymentIntentListEntity {
  @ApiProperty({ type: [PaymentIntentEntity] })
  data!: PaymentIntentEntity[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 20 })
  take!: number;

  @ApiProperty({ example: 0 })
  skip!: number;
}

export class ValidationOutcomeEntity {
  @ApiProperty({ example: true })
  valid!: boolean;

  @ApiProperty({ enum: PaymentIntentStatus, example: 'SUCCEEDED' })
  status!: PaymentIntentStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    example: null,
    description: 'Why validation failed, when `valid` is false.',
  })
  reason?: string;

  @ApiProperty({ type: PaymentIntentEntity, required: false })
  paymentIntent?: PaymentIntentEntity;
}

export class DeletedEntity {
  @ApiProperty({ example: 'clx9z8a1b0000abcd1234efgh' })
  id!: string;

  @ApiProperty({ example: true })
  deleted!: boolean;
}

export class PaymentIntentTransitionEntity {
  @ApiProperty({ example: 'clxtransition0001' })
  id!: string;

  @ApiProperty({ example: 'clx9z8a1b0000abcd1234efgh' })
  intentId!: string;

  @ApiProperty({ enum: PaymentIntentStatus, example: 'PENDING' })
  fromStatus!: PaymentIntentStatus;

  @ApiProperty({ enum: PaymentIntentStatus, example: 'SUBMITTED' })
  toStatus!: PaymentIntentStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    example: '3389e9f0…',
  })
  txHash!: string | null;

  @ApiProperty({ example: 'api', description: 'api | validate | observer | system' })
  actor!: string;

  @ApiProperty({ required: false, nullable: true })
  reason!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class PaymentIntentTransitionListEntity {
  @ApiProperty({ type: [PaymentIntentTransitionEntity] })
  // Returned as a bare array from the controller; Swagger documents the item shape.
  data!: PaymentIntentTransitionEntity[];
}
