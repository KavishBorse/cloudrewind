const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is missing in backend/.env");
  process.exit(1);
}

module.exports = {
  PORT: Number(process.env.PORT) || 5000,
  DATABASE_URL: process.env.DATABASE_URL || "",
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  GROQ_MODEL: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
  CLOUDREWIND_DB_PATH: process.env.CLOUDREWIND_DB_PATH || "",
  FRONTEND_URL: (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, ""),
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: "7d",
  CORS_ORIGINS: (process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};
