-- Overlapping webhook secret rotation: keep the previous HMAC secret for a
-- configurable grace window so integrators can deploy the new secret without
-- dropping deliveries. previousSecret is nulled after expiry.
ALTER TABLE "webhook_endpoint" ADD COLUMN "previousSecret" TEXT;
ALTER TABLE "webhook_endpoint" ADD COLUMN "previousSecretExpiresAt" TIMESTAMP(3);
