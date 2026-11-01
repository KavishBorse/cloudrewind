// Service/instance pairs must remain discoverable after raw snapshots have been rolled up.
// last_seen_at is exact when raw readings exist and null when only summarized history remains.
async function listProjectStreams(database, projectId) {
  return database
    .prepare(
      `SELECT service, instance, MAX(last_seen_at) AS last_seen_at FROM (
         SELECT service, instance, MAX(timestamp) AS last_seen_at
         FROM snapshots WHERE project_id = ? GROUP BY service, instance
         UNION ALL
         SELECT service, instance, NULL AS last_seen_at
         FROM snapshot_rollups WHERE project_id = ? GROUP BY service, instance
       ) GROUP BY service, instance ORDER BY service, instance`
    )
    .all(projectId, projectId);
}

module.exports = { listProjectStreams };
