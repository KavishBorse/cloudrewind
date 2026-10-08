const express = require("express");
const cors = require("cors");
const { insertSnapshot } = require("./db");
const { generateSnapshot } = require("./simulator");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Snapshot recorder: save one reading every 5 seconds
const INTERVAL_MS = 5000;
setInterval(() => {
  const snapshot = generateSnapshot();
  insertSnapshot(snapshot);
  console.log(
    `Saved snapshot | cpu ${snapshot.cpu}% | mem ${snapshot.memory}% | db ${snapshot.db_connections}`
  );
}, INTERVAL_MS);

const PORT = 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));