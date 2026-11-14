import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { loadConfig, type AppConfig } from "../server/config";
import { migrate, openDatabase, SCHEMA_VERSION, type DB } from "../server/db";
import { createApp, SESSION_COOKIE_NAME, type FinnhubFetch } from "../server/app";

const PASSWORD = "correct-horse-battery";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), ...overrides };
}

function setup(overrides: Partial<AppConfig> = {}, finnhubFetch?: FinnhubFetch) {
  const db = openDatabase(":memory:");
  const config = makeConfig(overrides);
  const fetchCalls: string[] = [];
  const fakeFetch: FinnhubFetch =
    finnhubFetch ??
    (async (url) => {
      fetchCalls.push(url);
      return { c: 100, d: 1, dp: 1, h: 101, l: 99, o: 99.5, pc: 99 };
    });
  const app = createApp(db, config, { finnhubFetch: fakeFetch });
  return { db, app, config, fetchCalls };
}

async function register(app: ReturnType<typeof createApp>, email = "ana@example.com") {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/register")
    .send({ email, password: PASSWORD, confirmPassword: PASSWORD });
  expect(res.status).toBe(201);
  return agent;
}

describe("autenticação (CRÍTICO: login sem senha)", () => {
  it("recusa cadastro sem senha", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "a@example.com", password: "", confirmPassword: "" });
    expect(res.status).toBe(400);
  });

  it("recusa senha com menos de 12 caracteres", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "a@example.com", password: "short", confirmPassword: "short" });
    expect(res.status).toBe(400);
  });

  it("conta antiga sem senha (v0.2.0) não entra só com o e-mail", async () => {
    const { app, db } = setup();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (email, password_hash, created_at, updated_at) VALUES (?, NULL, ?, ?)`
    ).run("legacy@example.com", now, now);

    const res = await request(app).post("/api/auth/login").send({ email: "legacy@example.com", password: "" });
    expect(res.status).toBe(401);
  });

  it("senha errada dá 401 e senha certa dá 200 com cookie", async () => {
    const { app } = setup();
    await register(app);

    const bad = await request(app).post("/api/auth/login").send({ email: "ana@example.com", password: "wrong-password!!" });
    expect(bad.status).toBe(401);

    const good = await request(app).post("/api/auth/login").send({ email: "ana@example.com", password: PASSWORD });
    expect(good.status).toBe(200);
    expect(String(good.headers["set-cookie"])).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(String(good.headers["set-cookie"])).toContain("HttpOnly");
  });

  it("cadastro fechado (ALLOW_REGISTRATION=false) responde 403", async () => {
    const { app } = setup({ allowRegistration: false });
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "a@example.com", password: PASSWORD, confirmPassword: PASSWORD });
    expect(res.status).toBe(403);

    const me = await request(app).get("/api/auth/me");
    expect(me.body.registrationEnabled).toBe(false);
  });
});

describe("sessão (ALTO: sessão eterna)", () => {
  it("guarda só o hash do token no banco", async () => {
    const { app, db } = setup();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "ana@example.com", password: PASSWORD, confirmPassword: PASSWORD });
    const cookie = String(res.headers["set-cookie"]);
    const token = decodeURIComponent(cookie.split(";")[0].split("=")[1]);

    const row = db.prepare(`SELECT token_hash, expires_at FROM sessions`).get() as any;
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expires_at).toBeTruthy();
  });

  it("sessão vencida é recusada com 401", async () => {
    const { app, db } = setup();
    const agent = await register(app);
    expect((await agent.get("/api/stocks")).status).toBe(200);

    db.prepare(`UPDATE sessions SET expires_at = ?`).run("2000-01-01T00:00:00.000Z");
    expect((await agent.get("/api/stocks")).status).toBe(401);
  });

  it("logout invalida a sessão no servidor", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "ana@example.com", password: PASSWORD, confirmPassword: PASSWORD });
    const cookie = String(res.headers["set-cookie"]).split(";")[0];

    expect((await request(app).get("/api/stocks").set("Cookie", cookie)).status).toBe(200);
    await request(app).post("/api/auth/logout").set("Cookie", cookie);
    expect((await request(app).get("/api/stocks").set("Cookie", cookie)).status).toBe(401);
  });
});

describe("abuso (ALTO: força bruta e cota da Finnhub)", () => {
  it("bloqueia tentativas de login em excesso com 429", async () => {
    const { app } = setup({ authRateLimit: { windowMs: 60_000, limit: 3 } });
    const attempt = () =>
      request(app).post("/api/auth/login").send({ email: "x@example.com", password: "wrong-password!!" });

    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });

  it("não usa a chave FINNHUB_KEY do servidor para quem não tem chave própria", async () => {
    process.env.FINNHUB_KEY = "server-wide-key-should-not-be-used";
    const { app, fetchCalls } = setup();
    const agent = await register(app);

    const res = await agent.get("/api/quote?symbol=AAPL");
    expect(res.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
    delete process.env.FINNHUB_KEY;
  });

  it("limita /api/prices a 50 símbolos e recusa símbolo inválido", async () => {
    const { app, fetchCalls } = setup();
    const agent = await register(app);
    await agent.post("/api/auth/finnhub-key").send({ apiKey: "abcdefghij1234567890" });

    const many = Array.from({ length: 51 }, (_, i) => `T${i}`).join(",");
    expect((await agent.get(`/api/prices?symbols=${many}`)).status).toBe(400);
    expect((await agent.get(`/api/prices?symbols=AAPL,<script>`)).status).toBe(400);
    expect(fetchCalls).toHaveLength(0);

    const ok = await agent.get(`/api/prices?symbols=AAPL,MSFT,AAPL`);
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(["AAPL", "MSFT"]);
  });
});

describe("vazamento de informação (MÉDIO)", () => {
  it("erro interno não devolve a mensagem original ao cliente", async () => {
    const { app } = setup({}, async () => {
      throw new Error("SECRET-DETAIL token=abc123");
    });
    const agent = await register(app);
    await agent.post("/api/auth/finnhub-key").send({ apiKey: "abcdefghij1234567890" });

    const res = await agent.get("/api/quote?symbol=AAPL");
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("SECRET-DETAIL");
  });

  it("envia headers de segurança e esconde o X-Powered-By", async () => {
    const { app } = setup();
    const res = await request(app).get("/api/auth/me");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("backup não inclui a chave da Finnhub por padrão", async () => {
    const { app } = setup();
    const agent = await register(app);
    await agent.post("/api/auth/finnhub-key").send({ apiKey: "abcdefghij1234567890" });

    const res = await agent.get("/api/export");
    expect(res.status).toBe(200);
    expect(res.body.user.finnhub_key).toBeNull();
  });
});

describe("isolamento e regras da carteira", () => {
  async function seedPortfolio(agent: request.Agent) {
    await agent.post("/api/stocks").send({ ticker: "AAPL", name: "Apple" });
    const buy = await agent
      .post("/api/transactions")
      .send({ ticker: "AAPL", type: "BUY", shares: 10, price: 100, date: "2026-01-02" });
    const sell = await agent
      .post("/api/transactions")
      .send({ ticker: "AAPL", type: "SELL", shares: 5, price: 120, date: "2026-02-02" });
    return { buyId: buy.body.id as number, sellId: sell.body.id as number };
  }

  it("um usuário não apaga a operação de outro (anti-IDOR)", async () => {
    const { app, db } = setup();
    const ana = await register(app, "ana@example.com");
    const bob = await register(app, "bob@example.com");
    const { sellId } = await seedPortfolio(ana);

    expect((await bob.delete(`/api/transactions/${sellId}`)).status).toBe(204);
    const still = db.prepare(`SELECT id FROM transactions WHERE id = ?`).get(sellId);
    expect(still).toBeTruthy();
  });

  it("recusa venda maior que a posição e data inválida", async () => {
    const { app } = setup();
    const agent = await register(app);
    await seedPortfolio(agent);

    const oversell = await agent
      .post("/api/transactions")
      .send({ ticker: "AAPL", type: "SELL", shares: 6, price: 1, date: "2026-03-01" });
    expect(oversell.status).toBe(400);

    const badDate = await agent
      .post("/api/transactions")
      .send({ ticker: "AAPL", type: "BUY", shares: 1, price: 1, date: "2026-02-30" });
    expect(badDate.status).toBe(400);
  });

  it("não deixa apagar uma compra se a posição ficaria negativa", async () => {
    const { app } = setup();
    const agent = await register(app);
    const { buyId } = await seedPortfolio(agent);

    const res = await agent.delete(`/api/transactions/${buyId}`);
    expect(res.status).toBe(409);
  });

  it("restauração com posição negativa é recusada e nada é alterado", async () => {
    const { app } = setup();
    const agent = await register(app);
    await seedPortfolio(agent);

    const res = await agent.post("/api/import").send({
      user: { email: "ana@example.com" },
      stocks: [{ ticker: "MSFT", name: "Microsoft" }],
      transactions: [{ ticker: "MSFT", type: "SELL", shares: 1, price: 1, date: "2026-01-01" }],
    });
    expect(res.status).toBe(400);

    const stocks = await agent.get("/api/stocks");
    expect(stocks.body.map((s: any) => s.ticker)).toEqual(["AAPL"]);
  });
});

describe("migrações do banco (MÉDIO: DROP destrutivo no boot)", () => {
  let legacy: DB;

  beforeEach(() => {
    legacy = new Database(":memory:");
  });

  it("adota um banco da v0.2.0 sem apagar a carteira", () => {
    legacy.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, display_name TEXT,
        password_hash TEXT, recovery_key_hash TEXT, finnhub_key TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, last_login_at TEXT);
      CREATE TABLE user_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE,
        default_port INTEGER, theme TEXT, currency TEXT, include_secrets_in_backup INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        session_token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT);
      CREATE TABLE stocks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ticker TEXT NOT NULL,
        name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (user_id, ticker));
      CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ticker TEXT NOT NULL,
        type TEXT NOT NULL, shares REAL NOT NULL, price REAL NOT NULL, date TEXT NOT NULL, created_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0);
      INSERT INTO users (email, created_at, updated_at) VALUES ('ana@example.com', 'x', 'x');
      INSERT INTO user_settings (user_id, created_at, updated_at) VALUES (1, 'x', 'x');
      INSERT INTO sessions (user_id, session_token, created_at) VALUES (1, 'old-token', 'x');
      INSERT INTO stocks (user_id, ticker, name, created_at) VALUES (1, 'AAPL', 'Apple', 'x');
      INSERT INTO transactions (user_id, ticker, type, shares, price, date, created_at, sort_order)
        VALUES (1, 'AAPL', 'BUY', 1, 1, '2026-01-01', 'x', 1);
    `);

    migrate(legacy);

    expect(legacy.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(legacy.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toEqual({ n: 1 });
    expect(legacy.prepare(`SELECT COUNT(*) AS n FROM sessions`).get()).toEqual({ n: 0 });
    expect(
      legacy.prepare(`SELECT include_secrets_in_backup AS v FROM user_settings`).get()
    ).toEqual({ v: 0 });
  });

  it("banco anterior à v0.2.0 falha fechado, sem apagar nada", () => {
    legacy.exec(`
      CREATE TABLE stocks (id INTEGER PRIMARY KEY, ticker TEXT, name TEXT);
      INSERT INTO stocks (ticker, name) VALUES ('AAPL', 'Apple');
    `);

    expect(() => migrate(legacy)).toThrow(/older than v0.2.0/);
    expect(legacy.prepare(`SELECT COUNT(*) AS n FROM stocks`).get()).toEqual({ n: 1 });
  });

  it("rodar a migração duas vezes não muda nada", () => {
    const db = openDatabase(":memory:");
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });
});

describe("excluir a própria conta", () => {
  it("exige a senha certa e o e-mail digitado; apaga tudo em cascata", async () => {
    const { app, db } = setup();
    const agent = await register(app, "ana@example.com");
    await agent.post("/api/stocks").send({ ticker: "AAPL", name: "Apple" });
    await agent
      .post("/api/transactions")
      .send({ ticker: "AAPL", type: "BUY", shares: "1", price: "100", date: "2026-01-02" });

    const wrongPassword = await agent
      .post("/api/auth/delete-account")
      .send({ password: "wrong-password!!", confirmEmail: "ana@example.com" });
    expect(wrongPassword.status).toBe(401);

    const wrongEmail = await agent
      .post("/api/auth/delete-account")
      .send({ password: PASSWORD, confirmEmail: "outra@example.com" });
    expect(wrongEmail.status).toBe(400);

    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("transactions")).toBe(1);

    const ok = await agent
      .post("/api/auth/delete-account")
      .send({ password: PASSWORD, confirmEmail: "ANA@example.com " });
    expect(ok.status).toBe(200);

    for (const table of ["users", "user_settings", "sessions", "stocks", "transactions"]) {
      expect(count(table)).toBe(0);
    }
    expect((await agent.get("/api/stocks")).status).toBe(401);
  });

  it("sem sessão não exclui nada", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/api/auth/delete-account")
      .send({ password: PASSWORD, confirmEmail: "ana@example.com" });
    expect(res.status).toBe(401);
  });

  it("não apaga a conta de outro usuário", async () => {
    const { app, db } = setup();
    await register(app, "ana@example.com");
    const bob = await register(app, "bob@example.com");
    await bob.post("/api/auth/delete-account").send({ password: PASSWORD, confirmEmail: "ana@example.com" });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n).toBe(2);
  });
});
