import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '../common/decorators/current-consumer.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { CreateProductDto } from './dto/create-product.dto';
import {
  QueryDeleteProductDto,
  QueryProductsDto,
} from './dto/query-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductListEntity } from './entities/product-list.entity';
import { ProductDeletedEntity, ProductEntity } from './entities/product.entity';
import { ProductsService } from './products.service';

// URI versioning => /v1/products
@ApiTags('products')
@Controller({ path: 'products', version: '1' })
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post()
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Create a product' })
  @ApiCreatedResponse({ type: ProductEntity })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateProductDto,
  ) {
    return this.products.create(consumer, dto);
  }

  @Get()
  @RequirePermissions('products:read')
  @ApiOperation({ summary: "List the consumer's products" })
  @ApiOkResponse({ type: ProductListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryProductsDto,
  ) {
    return this.products.findAll(consumer, query);
  }

  @Get(':id')
  @RequirePermissions('products:read')
  @ApiOperation({ summary: 'Get a product by id' })
  @ApiOkResponse({ type: ProductEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.products.findOne(consumer, id);
  }

  @Patch(':id')
  @RequirePermissions('products:write')
  @ApiOperation({ summary: 'Update a product' })
  @ApiOkResponse({ type: ProductEntity })
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(consumer, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('products:write')
  @ApiOperation({
    summary:
      'Soft-delete a product (active=false). Pass ?hard=true to permanently delete.',
  })
  @ApiOkResponse({ type: ProductDeletedEntity })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Query() query: QueryDeleteProductDto,
  ) {
    return this.products.remove(consumer, id, query.hard === true);
  }
}
