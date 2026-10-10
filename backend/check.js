const { db } = require("./db");

console.log("Users:", db.prepare("SELECT id, email FROM users").all());
console.log("Projects:", db.prepare("SELECT id, user_id, name, is_demo, api_key_prefix FROM projects").all());
console.log("Snapshots per project:", db.prepare("SELECT project_id, COUNT(*) AS n FROM snapshots GROUP BY project_id").all());
console.log("Latest 2:", db.prepare("SELECT * FROM snapshots ORDER BY id DESC LIMIT 2").all());