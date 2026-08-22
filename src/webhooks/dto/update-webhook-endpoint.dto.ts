import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { WebhookEventType } from '../../../generated/prisma/client';

export class UpdateWebhookEndpointDto {
  @ApiPropertyOptional({
    example: 'https://integrator.example.com/webhooks/cosmos',
  })
  @IsOptional()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['https'],
  })
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({
    description: 'Pause/resume deliveries to this endpoint.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: WebhookEventType, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(WebhookEventType, { each: true })
  eventTypes?: WebhookEventType[];
}
