import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import type { AdminPrincipal } from '../../admin/admin-auth';

/** The authenticated admin principal attached by {@link AdminGuard}. */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AdminPrincipal => {
    const request = ctx.switchToHttp().getRequest<Request>();
    if (!request.adminPrincipal) {
      throw new Error(
        'CurrentAdmin used without AdminGuard — adminPrincipal missing',
      );
    }
    return request.adminPrincipal;
  },
);
