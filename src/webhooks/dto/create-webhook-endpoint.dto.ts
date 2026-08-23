import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { WebhookEventType } from '../../../generated/prisma/client';

export class CreateWebhookEndpointDto {
  @ApiProperty({
    description: 'HTTPS URL that will receive POSTed event notifications.',
    example: 'https://integrator.example.com/webhooks/cosmos',
  })
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['https'],
  })
  url!: string;

  @ApiPropertyOptional({ example: 'Production payment events' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({
    enum: WebhookEventType,
    isArray: true,
    description:
      'Event types to subscribe to. Omit/empty to receive all events.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(WebhookEventType, { each: true })
  eventTypes?: WebhookEventType[];
}
