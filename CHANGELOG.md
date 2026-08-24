# Changelog

All notable changes to the Cosmos Pay Community Server are documented here.
Generated from [Conventional Commits](https://www.conventionalcommits.org) by [git-cliff](https://git-cliff.org).
## [0.0.8] - 2026-08-24

### Bug Fixes
- Add idempotency and unique txHash to prevent double SWAP_SUCCEEDED (4188907)
- Recover same-key races and mark Idempotency-Key optional in OpenAPI (4778f27)
- Unblock local receiver updates and KYC state transitions (91cb4f4)
- Demote pending_user to pending_review on post-approve edits (8a7f5ae)

## [0.0.7] - 2026-08-23

### Bug Fixes
- Fail fast on misconfigured env vars (#24) (9609260)
- Set swap fee wallet placeholder for openapi:generate (c8e7056)

### Miscellaneous
- Add issue #24 evidence reproducers (c0c2206)
- Sync generated spec after rebase (98d3da8)
- Revert to main spec (platform-neutral) (8798357)

## [0.0.6] - 2026-08-23

### Bug Fixes
- Validate redirect_url against per-consumer whitelist (4b6cfd3)
- Emit one terminal event when observer and submit race (95c26ed)
- Include settlement epoch in terminal event dedup key (0e0bcfc)

### Miscellaneous
- Sync redirect_url descriptions after KYC whitelist DTOs (e455b33)
- Regenerate OpenAPI specs (7d85c44)

## [0.0.5] - 2026-08-23

### Miscellaneous
- Bump the minor-and-patch group across 1 directory with 16 updates (bf54273)

## [0.0.4] - 2026-08-23

### Bug Fixes
- Guard submit/observer so liquidated ops stay SUCCEEDED (94f0f68)

## [0.0.3] - 2026-08-23

### Features
- Implement assertTransition against declared graph (6a55371)
- Single guarded transition with audit trail (4afd6b0)
- Replace plaintext marker with Bearer credentials and roles (1e58407)
- Append-only audit log for every mutating admin action (91f457f)

### Bug Fixes
- Sync contract and prevent drift (#37) (f279f62)
- Atomic mutation+audit transactions and credential warnings (b43d690)
- Restrict outbound delivery targets and disable redirects (ab97611)
- Actualizar overrides vencidos que bloquean el release (d6fca0e)
- Subir @nestjs/swagger en vez de forzar js-yaml por override (77ce263)

### Miscellaneous
- Sync destinationBlocked after main merge (9d282ae)

### Refactor
- Route transactional audit writes through shared helper (6a9d228)

### Documentation
- Tighten OpenAPI transitions response and evidence (1a9c4ec)

### Testing
- Add state-machine graph spec and red matrix suite (1f981f0)
- E2e guards for invalid transitions and history (28f79a9)
- Add auth spec and red AdminGuard suite for #34 (f00f2ac)
- E2e 401/403 matrix per mutator plus audit evidence (f2a140b)

## [0.0.2] - 2026-07-11

### CI/CD
- Add CI, Dependabot, versioning and git-cliff changelog automation (4a82917)
- Provide dummy DATABASE_URL so the CI build passes (fce513b)

### Dependencies
- Update dependencies to latest supported versions (2bfaaf9)


