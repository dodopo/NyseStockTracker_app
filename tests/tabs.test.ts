import { describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { loadConfig } from "../server/config";
import { migrate, openDatabase, SCHEMA_VERSION } from "../server/db";
import { createApp, type FinnhubFetch } from "../server/app";
import { createCandleService, type MassiveFetch } from "../server/candles";
import { displaySymbol, finnhubQuoteSymbol, isCryptoTicker } from "../shared/assetTypes";

const PASSWORD = "correct-horse-battery";
const MASSIVE_KEY = "massivegood12345678";

function setup(opts: { finnhub?: FinnhubFetch; massive?: MassiveFetch } = {}) {
  const finnhubCalls: string[] = [];
  const massiveCalls: string[] = [];
  const finnhub: FinnhubFetch =
    opts.finnhub ??
    (async (url) => {
      finnhubCalls.push(url);
      return { c: 100, d: 1, dp: 1, h: 101, l: 99, o: 99, pc: 99 };
    });
  const massive: MassiveFetch = async (path, key) => {
    massiveCalls.push(path);
    if (opts.massive) return opts.massive(path, key);
    return { results: [] };
  };
  const db = openDatabase(":memory:");
  const app = createApp(db, loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
    finnhubFetch: finnhub,
    massiveFetch: massive,
  });
  return { db, app, finnhubCalls, massiveCalls };
}

async function login(app: ReturnType<typeof createApp>, email = "ana@example.com") {
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/register").send({ email, password: PASSWORD, confirmPassword: PASSWORD })).status).toBe(201);
  return agent;
}

async function tabs(agent: request.Agent) {
  return (await agent.get("/api/tabs")).body as Array<{ id: number; name: string; assetType: string; color: string; assetCount: number }>;
}

describe("tipos de ativo (shared/assetTypes)", () => {
  it("cripto no formato da Massive, exibida curta e cotada no par da Binance", () => {
    expect(isCryptoTicker("X:BTCUSD")).toBe(true);
    expect(isCryptoTicker("BTC")).toBe(false); // a US stock ticker
    expect(displaySymbol("X:BTCUSD")).toBe("BTC");
    expect(displaySymbol("AAPL")).toBe("AAPL");
    expect(finnhubQuoteSymbol("X:ETHUSD")).toBe("BINANCE:ETHUSDT");
    expect(finnhubQuoteSymbol("AAPL")).toBe("AAPL");
  });
});

describe("abas", () => {
  it("cadastro cria a aba padrão 'Ações'", async () => {
    const { app } = setup();
    const agent = await login(app);
    expect(await tabs(agent)).toMatchObject([{ name: "Ações", assetType: "us_stock", assetCount: 0 }]);
  });

  it("cria, renomeia, troca a cor e reordena", async () => {
    const { app } = setup();
    const agent = await login(app);
    const created = await agent.post("/api/tabs").send({ name: "Cripto", assetType: "crypto", color: "#f7931a" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Cripto", assetType: "crypto", color: "#f7931a" });

    expect((await agent.patch(`/api/tabs/${created.body.id}`).send({ name: "Bitcoin longo prazo" })).body.name).toBe("Bitcoin longo prazo");
    expect((await agent.patch(`/api/tabs/${created.body.id}`).send({ color: "#bad000" })).status).toBe(400);
    expect((await agent.post("/api/tabs").send({ name: "X", assetType: "bonds", color: "#2962ff" })).status).toBe(400);

    const [acoes, cripto] = await tabs(agent);
    const reordered = await agent.post("/api/tabs/reorder").send({ ids: [cripto.id, acoes.id] });
    expect(reordered.body.map((t: { id: number }) => t.id)).toEqual([cripto.id, acoes.id]);
    expect((await agent.post("/api/tabs/reorder").send({ ids: [cripto.id] })).status).toBe(400); // must list all
  });

  it("ativo só entra em aba do seu tipo; ação 'BTC' e Bitcoin convivem", async () => {
    const { app } = setup();
    const agent = await login(app);
    const crypto = (await agent.post("/api/tabs").send({ name: "Cripto", assetType: "crypto", color: "#f7931a" })).body;
    const acoes = (await tabs(agent))[0];

    expect((await agent.post("/api/stocks").send({ ticker: "AAPL", name: "Apple", tabId: crypto.id })).status).toBe(400);
    expect((await agent.post("/api/stocks").send({ ticker: "X:BTCUSD", name: "Bitcoin", tabId: acoes.id })).status).toBe(400);

    expect((await agent.post("/api/stocks").send({ ticker: "X:BTCUSD", name: "Bitcoin", tabId: crypto.id })).status).toBe(201);
    expect((await agent.post("/api/stocks").send({ ticker: "BTC", name: "Grayscale Bitcoin Mini Trust", tabId: acoes.id })).status).toBe(201);

    const stocks = (await agent.get("/api/stocks")).body;
    expect(stocks.map((s: { ticker: string; asset_type: string }) => `${s.ticker}:${s.asset_type}`).sort()).toEqual([
      "BTC:us_stock",
      "X:BTCUSD:crypto",
    ]);

    // crypto quantities with 8 decimals
    const tx = await agent.post("/api/transactions").send({ ticker: "X:BTCUSD", type: "BUY", shares: "0.00012345", price: "63731.33", date: "2026-11-14" });
    expect(tx.status).toBe(201);
  });

  it("excluir: nunca a única aba; aba com ativos pede destino do mesmo tipo e preserva as operações", async () => {
    const { app, db } = setup();
    const agent = await login(app);
    const acoes = (await tabs(agent))[0];
    expect((await agent.delete(`/api/tabs/${acoes.id}`)).status).toBe(400); // only tab

    const longo = (await agent.post("/api/tabs").send({ name: "Longo prazo", assetType: "us_stock", color: "#089981" })).body;
    const crypto = (await agent.post("/api/tabs").send({ name: "Cripto", assetType: "crypto", color: "#f7931a" })).body;
    await agent.post("/api/stocks").send({ ticker: "AAPL", name: "Apple", tabId: longo.id });
    await agent.post("/api/transactions").send({ ticker: "AAPL", type: "BUY", shares: "10", price: "100", date: "2026-01-02" });

    const ask = await agent.delete(`/api/tabs/${longo.id}`);
    expect(ask.status).toBe(409);
    expect(ask.body).toMatchObject({ code: "TAB_NOT_EMPTY", count: 1 });
    expect((await agent.delete(`/api/tabs/${longo.id}?moveTo=${crypto.id}`)).status).toBe(400); // other type

    expect((await agent.delete(`/api/tabs/${longo.id}?moveTo=${acoes.id}`)).status).toBe(204);
    const stock = db.prepare(`SELECT tab_id FROM stocks WHERE ticker = 'AAPL'`).get() as { tab_id: number };
    expect(stock.tab_id).toBe(acoes.id);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get() as { n: number }).n).toBe(1);

    expect((await agent.delete(`/api/tabs/${crypto.id}`)).status).toBe(204); // empty: deleted directly
  });

  it("não mexe na aba de outro usuário (anti-IDOR)", async () => {
    const { app } = setup();
    const ana = await login(app, "ana@example.com");
    const bob = await login(app, "bob@example.com");
    const anaTab = (await tabs(ana))[0];

    expect((await bob.patch(`/api/tabs/${anaTab.id}`).send({ name: "invasão" })).status).toBe(404);
    expect((await bob.delete(`/api/tabs/${anaTab.id}`)).status).toBe(404);
    expect((await bob.post("/api/stocks").send({ ticker: "AAPL", name: "Apple", tabId: anaTab.id })).status).toBe(404);
    expect((await tabs(ana))[0].name).toBe("Ações");
  });
});

describe("cripto: cotação, busca, estatísticas e gráfico", () => {
  it("cotação de X:BTCUSD vem do par BINANCE:BTCUSDT da Finnhub", async () => {
    const { app, finnhubCalls } = setup();
    const agent = await login(app);
    await agent.post("/api/auth/finnhub-key").send({ apiKey: "finnhubkey123456" });
    const res = await agent.get("/api/prices?symbols=X:BTCUSD,AAPL");
    expect(Object.keys(res.body).sort()).toEqual(["AAPL", "X:BTCUSD"]);
    expect(finnhubCalls.some((u) => u.includes("symbol=BINANCE%3ABTCUSDT"))).toBe(true);
  });

  it("cripto fora da Binance: usa o fechamento anterior da Massive", async () => {
    const { app } = setup({
      finnhub: async (url) => (url.includes("BINANCE") ? { c: 0 } : { c: 100 }),
      massive: async (path) => (path.includes("/prev") ? { results: [{ o: 0.5, c: 0.6, h: 0.7, l: 0.4 }] } : { results: [{ t: 1, o: 1, h: 1, l: 1, c: 1 }] }),
    });
    const agent = await login(app);
    await agent.post("/api/auth/finnhub-key").send({ apiKey: "finnhubkey123456" });
    await agent.post("/api/auth/massive-key").send({ apiKey: MASSIVE_KEY });
    const res = await agent.get("/api/quote?symbol=X:OBSCUREUSD");
    expect(res.status).toBe(200);
    expect(res.body.price).toBe(0.6);
  });

  it("busca de cripto: só pares em dólar, melhor resultado primeiro, com cache", async () => {
    const { app, massiveCalls } = setup({
      massive: async (path) =>
        path.startsWith("/v3/reference/tickers")
          ? {
              results: [
                { ticker: "X:ENSUSD", name: "Ethereum Name Service - United States dollar" },
                { ticker: "X:ETHEUR", name: "Ethereum - Euro" },
                { ticker: "X:ETHUSD", name: "Ethereum - United States dollar" },
                { ticker: "X:ETCUSD", name: "Ethereum Classic - United States dollar" },
              ],
            }
          : { results: [{ t: 1, o: 1, h: 1, l: 1, c: 1 }] },
    });
    const agent = await login(app);
    expect((await agent.get("/api/search?q=ethereum&type=crypto")).body.code).toBe("MASSIVE_KEY_MISSING");
    await agent.post("/api/auth/massive-key").send({ apiKey: MASSIVE_KEY });

    const res = await agent.get("/api/search?q=ethereum&type=crypto");
    expect(res.body.result.map((r: { symbol: string }) => r.symbol)).toEqual(["X:ETHUSD", "X:ETCUSD", "X:ENSUSD"]);
    expect(res.body.result[0]).toEqual({ symbol: "X:ETHUSD", description: "Ethereum", displaySymbol: "ETH" });

    const before = massiveCalls.length;
    await agent.get("/api/search?q=Ethereum&type=crypto");
    expect(massiveCalls.length).toBe(before); // cached
  });

  it("estatísticas de cripto calculadas do histórico (sem Finnhub)", async () => {
    const day = 86_400_000;
    const base = Date.UTC(2026, 0, 1);
    const results = Array.from({ length: 30 }, (_, i) => ({ t: base + i * day, o: 100, h: 100 + i, l: 90 - i, c: 100, v: 2_000_000 }));
    const { app } = setup({ massive: async () => ({ results }) });
    const agent = await login(app);
    await agent.post("/api/auth/massive-key").send({ apiKey: MASSIVE_KEY });
    const res = await agent.get("/api/stats?symbol=X:BTCUSD");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ high52w: 129, low52w: 61, avgVolume10d: 2, marketCap: null });
  });

  it("gráfico 1D de cripto = últimas 24 h (mercado não fecha)", async () => {
    const hour = 3_600_000;
    const end = Date.UTC(2026, 10, 14, 23, 0);
    const results = Array.from({ length: 48 }, (_, i) => ({ t: end - (47 - i) * hour, o: 1, h: 1, l: 1, c: 1, v: 1 }));
    const svc = createCandleService({ fetch: async () => ({ results }), now: () => end });
    const r = await svc.getCandles({ symbol: "X:BTCUSD", range: "1D", interval: "1h", apiKey: MASSIVE_KEY });
    expect(r.candles).toHaveLength(24);
    expect(r.candles[0].t).toBe(end - 23 * hour);
  });
});

describe("migração v5 e backup com abas", () => {
  it("banco da v0.7 ganha a aba 'Ações' com os ativos; cripto antiga vai para 'Cripto'; repetir não muda nada", () => {
    const legacy = new Database(":memory:");
    legacy.pragma("foreign_keys = ON");
    migrate(legacy);
    // simulate a v0.7.x database: no tabs, no new columns
    legacy.exec(`DROP TABLE tabs; ALTER TABLE stocks DROP COLUMN tab_id; ALTER TABLE stocks DROP COLUMN asset_type;`);
    legacy.pragma("user_version = 4");
    legacy.exec(`
      INSERT INTO users (email, created_at, updated_at) VALUES ('ana@example.com','x','x');
      INSERT INTO stocks (user_id, ticker, name, created_at) VALUES (1,'AAPL','Apple','x'), (1,'X:BTCUSD','Bitcoin','x');
    `);

    migrate(legacy);
    migrate(legacy);

    expect(legacy.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const rows = legacy
      .prepare(`SELECT s.ticker, s.asset_type, t.name FROM stocks s JOIN tabs t ON t.id = s.tab_id ORDER BY s.ticker`)
      .all();
    expect(rows).toEqual([
      { ticker: "AAPL", asset_type: "us_stock", name: "Ações" },
      { ticker: "X:BTCUSD", asset_type: "crypto", name: "Cripto" },
    ]);
    expect((legacy.prepare(`SELECT COUNT(*) AS n FROM tabs`).get() as { n: number }).n).toBe(2);
  });

  it("exporta e restaura as abas; backup antigo (sem abas) cai nas abas padrão", async () => {
    const { app } = setup();
    const agent = await login(app);
    const crypto = (await agent.post("/api/tabs").send({ name: "Bitcoin longo prazo", assetType: "crypto", color: "#f7931a" })).body;
    await agent.post("/api/stocks").send({ ticker: "X:BTCUSD", name: "Bitcoin", tabId: crypto.id });

    const backup = (await agent.get("/api/export")).body;
    expect(backup.tabs.map((t: { name: string }) => t.name)).toEqual(["Ações", "Bitcoin longo prazo"]);

    const restored = await agent.post("/api/import").send(backup);
    expect(restored.status).toBe(200);
    const tabNames = restored.body.tabs.map((t: { name: string; assetCount: number }) => `${t.name}:${t.assetCount}`);
    expect(tabNames).toEqual(["Ações:0", "Bitcoin longo prazo:1"]);

    const old = { user: { email: "ana@example.com" }, stocks: [{ ticker: "AAPL", name: "Apple" }, { ticker: "X:ETHUSD", name: "Ethereum" }], transactions: [] };
    const fromOld = await agent.post("/api/import").send(old);
    expect(fromOld.body.tabs.map((t: { name: string; assetType: string }) => `${t.name}:${t.assetType}`).sort()).toEqual([
      "Ações:us_stock",
      "Cripto:crypto",
    ]);
  });
});
