import { NotFoundException } from '@nestjs/common';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { ProductsService } from './products.service';
import { QueryProductsDto } from './dto/query-products.dto';

const consumer: GatewayConsumer = {
  username: 'cosmos_u1',
  credentialId: 'cred_1',
  environment: 'dev',
  role: 'user',
  permissions: ['products:read', 'products:write'],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
};

function build() {
  const localConsumer = { id: 'c_1', apisixUsername: consumer.username };
  const prisma = {
    consumer: {
      upsert: jest.fn().mockResolvedValue(localConsumer),
    },
    product: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const service = new ProductsService(prisma as any);
  return { service, prisma, localConsumer };
}

describe('ProductsService', () => {
  describe('findAll', () => {
    it('paginates with take/skip and returns the real total', async () => {
      const { service, prisma, localConsumer } = build();
      const page = [
        { id: 'p1', name: 'A' },
        { id: 'p2', name: 'B' },
      ];
      prisma.product.findMany.mockResolvedValue(page);
      prisma.product.count.mockResolvedValue(5);

      const query = Object.assign(new QueryProductsDto(), {
        take: 2,
        skip: 0,
      });
      const result = await service.findAll(consumer, query);

      expect(result).toEqual({ data: page, total: 5, take: 2, skip: 0 });
      expect(prisma.product.findMany).toHaveBeenCalledWith({
        where: { consumerId: localConsumer.id },
        take: 2,
        skip: 0,
        orderBy: { createdAt: 'desc' },
      });
      expect(prisma.product.count).toHaveBeenCalledWith({
        where: { consumerId: localConsumer.id },
      });
    });

    it('filters by reference when provided', async () => {
      const { service, prisma, localConsumer } = build();
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      const query = Object.assign(new QueryProductsDto(), {
        reference: 'sku_pro_monthly',
      });
      await service.findAll(consumer, query);

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            consumerId: localConsumer.id,
            reference: 'sku_pro_monthly',
          },
        }),
      );
    });

    it('filters by active and kind when provided', async () => {
      const { service, prisma, localConsumer } = build();
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      const query = Object.assign(new QueryProductsDto(), {
        active: false,
        kind: 'recurring',
      });
      await service.findAll(consumer, query);

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            consumerId: localConsumer.id,
            active: false,
            kind: 'recurring',
          },
        }),
      );
    });

    it('returns active and inactive when active is omitted', async () => {
      const { service, prisma, localConsumer } = build();
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findAll(consumer, new QueryProductsDto());

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { consumerId: localConsumer.id },
        }),
      );
    });
  });

  describe('remove', () => {
    it('soft-deletes by setting active=false by default', async () => {
      const { service, prisma } = build();
      prisma.product.findFirst.mockResolvedValue({
        id: 'p1',
        consumerId: 'c_1',
        active: true,
      });
      prisma.product.update.mockResolvedValue({ id: 'p1', active: false });

      const result = await service.remove(consumer, 'p1');

      expect(result).toEqual({ id: 'p1', deleted: true });
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { active: false },
      });
      expect(prisma.product.delete).not.toHaveBeenCalled();
    });

    it('hard-deletes when hard=true', async () => {
      const { service, prisma } = build();
      prisma.product.findFirst.mockResolvedValue({
        id: 'p1',
        consumerId: 'c_1',
        active: true,
      });
      prisma.product.delete.mockResolvedValue({ id: 'p1' });

      const result = await service.remove(consumer, 'p1', true);

      expect(result).toEqual({ id: 'p1', deleted: true });
      expect(prisma.product.delete).toHaveBeenCalledWith({
        where: { id: 'p1' },
      });
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the product is missing', async () => {
      const { service, prisma } = build();
      prisma.product.findFirst.mockResolvedValue(null);

      await expect(service.remove(consumer, 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
