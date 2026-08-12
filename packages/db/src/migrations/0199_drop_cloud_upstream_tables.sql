-- Fork keeps the cloud upstream tables (cloud_upstream_connections,
-- cloud_upstream_runs) for the cloud-upstreams feature. Upstream dropped
-- them in favor of Import/Export, but this fork still uses them.
-- This migration is intentionally a no-op on the fork.
SELECT 1;
