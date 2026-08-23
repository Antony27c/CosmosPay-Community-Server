import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentConsumer } from '../../common/decorators/current-consumer.decorator';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { UploadableFile } from '../../blindpay/blindpay.client';
import { KycMetaService } from './kyc-meta.service';
import { InitiateTosDto } from './dto/initiate-tos.dto';

// /v1/kyc — compliance helpers not scoped to a single receiver.
@ApiTags('kyc')
@Controller({ path: 'kyc', version: '1' })
export class KycMetaController {
  constructor(private readonly meta: KycMetaService) {}

  @Post('upload')
  @RequirePermissions('kyc:write')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a KYC document; returns its file_url' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        bucket: {
          type: 'string',
          enum: ['avatar', 'onboarding', 'limit_increase'],
        },
      },
      required: ['file'],
    },
  })
  upload(
    @UploadedFile() file: UploadableFile | undefined,
    @Body('bucket') bucket?: string,
  ) {
    return this.meta.uploadDocument(file, bucket);
  }

  @Post('terms-of-service')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary: 'Start ToS acceptance; returns the hosted URL (first KYC step)',
  })
  initiateTos(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: InitiateTosDto,
  ) {
    return this.meta.initiateTos(consumer, dto);
  }

  @Get('rails')
  @RequirePermissions('kyc:read')
  @ApiOperation({ summary: 'List available bank rails' })
  rails() {
    return this.meta.listRails();
  }

  @Get('bank-details')
  @RequirePermissions('kyc:read')
  @ApiOperation({ summary: 'Get the field schema required by a rail' })
  bankDetails(@Query('rail') rail?: string) {
    if (!rail) {
      throw new BadRequestException('Query param "rail" is required');
    }
    return this.meta.bankDetails(rail);
  }
}
