# Proposal: KYC redirect_url whitelist (issue #33)

## Problem
`redirect_url` in the KYC terms-of-service flow is accepted as a free string, enabling open redirects after BlindPay ToS acceptance.

## Solution
1. **`@IsRedirectUrl()`** — reusable `class-validator` decorator (https only, absolute URL, no embedded credentials), applied to every DTO with `redirect_url`.
2. **Per-consumer domain whitelist** — env `KYC_REDIRECT_URL_WHITELIST` JSON map `consumerUsername → domains[]`, enforced in service layer via pure `assertRedirectAllowed`.
3. Fail closed when a consumer has no configured domains (security default). Admin paths resolve the receiver's consumer username and enforce the same whitelist.

## Out of scope
Provider ToS flow changes.

## Success
- Disallowed domain / scheme → HTTP 400 with clear message
- All redirect_url entry points covered
- Unit tests: allowed, disallowed domain, disallowed scheme
- Whitelist configurable, not hardcoded
