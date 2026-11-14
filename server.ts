import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadConfig } from "./server/config";
import { openDatabase } from "./server/db";
import { createApp } from "./server/app";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

async function start() {
  const config = loadConfig(process.env, rootDir);
  const db = openDatabase(path.join(config.dataDir, "portfolio.db"));
  const app = createApp(db, config);

  if (!config.isProd) {
    // Loaded only in development, so production does not need Vite at runtime.
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(rootDir, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
  }

  app.listen(config.port, config.host, () => {
    console.log(
      `Server running on http://${config.host}:${config.port} ` +
        `(mode=${config.isProd ? "production" : "development"}, ` +
        `registration=${config.allowRegistration ? "open" : "closed"})`
    );
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err?.message ?? err);
  process.exit(1);
});
