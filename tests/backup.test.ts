import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../server/db";
import { backupDatabase } from "../server/backup";

describe("backup do banco", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nyse-backup-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gera cópia íntegra, legível só pelo dono, com os dados", async () => {
    const dbFile = path.join(dir, "data", "portfolio.db");
    const db = openDatabase(dbFile);
    db.prepare(`INSERT INTO users (email, created_at, updated_at) VALUES ('a@example.com', 'x', 'x')`).run();

    const file = await backupDatabase(dbFile, path.join(dir, "backups"));
    db.close();

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const copy = new Database(file, { readonly: true });
    expect(copy.prepare(`SELECT email FROM users`).get()).toEqual({ email: "a@example.com" });
    copy.close();
  });

  it("mantém só os N backups mais recentes", async () => {
    const dbFile = path.join(dir, "portfolio.db");
    openDatabase(dbFile).close();
    const backups = path.join(dir, "backups");

    for (let i = 1; i <= 4; i++) {
      await backupDatabase(dbFile, backups, 2, new Date(2026, 0, i, 3, 30, 0));
    }

    expect(fs.readdirSync(backups).sort()).toEqual([
      "portfolio-20260103-033000.db",
      "portfolio-20260104-033000.db",
    ]);
  });

  it("falha se o banco não existe", async () => {
    await expect(backupDatabase(path.join(dir, "nope.db"), dir)).rejects.toThrow(/not found/);
  });
});
