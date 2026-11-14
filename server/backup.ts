import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const BACKUP_PREFIX = "portfolio-";
const BACKUP_SUFFIX = ".db";

function timestamp(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Online backup of the SQLite database (safe while the app is running),
 * followed by an integrity check and retention of the newest `retain` files.
 * Returns the path of the new backup file.
 */
export async function backupDatabase(dbFile: string, backupDir: string, retain = 30, now = new Date()) {
  if (!fs.existsSync(dbFile)) throw new Error(`Database not found: ${dbFile}`);
  if (!Number.isInteger(retain) || retain < 1) throw new Error("retain must be a positive integer");

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const target = path.join(backupDir, `${BACKUP_PREFIX}${timestamp(now)}${BACKUP_SUFFIX}`);

  const source = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    await source.backup(target);
  } finally {
    source.close();
  }
  // The copy inherits WAL mode; switch it to a single self-contained file
  // (no -wal/-shm siblings) and verify it before trusting it.
  const check = new Database(target, { fileMustExist: true });
  try {
    check.pragma("journal_mode = DELETE");
    const result = check.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error(`Backup integrity check failed: ${String(result)}`);
  } finally {
    check.close();
  }
  fs.chmodSync(target, 0o600);

  const backups = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .sort()
    .reverse();
  for (const old of backups.slice(retain)) {
    fs.rmSync(path.join(backupDir, old));
  }

  return target;
}
