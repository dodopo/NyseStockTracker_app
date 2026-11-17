/**
 * Prints the absolute path of the app database, resolved exactly as the app
 * does (same .env, same config code). Used by scripts/update.sh to restore
 * the right file on a rollback. Usage: npm run --silent db-path
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
console.log(path.join(loadConfig(process.env, rootDir).dataDir, "portfolio.db"));
