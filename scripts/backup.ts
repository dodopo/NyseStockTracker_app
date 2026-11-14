/**
 * Backs up portfolio.db. Usage: npm run backup
 *
 * Reads the same .env as the app:
 *   DATA_DIR       folder that holds portfolio.db (default: project folder)
 *   BACKUP_DIR     where backups go (default: <DATA_DIR>/backups)
 *   BACKUP_RETAIN  how many backups to keep (default: 30)
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config";
import { backupDatabase } from "../server/backup";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig(process.env, rootDir);
const backupDir = path.resolve(rootDir, process.env.BACKUP_DIR?.trim() || path.join(config.dataDir, "backups"));
const retain = Number(process.env.BACKUP_RETAIN ?? 30);

backupDatabase(path.join(config.dataDir, "portfolio.db"), backupDir, retain)
  .then((file) => console.log(`[backup] ${new Date().toISOString()} ok ${file}`))
  .catch((err) => {
    console.error(`[backup] ${new Date().toISOString()} FAILED ${err?.message ?? err}`);
    process.exit(1);
  });
