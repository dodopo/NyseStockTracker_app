import path from "node:path";

export type AppConfig = {
  isProd: boolean;
  port: number;
  host: string;
  dataDir: string;
  allowRegistration: boolean;
  sessionTtlMs: number;
  cookieSecure: boolean;
  trustProxy: string | false;
  quoteCacheTtlMs: number;
  quoteCacheMaxEntries: number;
  authRateLimit: { windowMs: number; limit: number };
  apiRateLimit: { windowMs: number; limit: number };
};

function readBool(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readInt(value: string | undefined, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * Reads configuration from environment variables.
 * Every value has a safe default; see .env.example for documentation.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, rootDir = process.cwd()): AppConfig {
  const isProd = env.NODE_ENV === "production";
  const sessionTtlDays = readInt(env.SESSION_TTL_DAYS, 7, 1, 90);

  return {
    isProd,
    port: readInt(env.PORT, 3000, 1, 65535),
    host: env.HOST?.trim() || "127.0.0.1",
    dataDir: path.resolve(rootDir, env.DATA_DIR?.trim() || "."),
    allowRegistration: readBool(env.ALLOW_REGISTRATION, true),
    sessionTtlMs: sessionTtlDays * 24 * 60 * 60 * 1000,
    cookieSecure: readBool(env.COOKIE_SECURE, isProd),
    trustProxy: env.TRUST_PROXY?.trim() || false,
    quoteCacheTtlMs: readInt(env.QUOTE_CACHE_TTL_MS, 30_000, 0, 24 * 60 * 60 * 1000),
    quoteCacheMaxEntries: 500,
    authRateLimit: { windowMs: 15 * 60 * 1000, limit: readInt(env.AUTH_RATE_LIMIT, 10, 1, 1000) },
    apiRateLimit: { windowMs: 60 * 1000, limit: readInt(env.API_RATE_LIMIT, 300, 10, 100_000) },
  };
}
