-- Mark legacy endpoints that cannot pass public-destination checks after deploy.
-- The audit script (scripts/mark-blocked-webhook-endpoints.ts) sets
-- destinationBlocked=true and enabled=false for unsafe URLs already stored.
ALTER TABLE "webhook_endpoint" ADD COLUMN "destinationBlocked" BOOLEAN NOT NULL DEFAULT false;
