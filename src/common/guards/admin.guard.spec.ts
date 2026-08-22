import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminGuard } from './admin.guard';
import { ADMIN_ROLE_KEY } from '../decorators/require-admin-role.decorator';

/**
 * Red suite for issue #34: AdminGuard must verify a real Bearer credential
 * and enforce read vs write. The legacy `X-Cosmos-Admin: 1` marker must NOT grant access.
 */
describe('AdminGuard (issue #34)', () => {
  const readSecret = 'read-secret-000000';
  const writeSecret = 'write-secret-00000';

  const config = {
    get: () => ({
      credentials: [
        { id: 'viewer', secret: readSecret, role: 'read' },
        { id: 'owner', secret: writeSecret, role: 'write' },
      ],
    }),
  } as any;

  function ctx(headers: Record<string, string>, requiredRole?: 'read' | 'write') {
    const request: any = { headers, adminPrincipal: undefined };
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === ADMIN_ROLE_KEY ? requiredRole : undefined,
    } as unknown as Reflector;
    const guard = new AdminGuard(config, reflector);
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    return { guard, request, context };
  }

  it('rejects the legacy plaintext X-Cosmos-Admin: 1 marker with 401', () => {
    const { guard, context } = ctx({ 'x-cosmos-admin': '1' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('returns 401 when Authorization Bearer is missing', () => {
    const { guard, context } = ctx({});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('returns 401 when the Bearer secret is wrong', () => {
    const { guard, context } = ctx({
      authorization: 'Bearer totally-wrong-secret!!',
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('allows a read credential on a read endpoint and attaches the principal', () => {
    const { guard, context, request } = ctx(
      { authorization: `Bearer ${readSecret}` },
      'read',
    );
    expect(guard.canActivate(context)).toBe(true);
    expect(request.adminPrincipal).toEqual({ id: 'viewer', role: 'read' });
  });

  it('returns 403 when a read credential hits a write endpoint', () => {
    const { guard, context } = ctx(
      { authorization: `Bearer ${readSecret}` },
      'write',
    );
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows a write credential on a write endpoint', () => {
    const { guard, context, request } = ctx(
      { authorization: `Bearer ${writeSecret}` },
      'write',
    );
    expect(guard.canActivate(context)).toBe(true);
    expect(request.adminPrincipal).toEqual({ id: 'owner', role: 'write' });
  });
});
