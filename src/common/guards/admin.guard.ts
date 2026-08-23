import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  roleSatisfies,
  verifyAdminBearer,
  type AdminRole,
} from '../../admin/admin-auth';
import { AppConfig } from '../../config/configuration';
import { ADMIN_ROLE_KEY } from '../decorators/require-admin-role.decorator';

/**
 * Platform-admin gate (issue #34).
 *
 * ApisixGuard already proved the request came through the gateway. This guard
 * additionally requires a real admin Bearer credential configured in
 * `ADMIN_API_CREDENTIALS` — the legacy plaintext `X-Cosmos-Admin: 1` marker is
 * no longer accepted. Role checks (`@RequireAdminRole`) distinguish read from
 * write so viewers cannot mutate.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const { credentials } = this.config.get('admin', { infer: true });

    const rawAuth = request.headers.authorization;
    const authorization = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
    const principal = verifyAdminBearer(authorization, credentials);
    if (!principal) {
      throw new UnauthorizedException('Valid admin credentials required');
    }

    request.adminPrincipal = principal;

    const required =
      this.reflector.getAllAndOverride<AdminRole | undefined>(ADMIN_ROLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'read';

    if (!roleSatisfies(principal.role, required)) {
      throw new ForbiddenException(
        `Admin role '${required}' required (have '${principal.role}')`,
      );
    }

    return true;
  }
}
