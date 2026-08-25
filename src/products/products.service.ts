import { Injectable, NotFoundException } from '@nestjs/common';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mirror the APISIX consumer locally so products can be scoped to it. */
  private resolveConsumer(consumer: GatewayConsumer) {
    return this.prisma.consumer.upsert({
      where: { apisixUsername: consumer.username },
      create: {
        apisixUsername: consumer.username,
        credentialId: consumer.credentialId,
      },
      update: { credentialId: consumer.credentialId },
    });
  }

  /** Normalize the asset: no code (or XLM/native) → native lumens. */
  private resolveAsset(assetCode?: string): string {
    const code = assetCode?.trim();
    if (
      !code ||
      code.toLowerCase() === 'xlm' ||
      code.toLowerCase() === 'native'
    ) {
      return 'native';
    }
    return code;
  }

  async create(consumer: GatewayConsumer, dto: CreateProductDto) {
    const local = await this.resolveConsumer(consumer);
    return this.prisma.product.create({
      data: {
        consumerId: local.id,
        name: dto.name,
        description: dto.description ?? null,
        amount: dto.amount ?? null,
        asset: this.resolveAsset(dto.assetCode),
        kind: dto.kind ?? 'one_time',
        active: dto.active ?? true,
        reference: dto.reference ?? null,
      },
    });
  }

  async findAll(consumer: GatewayConsumer, query: QueryProductsDto) {
    const local = await this.resolveConsumer(consumer);
    const where = {
      consumerId: local.id,
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.reference !== undefined ? { reference: query.reference } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.product.count({ where }),
    ]);
    return { data, total, take: query.take, skip: query.skip };
  }

  async findOne(consumer: GatewayConsumer, id: string) {
    const local = await this.resolveConsumer(consumer);
    const product = await this.prisma.product.findFirst({
      where: { id, consumerId: local.id },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async update(consumer: GatewayConsumer, id: string, dto: UpdateProductDto) {
    // Ownership check (throws if it isn't this consumer's product).
    await this.findOne(consumer, id);
    return this.prisma.product.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
        ...(dto.assetCode !== undefined
          ? { asset: this.resolveAsset(dto.assetCode) }
          : {}),
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.reference !== undefined ? { reference: dto.reference } : {}),
      },
    });
  }

  /**
   * Soft-delete by default (`active: false`). Pass `hard: true` to remove the
   * row permanently.
   */
  async remove(consumer: GatewayConsumer, id: string, hard = false) {
    await this.findOne(consumer, id);
    if (hard) {
      await this.prisma.product.delete({ where: { id } });
    } else {
      await this.prisma.product.update({
        where: { id },
        data: { active: false },
      });
    }
    return { id, deleted: true };
  }
}
