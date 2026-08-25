import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class RotateWebhookSecretDto {
  @ApiPropertyOptional({
    description:
      'Overlap window in seconds during which deliveries are signed with both the new and previous secrets. Defaults to WEBHOOK_SECRET_GRACE_SECONDS. Pass 0 to revoke the previous secret immediately (confirmed leak). Cannot exceed the configured maximum.',
    example: 86400,
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  graceSeconds?: number;
}
