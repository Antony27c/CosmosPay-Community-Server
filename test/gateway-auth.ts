import request from 'supertest';

/** Satisfies ApisixGuard + PermissionsGuard in e2e harness requests. */
export function withGatewayAuth(req: request.Test): request.Test {
  return req
    .set('x-gateway-secret', 'topsecret')
    .set('x-consumer-username', 'cosmos_u1')
    .set('x-consumer-role', 'admin');
}
