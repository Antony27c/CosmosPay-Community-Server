// Runs before any module (and thus before ConfigModule's env validation) loads.
process.env.APISIX_GATEWAY_SECRET = 'topsecret';
process.env.DATABASE_URL = 'postgresql://x:x@localhost:5432/x';
process.env.NODE_ENV = 'test';
// Keep the on-chain observer off during tests (no Horizon polling).
process.env.OBSERVER_ENABLED = 'false';
// Platform-admin credentials for issue #34 auth suites.
process.env.ADMIN_API_CREDENTIALS = JSON.stringify([
  { id: 'viewer', secret: 'read-secret-000000', role: 'read' },
  { id: 'owner', secret: 'write-secret-00000', role: 'write' },
]);
