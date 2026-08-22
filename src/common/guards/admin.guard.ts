import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppConfig } from '../../config/configuration';

/**
 * TEMP (TDD red): constructor accepts Config/Reflector for the new API, but
 * behaviour is still the legacy plaintext `X-Cosmos-Admin: 1` check so the
 * issue #34 suite fails until the green implementation lands.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    void this.config;
    void this.reflector;
    const request = context.switchToHttp().getRequest<Request>();
    const raw = request.headers['x-cosmos-admin'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value !== '1') {
      throw new ForbiddenException('Platform admin access required');
    }
    return true;
  }
}
