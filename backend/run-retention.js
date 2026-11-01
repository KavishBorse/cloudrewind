// Run the retention job by hand:  node run-retention.js
// SQLite may be compacted with VACUUM after a large deletion; PostgreSQL uses autovacuum.
const { db } = require("./db");
const { runRetention } = require("./retention");

async function main() {
  try {
    const result = await runRetention(db);
    console.log(result);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error("Retention run failed:", error);
  process.exitCode = 1;
});
