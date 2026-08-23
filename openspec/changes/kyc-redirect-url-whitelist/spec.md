# Spec: KYC redirect_url whitelist

## Capability: Redirect URL format validation

### Scenario: Allowed https URL shape
- GIVEN a `redirect_url` that is an absolute `https` URL without userinfo
- WHEN the DTO is validated
- THEN validation succeeds

### Scenario: Disallowed scheme
- GIVEN a `redirect_url` with scheme `http` (or any non-https)
- WHEN the DTO is validated
- THEN validation fails with a clear message that https is required

### Scenario: Embedded credentials rejected
- GIVEN a `redirect_url` with `user:pass@` in the authority
- WHEN the DTO is validated
- THEN validation fails

## Capability: Per-consumer domain whitelist

### Scenario: Allowed domain
- GIVEN consumer `cosmos_acme` with whitelist `["app.acme.com"]`
- AND `redirect_url` host `app.acme.com`
- WHEN `assertRedirectAllowed` runs
- THEN it allows the URL

### Scenario: Disallowed domain
- GIVEN consumer `cosmos_acme` with whitelist `["app.acme.com"]`
- AND `redirect_url` host `evil.com`
- WHEN `assertRedirectAllowed` runs
- THEN it throws BadRequestException (400-class) with a clear message

### Scenario: No domains configured for consumer
- GIVEN consumer with no whitelist entry (or empty list)
- WHEN `assertRedirectAllowed` runs
- THEN it throws BadRequestException (fail closed)

### Scenario: Subdomain match
- GIVEN whitelist entry `acme.com`
- AND host `app.acme.com`
- WHEN matching runs
- THEN it is allowed (suffix match on domain labels)
- AND host `evilacme.com` is NOT allowed

## Capability: Coverage of entry points

### Scenario: All consumer-facing redirect_url inputs
- GIVEN `InitiateTosDto`, `ApproveReceiverDto`, `RequestTosDto`
- WHEN requests hit the corresponding endpoints
- THEN format validation runs via ValidationPipe
- AND domain whitelist runs in the service with the calling consumer (or receiver's consumer for admin)

## Non-goals
- Changing BlindPay ToS hosting or redirect behavior
