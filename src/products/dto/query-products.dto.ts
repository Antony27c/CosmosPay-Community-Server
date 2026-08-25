import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Coerce query-string "true"/"false" into real booleans. */
function toOptionalBoolean({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}

export class QueryProductsDto {
  @ApiPropertyOptional({ enum: ['recurring', 'one_time', 'link'] })
  @IsOptional()
  @IsIn(['recurring', 'one_time', 'link'])
  kind?: string;

  @ApiPropertyOptional({
    description:
      'Filter by active flag. Omit to return both active and inactive.',
  })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ example: 'sku_pro_monthly' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take: number = 20;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}

export class QueryDeleteProductDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'If true, permanently delete the row. Default soft-deletes (active=false).',
  })
  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  hard?: boolean;
}
