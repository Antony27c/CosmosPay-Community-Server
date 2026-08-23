/**
 * Identity forwarded by APISIX after a successful `key-auth` validation.
 * Attached to the request by ApisixContextMiddleware and enforced by ApisixGuard.
 */
export interface GatewayConsumer {
  /** APISIX consumer username, e.g. `cosmos_<userId>` (X-Consumer-Username). */
  username: string;
  /** Credential id that authenticated, e.g. `cosmos_<uuid>` (X-Credential-Identifier). */
  credentialId: string | null;
  /**
   * API key environment forwarded by the gateway (derived from the key prefix:
   * `dv_` → 'dev', `prod_` → 'prod'). Determines the Stellar network the intent
   * targets. Null when not forwarded (local dev without the gateway).
   */
  environment: 'dev' | 'prod' | null;
  /**
   * Role of the authenticating API key (X-Consumer-Role). `admin` keys bypass
   * per-action permission checks; `user` keys are restricted to their granted
   * `permissions`. Null when not forwarded.
   */
  role: 'admin' | 'user' | null;
  /**
   * Scopes granted to the API key (X-Consumer-Permissions), e.g. `['read','write']`.
   * Enforced by PermissionsGuard. Empty when none granted / not forwarded.
   */
  permissions: string[];
  /**
   * The organization the API key belongs to (X-Consumer-Org). Forwarded by the
   * gateway; the client cannot set it. Swaps are attributed to it and its plan
   * dictates the swap commission. Null when not forwarded (local dev).
   */
  organizationId: string | null;
  /**
   * The organization's plan tier (X-Consumer-Plan), e.g. `free` / `pro`. Forwarded
   * by the gateway for attribution/logging. Null when not forwarded.
   */
  plan: string | null;
  /**
   * The swap commission (basis points) for the organization's plan
   * (X-Plan-Swap-Fee-Bps). Forwarded by the gateway and derived server-side from
   * the org's plan — it is NEVER a request parameter, so the rate cannot be
   * bypassed. Null when not forwarded (local dev falls back to STELLAR_SWAP_FEE_BPS).
   */
  planSwapFeeBps: number | null;
}

declare module 'express' {
  // Augment Express' Request so the rest of the app can read req.gatewayConsumer
  // and (for platform-admin routes) req.adminPrincipal.
  interface Request {
    gatewayConsumer?: GatewayConsumer;
    adminPrincipal?: import('../../admin/admin-auth').AdminPrincipal;
  }
}
