# Tasks: kyc-redirect-url-whitelist

- [x] Spec / design artifacts
- [x] RED: `IsRedirectUrl` unit tests
- [x] GREEN: `is-redirect-url.validator.ts`
- [x] RED: whitelist parse/assert unit tests (allowed, denied domain, missing consumer)
- [x] GREEN: `redirect-url-whitelist.ts`
- [x] Wire `KYC_REDIRECT_URL_WHITELIST` into `AppConfig` + env validation + `.env.example`
- [x] Apply `@IsRedirectUrl()` on `InitiateTosDto`, `ApproveReceiverDto`, `RequestTosDto`
- [x] Enforce whitelist in `ReceiversService` + `KycMetaService` (with `@CurrentConsumer` on initiate ToS)
- [x] Unit tests green (11)
- [ ] Commit + PR (`Closes #33`) — awaiting user confirmation
