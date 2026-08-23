import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { BlindpayClient, UploadableFile } from '../../blindpay/blindpay.client';
import { BlindpayObject } from '../../blindpay/blindpay-sync.service';
import { UPLOAD_BUCKETS } from '../../blindpay/blindpay.constants';
import { InitiateTosDto } from './dto/initiate-tos.dto';
import type { AppConfig } from '../../config/configuration';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { assertRedirectAllowed } from '../redirect-url-whitelist';

/**
 * Compliance helpers that aren't tied to a single receiver: document upload and
 * rail discovery. These proxy BlindPay directly (upload + the `/available/*`
 * catalog) and persist nothing.
 */
@Injectable()
export class KycMetaService {
  constructor(
    private readonly blindpay: BlindpayClient,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Uploads a KYC document and returns its `file_url`, which the caller then
   * passes into the receiver's `*_file` fields.
   */
  uploadDocument(
    file: UploadableFile | undefined,
    bucket: string | undefined,
  ): Promise<{ file_url: string }> {
    if (!file) {
      throw new BadRequestException(
        'A file is required (multipart field "file")',
      );
    }
    const target = bucket ?? 'onboarding';
    if (!(UPLOAD_BUCKETS as readonly string[]).includes(target)) {
      throw new BadRequestException(
        `bucket must be one of: ${UPLOAD_BUCKETS.join(', ')}`,
      );
    }
    return this.blindpay.uploadFile(file, target);
  }

  /**
   * Starts the terms-of-service acceptance flow and returns the hosted URL the
   * end user must visit. BlindPay redirects to `redirect_url` with a `tos_id`
   * query param afterwards — required to create a receiver. This route lives at
   * `/e/instances/{id}/tos`, outside the normal instance path.
   */
  initiateTos(
    consumer: GatewayConsumer,
    dto: InitiateTosDto,
  ): Promise<{ url: string }> {
    assertRedirectAllowed(
      consumer.username,
      dto.redirect_url,
      this.config.get('kyc', { infer: true }).redirectUrlWhitelist,
    );
    return this.blindpay.post<{ url: string }>(
      `/e/instances/${this.blindpay.instanceId}/tos`,
      {
        idempotency_key: dto.idempotency_key ?? randomUUID(),
        receiver_id: dto.receiver_id ?? null,
        redirect_url: dto.redirect_url,
      },
    );
  }

  /** Lists the bank rails available for the platform instance. */
  listRails(): Promise<BlindpayObject> {
    return this.blindpay.get<BlindpayObject>('/available/rails');
  }

  /** Returns the field schema a given rail requires. */
  bankDetails(rail: string): Promise<BlindpayObject> {
    return this.blindpay.get<BlindpayObject>('/available/bank-details', {
      query: { rail },
    });
  }
}
