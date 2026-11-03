ALTER TABLE snapshots
  ADD COLUMN IF NOT EXISTS db_connected INTEGER CHECK(db_connected IN (0, 1));

ALTER TABLE snapshot_rollups
  ADD COLUMN IF NOT EXISTS db_connected_min INTEGER CHECK(db_connected_min IN (0, 1));
