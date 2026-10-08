const { db } = require("./db");

const count = db.prepare("SELECT COUNT(*) AS n FROM snapshots").get().n;
console.log(`Total snapshots: ${count}`);

const rows = db
  .prepare("SELECT * FROM snapshots ORDER BY id DESC LIMIT 3")
  .all();
console.log("Latest 3:");
console.log(rows);