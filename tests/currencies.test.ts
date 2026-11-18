/**
 * v0.14.0: classifications, trade currency and the PTAX frozen on each trade.
 * The Banco Central is faked (no network): every rule about business days,
 * provisional rates and conversions is checked with known numbers.
 */
import Database from "better-sqlite3";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { loadConfig } from "../server/config";
import { migrate, openDatabase, type DB } from "../server/db";
import { brazilToday, createPtax } from "../server/ptax";
import type { DataFetch } from "../server/providers/types";
import { conversionFactor, type FxSnapshot } from "../shared/currencies";
import { horizonOfDays } from "../shared/classification";
import { convertTrades, positionIn } from "../shared/fxPositions";

const PASSWORD = "correct-horse-battery";
const T = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Fake Banco Central: closing bulletins (reais per unit, buy/sell) by date.
// 14-15/11/2026 is a weekend: no bulletin.
// ---------------------------------------------------------------------------
type Day = Record<"USD" | "EUR" | "CHF", [number, number]>;
const BULLETINS: Record<string, Day> = {
  "2026-11-12": { USD: [5.3, 5.31], EUR: [6.1, 6.11], CHF: [6.5, 6.51] },
  "2026-11-13": { USD: [5.4, 5.41], EUR: [6.2321, 6.2334], CHF: [6.6, 6.61] },
  "2026-11-16": { USD: [5.5, 5.51], EUR: [6.3084, 6.3102], CHF: [6.7, 6.71] },
};

function fakeBcb(days: Record<string, Partial<Day>> = BULLETINS, intermediateOnly: Record<string, Partial<Day>> = {}) {
  const urls: string[] = [];
  const fetch: DataFetch = async (url) => {
    urls.push(url);
    const u = decodeURIComponent(url);
    const currency = /@moeda='([A-Z]{3})'/.exec(u)![1] as keyof Day;
    const iso = (s: string) => `${s.slice(6)}-${s.slice(0, 2)}-${s.slice(3, 5)}`;
    const from = iso(/@dataInicial='([\d-]+)'/.exec(u)![1]);
    const to = iso(/@dataFinalCotacao='([\d-]+)'/.exec(u)![1]);
    const value = Object.entries(days)
      .filter(([d, rates]) => d >= from && d <= to && rates[currency])
      .flatMap(([d, rates]) => [
        { cotacaoCompra: rates[currency]![0] - 0.05, cotacaoVenda: rates[currency]![1] - 0.05, dataHoraCotacao: `${d} 11:04:00.1`, tipoBoletim: "Intermediário" },
        { cotacaoCompra: rates[currency]![0], cotacaoVenda: rates[currency]![1], dataHoraCotacao: `${d} 13:05:00.1`, tipoBoletim: "Fechamento" },
      ]);
    // a day whose closing bulletin is not out yet: only intermediate ones (e.g. today at 11h)
    for (const [d, rates] of Object.entries(intermediateOnly)) {
      if (d >= from && d <= to && rates[currency]) {
        value.push({ cotacaoCompra: rates[currency]![0], cotacaoVenda: rates[currency]![1], dataHoraCotacao: `${d} 11:04:00.1`, tipoBoletim: "Intermediário" });
      }
    }
    return { value };
  };
  return { fetch, urls };
}

/** "Now" in Brasília on a given day and hour. */
const at = (date: string, hour = 15) => Date.parse(`${date}T${String(hour + 3).padStart(2, "0")}:00:00Z`);

function ptaxDb() {
  return openDatabase(":memory:");
}

describe("PTAX do Banco Central", () => {
  it("dia útil: fechamento do próprio dia, compra e venda, definitivo; não manda nada além de datas e moedas", async () => {
    const bcb = fakeBcb();
    const ptax = createPtax(ptaxDb(), { fetchJson: bcb.fetch, now: () => at("2026-11-17") });
    const snap = await ptax.snapshotFor("2026-11-13");
    expect(snap).toEqual({
      date: "2026-11-13",
      provisional: false,
      buy: { USD: "5.4", EUR: "6.2321", CHF: "6.6" },
      sell: { USD: "5.41", EUR: "6.2334", CHF: "6.61" },
    });
    expect(bcb.urls).toHaveLength(3); // USD, EUR, CHF
    // exactly this shape: an official BCB address, a currency code and two dates, nothing else
    const shape =
      /^https:\/\/olinda\.bcb\.gov\.br\/olinda\/servico\/PTAX\/versao\/v1\/odata\/CotacaoMoedaPeriodo\(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao\)\?@moeda='(USD|EUR|CHF)'&@dataInicial='\d\d-\d\d-\d{4}'&@dataFinalCotacao='\d\d-\d\d-\d{4}'&\$format=json&\$select=cotacaoCompra,cotacaoVenda,dataHoraCotacao,tipoBoletim$/;
    for (const url of bcb.urls) expect(url).toMatch(shape);
  });

  it("fim de semana: vale a sexta, e é definitivo porque a segunda já saiu", async () => {
    const ptax = createPtax(ptaxDb(), { fetchJson: fakeBcb().fetch, now: () => at("2026-11-17") });
    expect(await ptax.snapshotFor("2026-11-15")).toMatchObject({ date: "2026-11-13", provisional: false, sell: { USD: "5.41" } });
  });

  it("hoje antes do fechamento: PTAX do dia anterior, PROVISÓRIA; depois o fechamento substitui", async () => {
    let now = at("2026-11-17", 10);
    const days: Record<string, Partial<Day>> = { ...BULLETINS };
    const db = ptaxDb();
    const intermediate: Record<string, Partial<Day>> = { "2026-11-17": { USD: [9, 9], EUR: [9, 9], CHF: [9, 9] } };
    const ptax = createPtax(db, { fetchJson: fakeBcb(days, intermediate).fetch, now: () => now });
    // the intermediate bulletins of the day are never used: only a closing one counts
    expect(await ptax.snapshotFor("2026-11-17")).toMatchObject({ date: "2026-11-16", provisional: true, sell: { USD: "5.51" } });
    // and a provisional rate is never cached as if it were final
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ptax_cache WHERE trade_date = '2026-11-17'`).get()).toEqual({ n: 0 });

    // a trade saved with the provisional rate is replaced once the bulletin is out
    seedTrade(db, "2026-11-17", { date: "2026-11-16", provisional: true });
    days["2026-11-17"] = { USD: [5.6, 5.61], EUR: [6.36, 6.3659], CHF: [6.8, 6.81] };
    now = at("2026-11-17", 14);
    expect(await ptax.refreshPending()).toBe(1);
    const fx = JSON.parse((db.prepare(`SELECT fx FROM transactions`).get() as { fx: string }).fx);
    expect(fx).toMatchObject({ date: "2026-11-17", provisional: false, sell: { EUR: "6.3659" } });
  });

  it("definitivo fica guardado: a mesma data não pergunta de novo ao Banco Central", async () => {
    const bcb = fakeBcb();
    const ptax = createPtax(ptaxDb(), { fetchJson: bcb.fetch, now: () => at("2026-11-17") });
    await ptax.snapshotFor("2026-11-13");
    await ptax.snapshotFor("2026-11-13");
    expect(bcb.urls).toHaveLength(3);
  });

  it("resposta incompleta ou absurda não vira câmbio: fica pendente", async () => {
    const noEuro = createPtax(ptaxDb(), { fetchJson: fakeBcb({ "2026-11-13": { USD: [5.4, 5.41], CHF: [6.6, 6.61] } }).fetch, now: () => at("2026-11-17") });
    expect(await noEuro.snapshotFor("2026-11-13")).toBeNull();
    const absurd = createPtax(ptaxDb(), { fetchJson: fakeBcb({ "2026-11-13": { USD: [0, -1], EUR: [6, 6], CHF: [6, 6] } }).fetch, now: () => at("2026-11-17") });
    expect(await absurd.snapshotFor("2026-11-13")).toBeNull();
  });

  it("Banco Central fora do ar: nada quebra, a operação fica pendente para a próxima rodada", async () => {
    const db = ptaxDb();
    seedTrade(db, "2026-11-13", null);
    const ptax = createPtax(db, {
      fetchJson: async () => {
        throw Object.assign(new Error("down"), { status: 503 });
      },
      now: () => at("2026-11-17"),
    });
    expect(await ptax.refreshPending()).toBe(0);
    expect((db.prepare(`SELECT fx FROM transactions`).get() as { fx: string | null }).fx).toBeNull();
  });

  it("data de Brasília, não UTC", () => {
    expect(brazilToday(Date.parse("2026-11-18T02:30:00Z"))).toBe("2026-11-17"); // 23:30 em Brasília
  });
});

/** One user, portfolio, asset and trade straight in the database (for the PTAX service tests). */
function seedTrade(db: DB, date: string, fx: Partial<FxSnapshot> | null) {
  db.prepare(`INSERT INTO users (email, display_name, password_hash, created_at, updated_at) VALUES ('a@test.local', 'A', 'h', ?, ?)`).run(T, T);
  db.prepare(`INSERT INTO portfolios (user_id, name, color, created_at, updated_at) VALUES (1, 'P', '#2962ff', ?, ?)`).run(T, T);
  db.prepare(`INSERT INTO stocks (user_id, portfolio_id, ticker, name, created_at, asset_type) VALUES (1, 1, 'AAPL', 'Apple', ?, 'us_stock')`).run(T);
  const full = fx && { buy: { USD: "1", EUR: "1", CHF: "1" }, sell: { USD: "1", EUR: "1", CHF: "1" }, ...fx };
  db.prepare(
    `INSERT INTO transactions (user_id, portfolio_id, ticker, type, shares, price, shares_dec, price_dec, date, created_at, fx)
     VALUES (1, 1, 'AAPL', 'BUY', 1, 10, '1', '10', ?, ?, ?)`
  ).run(date, T, full ? JSON.stringify(full) : null);
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------
describe("conversão pela PTAX da operação", () => {
  const fx13: FxSnapshot = {
    date: "2026-11-13",
    provisional: false,
    buy: { USD: "5.4", EUR: "6.2", CHF: "6.6" },
    sell: { USD: "5.5", EUR: "6.6", CHF: "5.5" },
  };

  it("fatores pela VENDA, em reais por unidade (BRL = 1)", () => {
    expect(conversionFactor("USD", "BRL", fx13.sell)!.toString()).toBe("5.5");
    expect(conversionFactor("BRL", "USD", fx13.sell)!.toFixed(6)).toBe("0.181818");
    expect(conversionFactor("EUR", "USD", fx13.sell)!.toString()).toBe("1.2"); // 6.6 / 5.5
    expect(conversionFactor("USD", "CHF", fx13.sell)!.toString()).toBe("1");
  });

  it("custo histórico: compra a US$ 10 com dólar a 5,50 custa R$ 55, mesmo com o dólar hoje a 6", () => {
    const trades = [{ type: "BUY" as const, shares: "10", price: "10", date: "2026-11-13", currency: "USD", fx: fx13 }];
    const live = { USD: "6", EUR: "7", CHF: "6.5" };
    const brl = positionIn(trades, "USD", 12, "BRL", live)!;
    expect(brl.openCost).toBe(550); // 10 x 10 x 5.50
    expect(brl.marketValue).toBe(720); // 10 x 12 x 6.00 (hoje)
    expect(brl.unrealizedPnL).toBe(170); // inclui a variação do câmbio
    const usd = positionIn(trades, "USD", 12, "USD", null)!; // na moeda do ativo não precisa de câmbio
    expect(usd.openCost).toBe(100);
    expect(usd.marketValue).toBe(120);
  });

  it("operação paga em outra moeda entra no preço médio da moeda do ativo pela PTAX dela", () => {
    const trades = [
      { type: "BUY" as const, shares: "1", price: "100", date: "2026-11-13", currency: "USD", fx: fx13 },
      { type: "BUY" as const, shares: "1", price: "660", date: "2026-11-13", currency: "BRL", fx: fx13 }, // R$ 660 = US$ 120
    ];
    expect(positionIn(trades, "USD", 100, "USD", null)!.avgCost).toBe(110);
  });

  it("sem PTAX ainda: usa o câmbio de hoje e avisa; sem câmbio nenhum, avisa que faltou", () => {
    const trades = [{ type: "BUY" as const, shares: "1", price: "10", date: "2026-11-17", currency: "USD", fx: null }];
    expect(convertTrades(trades, "USD", "BRL", { USD: "6", EUR: "7", CHF: "6.5" })).toMatchObject({ approx: 1, missing: 0, trades: [{ price: "60" }] });
    expect(convertTrades(trades, "USD", "BRL", null)).toMatchObject({ approx: 0, missing: 1 });
    expect(positionIn(trades, "USD", 10, "BRL", null)).toBeNull();
  });

  it("faixas de prazo em dias corridos", () => {
    expect([30, 31, 180, 181, 720, 721, 1800, 1801].map(horizonOfDays)).toEqual([
      "ultra_short", "short", "short", "medium", "medium", "long", "long", "ultra_long",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Migration v8
// ---------------------------------------------------------------------------
describe("migração v8: só acrescenta colunas", () => {
  function v7Database(): DB {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, 7);
    db.prepare(`INSERT INTO users (email, display_name, password_hash, created_at, updated_at) VALUES ('a@test.local', 'A', 'h', ?, ?)`).run(T, T);
    db.prepare(`INSERT INTO portfolios (user_id, name, color, created_at, updated_at) VALUES (1, 'P', '#2962ff', ?, ?)`).run(T, T);
    const stock = db.prepare(`INSERT INTO stocks (user_id, portfolio_id, ticker, name, created_at, asset_type) VALUES (1, 1, ?, ?, ?, ?)`);
    stock.run("AAPL", "Apple", T, "us_stock");
    stock.run("X:BTCUSD", "Bitcoin", T, "crypto");
    const tx = db.prepare(
      `INSERT INTO transactions (user_id, portfolio_id, ticker, type, shares, price, shares_dec, price_dec, date, created_at, sort_order)
       VALUES (1, 1, ?, 'BUY', 1, 10, '1', '10.5', ?, ?, ?)`
    );
    tx.run("AAPL", "2025-01-02", T, 1);
    tx.run("X:BTCUSD", "2025-02-03", T, 2);
    return db;
  }

  it("linhas idênticas; ação EUA nasce offshore, cripto 'não definido', tudo em USD e PTAX pendente", () => {
    const db = v7Database();
    const before = {
      stocks: db.prepare(`SELECT * FROM stocks ORDER BY id`).all(),
      tx: db.prepare(`SELECT * FROM transactions ORDER BY id`).all(),
    };
    migrate(db, 8);
    expect(db.pragma("user_version", { simple: true })).toBe(8);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);

    const stocks = db.prepare(`SELECT * FROM stocks ORDER BY id`).all() as any[];
    // tab_id aside: opening the database puts assets without a tab in a default tab (since v0.8.0)
    const noTab = ({ tab_id: _t, ...rest }: any) => rest;
    stocks.forEach((s, i) => expect(noTab(s)).toMatchObject(noTab(before.stocks[i])));
    expect(stocks.map((s) => [s.ticker, s.liquidity, s.horizon, s.jurisdiction, s.currency])).toEqual([
      ["AAPL", "liquid", null, "offshore", "USD"],
      ["X:BTCUSD", "liquid", null, null, "USD"],
    ]);
    const tx = db.prepare(`SELECT * FROM transactions ORDER BY id`).all() as any[];
    tx.forEach((t, i) => expect(t).toMatchObject(before.tx[i] as object));
    expect(tx.map((t) => [t.currency, t.fx])).toEqual([["USD", null], ["USD", null]]);

    migrate(db, 8); // idempotent
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toEqual({ n: 2 });
  });

  it("o banco recusa valor fora da lista", () => {
    const db = v7Database();
    migrate(db);
    expect(() => db.prepare(`UPDATE stocks SET horizon = 'eterno'`).run()).toThrow(/CHECK/);
    expect(() => db.prepare(`UPDATE stocks SET liquidity = NULL`).run()).toThrow(/NOT NULL/);
    expect(() => db.prepare(`UPDATE transactions SET currency = 'JPY'`).run()).toThrow(/CHECK/);
  });

  it("uma versão antiga (sem as colunas novas) ainda grava: valores padrão", () => {
    const db = v7Database();
    migrate(db);
    db.prepare(
      `INSERT INTO transactions (user_id, portfolio_id, ticker, type, shares, price, shares_dec, price_dec, date, created_at, sort_order)
       VALUES (1, 1, 'AAPL', 'BUY', 1, 10, '1', '10', '2025-03-03', ?, 3)`
    ).run(T);
    expect(db.prepare(`SELECT currency, fx FROM transactions WHERE sort_order = 3`).get()).toEqual({ currency: "USD", fx: null });
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function apiSetup(now = at("2026-11-17")) {
  const bcb = fakeBcb();
  const app = createApp(openDatabase(":memory:"), loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
    finnhubFetch: async () => ({ c: 100, d: 1, dp: 1, h: 101, l: 99, o: 99, pc: 99 }),
    dataFetch: bcb.fetch,
    now: () => now,
  });
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/register").send({ email: "ana@example.com", password: PASSWORD, confirmPassword: PASSWORD })).status).toBe(201);
  const tabId = (await agent.get("/api/tabs")).body[0].id;
  expect((await agent.post("/api/stocks").send({ ticker: "AAPL", name: "Apple", tabId })).status).toBe(201);
  return { app, agent, tabId, bcb };
}

describe("API: moeda e PTAX nas operações", () => {
  it("a operação grava a moeda (padrão: a do ativo) e a PTAX do dia; a lista devolve tudo", async () => {
    const { agent } = await apiSetup();
    const r = await agent.post("/api/transactions").send({ ticker: "AAPL", type: "BUY", shares: "1", price: "10", date: "2026-11-15" });
    expect(r.status).toBe(201);
    expect(r.body.fx).toMatchObject({ date: "2026-11-13", provisional: false });
    const paidInReais = await agent.post("/api/transactions").send({ ticker: "AAPL", type: "BUY", shares: "1", price: "55", date: "2026-11-16", currency: "BRL" });
    expect(paidInReais.status).toBe(201);
    const list = (await agent.get("/api/transactions")).body;
    expect(list.map((t: any) => [t.currency, t.fx?.date, t.fx?.sell.USD])).toEqual([
      ["USD", "2026-11-13", "5.41"],
      ["BRL", "2026-11-16", "5.51"],
    ]);
  });

  it("moeda fora da lista é recusada", async () => {
    const { agent } = await apiSetup();
    const r = await agent.post("/api/transactions").send({ ticker: "AAPL", type: "BUY", shares: "1", price: "10", date: "2026-11-13", currency: "JPY" });
    expect(r.status).toBe(400);
  });

  it("Banco Central fora do ar: a operação é gravada mesmo assim, com PTAX pendente", async () => {
    const app = createApp(openDatabase(":memory:"), loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
      finnhubFetch: async () => ({ c: 100 }),
    }); // offline: the default test fetch never reaches the network
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ email: "ana@example.com", password: PASSWORD, confirmPassword: PASSWORD });
    const tabId = (await agent.get("/api/tabs")).body[0].id;
    await agent.post("/api/stocks").send({ ticker: "AAPL", name: "Apple", tabId });
    const r = await agent.post("/api/transactions").send({ ticker: "AAPL", type: "BUY", shares: "1", price: "10", date: "2026-11-13" });
    expect(r.status).toBe(201);
    expect(r.body.fx).toBeNull();
  });
});

describe("API: classificação", () => {
  it("ativo nasce com a classificação padrão do tipo; muda só o que foi enviado; null = não definido", async () => {
    const { agent } = await apiSetup();
    expect((await agent.get("/api/stocks")).body[0]).toMatchObject({ liquidity: "liquid", horizon: null, jurisdiction: "offshore", currency: "USD" });
    const r = await agent.patch("/api/stocks/AAPL/classification").send({ horizon: "long" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ liquidity: "liquid", horizon: "long", jurisdiction: "offshore" });
    expect((await agent.patch("/api/stocks/AAPL/classification").send({ jurisdiction: null })).body).toMatchObject({ horizon: "long", jurisdiction: null });
  });

  it("valores inválidos, campos desconhecidos e corpo vazio são recusados", async () => {
    const { agent } = await apiSetup();
    // a valid field next to an unknown one is refused too (nothing is silently ignored)
    for (const body of [{ horizon: "eterno" }, { liquidity: null }, { currency: "EUR" }, { horizon: "long", currency: "EUR" }, {}]) {
      expect((await agent.patch("/api/stocks/AAPL/classification").send(body)).status).toBe(400);
    }
    expect((await agent.patch("/api/stocks/MSFT/classification").send({ horizon: "long" })).status).toBe(404);
  });

  it("aplicar a todos da aba muda só os ativos daquela aba e daquela carteira", async () => {
    const { agent, tabId } = await apiSetup();
    await agent.post("/api/stocks").send({ ticker: "MSFT", name: "Microsoft", tabId });
    const other = (await agent.post("/api/portfolios").send({ name: "Outra", color: "#089981" })).body;
    const otherTab = (await agent.get("/api/tabs").set("X-Portfolio-Id", String(other.id))).body[0].id;
    await agent.post("/api/stocks").set("X-Portfolio-Id", String(other.id)).send({ ticker: "AAPL", name: "Apple", tabId: otherTab });

    const r = await agent.post(`/api/tabs/${tabId}/classification`).send({ horizon: "medium" });
    expect(r.body).toEqual({ success: true, changed: 2 });
    expect((await agent.get("/api/stocks")).body.map((s: any) => s.horizon)).toEqual(["medium", "medium"]);
    expect((await agent.get("/api/stocks").set("X-Portfolio-Id", String(other.id))).body[0].horizon).toBeNull();
    // the other portfolio's tab, from this portfolio: not found
    expect((await agent.post(`/api/tabs/${otherTab}/classification`).send({ horizon: "long" })).status).toBe(404);
  });

  it("backup leva e traz classificação, moeda e PTAX; backup antigo ganha os valores padrão", async () => {
    const { agent } = await apiSetup();
    await agent.patch("/api/stocks/AAPL/classification").send({ horizon: "ultra_long", jurisdiction: null });
    await agent.post("/api/transactions").send({ ticker: "AAPL", type: "BUY", shares: "1", price: "55", date: "2026-11-13", currency: "BRL" });
    const backup = (await agent.get("/api/export")).body;
    expect(backup.stocks[0]).toMatchObject({ horizon: "ultra_long", jurisdiction: null });
    expect(backup.transactions[0]).toMatchObject({ currency: "BRL", fx: { date: "2026-11-13" } });

    expect((await agent.post("/api/import").send(backup)).status).toBe(200);
    expect((await agent.get("/api/stocks")).body[0]).toMatchObject({ horizon: "ultra_long", jurisdiction: null });
    expect((await agent.get("/api/transactions")).body[0]).toMatchObject({ currency: "BRL", fx: { date: "2026-11-13", sell: { USD: "5.41" } } });

    // a backup from before v0.14.0 has none of these fields
    const old = structuredClone(backup);
    for (const s of old.stocks) for (const k of ["liquidity", "horizon", "jurisdiction", "currency"]) delete s[k];
    for (const t of old.transactions) {
      delete t.currency;
      delete t.fx;
    }
    expect((await agent.post("/api/import").send(old)).status).toBe(200);
    expect((await agent.get("/api/stocks")).body[0]).toMatchObject({ liquidity: "liquid", horizon: null, jurisdiction: "offshore", currency: "USD" });
    expect((await agent.get("/api/transactions")).body[0]).toMatchObject({ currency: "USD", fx: null });
  });
});

// ---------------------------------------------------------------------------
// Findings of the independent review (each failed on the first version)
// ---------------------------------------------------------------------------
describe("achados da revisão independente", () => {
  it("operação em outra moeda sem PTAX e sem câmbio NUNCA entra sem conversão: fica fora da conta", () => {
    const fx13: FxSnapshot = { date: "2026-11-13", provisional: false, buy: { USD: "5" }, sell: { USD: "5" } };
    const trades = [
      { type: "BUY" as const, shares: "1", price: "100", date: "2026-11-13", currency: "USD", fx: fx13 },
      { type: "BUY" as const, shares: "1", price: "500", date: "2026-11-14", currency: "BRL", fx: null }, // R$ 500, no PTAX
    ];
    const p = positionIn(trades, "USD", 100, "USD", null)!;
    expect(p).toMatchObject({ shares: 1, avgCost: 100, missing: 1 }); // before: 2 shares at US$ 300
    // with today's rate it enters, converted, and is flagged as approximate
    expect(positionIn(trades, "USD", 100, "USD", { USD: "5" })).toMatchObject({ shares: 2, avgCost: 100, approx: 1, missing: 0 });
  });

  it("data antiga sem euro: PTAX só com USD, definitiva e guardada; converter para EUR cai no câmbio de hoje", async () => {
    const bcb = fakeBcb({ "1998-06-10": { USD: [1.15, 1.151], CHF: [0.8, 0.81] } });
    const db = ptaxDb();
    const ptax = createPtax(db, { fetchJson: bcb.fetch, now: () => at("2026-11-17") });
    const snap = (await ptax.snapshotFor("1998-06-10"))!;
    expect(snap).toEqual({ date: "1998-06-10", provisional: false, buy: { USD: "1.15", CHF: "0.8" }, sell: { USD: "1.151", CHF: "0.81" } });
    await ptax.snapshotFor("1998-06-10");
    expect(bcb.urls).toHaveLength(3); // cached: not asked again
    const trade = [{ type: "BUY" as const, shares: "1", price: "10", date: "1998-06-10", currency: "USD", fx: snap }];
    expect(convertTrades(trade, "USD", "BRL", null)).toMatchObject({ approx: 0, trades: [{ price: "11.51" }] });
    expect(convertTrades(trade, "USD", "EUR", { USD: "6", EUR: "7" })).toMatchObject({ approx: 1, missing: 0 });
  });

  it("data recente sem euro na resposta: não congela incompleta, tenta de novo", async () => {
    const ptax = createPtax(ptaxDb(), { fetchJson: fakeBcb({ "2026-11-13": { USD: [5.4, 5.41], CHF: [6.6, 6.61] } }).fetch, now: () => at("2026-11-17") });
    expect(await ptax.snapshotFor("2026-11-13")).toBeNull();
  });

  it("data em que o BCB não tem PTAX nenhuma: para de perguntar", async () => {
    const bcb = fakeBcb({});
    const db = ptaxDb();
    seedTrade(db, "1980-06-10", null);
    const ptax = createPtax(db, { fetchJson: bcb.fetch, now: () => at("2026-11-17") });
    expect(await ptax.refreshPending()).toBe(0);
    expect(bcb.urls).toHaveLength(3);
    expect(await ptax.refreshPending()).toBe(0);
    expect(await ptax.snapshotFor("1980-06-10")).toBeNull();
    expect(bcb.urls).toHaveLength(3); // never again (before: 3 more requests every 30 min, forever)
  });

  it("datas futuras esperam o dia delas e não ocupam a vez das passadas na rodada", async () => {
    const bcb = fakeBcb();
    const db = ptaxDb();
    seedTrade(db, "2026-11-13", null);
    db.prepare(
      `INSERT INTO transactions (user_id, portfolio_id, ticker, type, shares, price, shares_dec, price_dec, date, created_at)
       VALUES (1, 1, 'AAPL', 'BUY', 1, 10, '1', '10', '2026-12-31', ?)`
    ).run(T);
    const ptax = createPtax(db, { fetchJson: bcb.fetch, now: () => at("2026-11-17") });
    expect(await ptax.refreshPending(1)).toBe(1); // a round of ONE date: the past one, not the future one
    expect((db.prepare(`SELECT date FROM transactions WHERE fx IS NOT NULL`).all() as Array<{ date: string }>).map((r) => r.date)).toEqual(["2026-11-13"]);
  });

  it("erro do BCB numa data (4xx) não trava as outras datas", async () => {
    const db = ptaxDb();
    seedTrade(db, "2026-11-13", null);
    db.prepare(
      `INSERT INTO transactions (user_id, portfolio_id, ticker, type, shares, price, shares_dec, price_dec, date, created_at)
       VALUES (1, 1, 'AAPL', 'BUY', 1, 10, '1', '10', '2026-11-16', ?)`
    ).run(T);
    const ok = fakeBcb().fetch;
    const status = 400;
    const fetch: DataFetch = async (url) => {
      if (decodeURIComponent(url).includes("@dataInicial='11-06-2026'")) throw Object.assign(new Error("x"), { status }); // 16/11 - 10 days
      return ok(url);
    };
    expect(await createPtax(db, { fetchJson: fetch, now: () => at("2026-11-17") }).refreshPending()).toBe(1); // 13/11 still done
    expect((db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE fx IS NULL`).get() as { n: number }).n).toBe(1);
  });

  it("restore: PTAX incoerente (data depois da operação ou câmbio absurdo) é descartada e buscada de novo", async () => {
    const { agent } = await apiSetup();
    await agent.post("/api/transactions").send({ ticker: "AAPL", type: "BUY", shares: "1", price: "10", date: "2026-11-13" });
    const backup = (await agent.get("/api/export")).body;
    const forged = structuredClone(backup);
    forged.transactions[0].fx = { ...forged.transactions[0].fx, date: "2026-11-16" }; // after the trade
    expect((await agent.post("/api/import").send(forged)).status).toBe(200);
    expect((await agent.get("/api/transactions")).body[0].fx).toBeNull();
    const absurd = structuredClone(backup);
    absurd.transactions[0].fx.sell.USD = "0.0000000001";
    expect((await agent.post("/api/import").send(absurd)).status).toBe(200);
    expect((await agent.get("/api/transactions")).body[0].fx).toBeNull();
    expect((await agent.post("/api/import").send(backup)).status).toBe(200); // the real one stays
    expect((await agent.get("/api/transactions")).body[0].fx).toMatchObject({ date: "2026-11-13", sell: { USD: "5.41" } });
  });

  it("venda acima da posição é recusada antes de perguntar ao BCB", async () => {
    const { agent, bcb } = await apiSetup();
    const r = await agent.post("/api/transactions").send({ ticker: "AAPL", type: "SELL", shares: "1", price: "10", date: "2026-11-13" });
    expect(r.status).toBe(400);
    expect(bcb.urls).toHaveLength(0);
  });

  it("banco muito antigo direto para a v8: cripto não vira offshore", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, 4);
    db.prepare(`INSERT INTO users (email, display_name, password_hash, created_at, updated_at) VALUES ('a@test.local', 'A', 'h', ?, ?)`).run(T, T);
    db.prepare(`INSERT INTO stocks (user_id, ticker, name, created_at) VALUES (1, 'X:BTCUSD', 'Bitcoin', ?)`).run(T);
    db.prepare(`INSERT INTO stocks (user_id, ticker, name, created_at) VALUES (1, 'AAPL', 'Apple', ?)`).run(T);
    migrate(db);
    expect(db.prepare(`SELECT ticker, asset_type, jurisdiction FROM stocks ORDER BY ticker`).all()).toEqual([
      { ticker: "AAPL", asset_type: "us_stock", jurisdiction: "offshore" },
      { ticker: "X:BTCUSD", asset_type: "crypto", jurisdiction: null },
    ]);
  });
});
