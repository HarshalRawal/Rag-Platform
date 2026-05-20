// src/index.js
// Entry point — boots Postgres + Qdrant once, then starts Express.

import "dotenv/config";
import express from "express";
import morgan from "morgan";
import cors from "cors";
import { connectPostgres } from "./config/postgres.js";
import { connectQdrant }   from "./config/qdrant.js";
import { logRewriterConfig } from "./agents/query-rewriter.js";

// ── Routes ────────────────────────────────────────────────────────────────────
import queryRouter, { initAuditLog } from "./routes/query.js";

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  // ── 1. Verify both data stores are reachable before accepting traffic ──────
  console.log("[boot] Connecting to data stores…");
  await connectPostgres();
  await connectQdrant();
  console.log("[boot] Data stores ready.");

  // ── 2. Initialise audit log table (runs once — no per-request overhead)
  await initAuditLog();

  // ── 3. Log query rewriter configuration (Ollama health check if applicable)
  await logRewriterConfig();

  // ── 4. Build Express app ──────────────────────────────────────────────────
  const app = express();

  app.use(express.json());
  app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }));
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

  // ── 5. Mount routes ───────────────────────────────────────────────────────

  app.get("/api/health", (req, res) => {
    res.status(200).json({ ok: true, message: "Server is running" });
  });

  app.use("/api", queryRouter);

  // ── 6. 404 handler ────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: "Not found" });
  });

  // ── 7. Central error handler ──────────────────────────────────────────────
  app.use((err, _req, res, _next) => {
    console.error("[server] Unhandled error:", err.message);
    res.status(500).json({ ok: false, error: "Internal server error" });
  });

  // ── 8. Start listening ────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`\n[server] ✓ Listening on http://localhost:${PORT}`);
    console.log(`[server]   POST http://localhost:${PORT}/api/query`);
  });
}

main().catch((err) => {
  console.error("[boot] Fatal startup error:", err.message);
  process.exit(1);
});