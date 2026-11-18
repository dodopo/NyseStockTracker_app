/**
 * v0.16.0: illiquid assets (dated valuations), cash accounts and custody.
 */
import Database from "better-sqlite3";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { loadConfig } from "../server/config";
import { migrate, openDatabase, SCHEMA_VERSION } from "../server/db";
import { assetLabel, assetTypeOfTicker, isManualTicker } from "../shared/assetTypes";
import { defaultClassification } from "../shared/classification";
import { STALE_VALUATION_DAYS, latestValuation, manualPrice } from "../shared/manualAssets";
import { isValidTicker } from "../shared/validation";
import { assetsLeftOut, buildRows, maturityAllocation, valueByPortfolio } from "../src/features/consolidated/rows";
import type { Stock, Transaction } from "../src/types";

const PASSWORD = "correct-horse-battery";

async function setup() {
  const db = openDatabase(":memory:");
  const quoted: string[] = [];
  const app = createApp(db, loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
    finnhubFetch: async (url: string) => {
      quoted.push(new URL(url).searchParams.get("symbol") ?? "");
      return { c: 100, d: 1, dp: 1, h: 101, l: 99, o: 99, pc: 99 };
    },
  });
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/register").send({ email: "ana@example.com", password: PASSWORD, confirmPassword: PASSWORD })).status).toBe(201);
  await agent.post("/api/auth/finnhub-key").send({ apiKey: "test-key-123456" });
  const tab = async (name: string, assetType: string) =>
    (await agent.post("/api/tabs").send({ name, assetType, color: "#089981" })).body.id as number;
  const illiquidTab = await tab("Imóveis", "illiquid");
  const cashTab = await tab("Caixa", "cash");
  const stockTab = (await agent.get("/api/tabs")).body[0].id as number;
  const manual = async (name: string, tabId: number, currency = "BRL") => agent.post("/api/stocks/manual").send({ name, tabId, currency });
  return { db, agent, app, illiquidTab, cashTab, stockTab, manual, quoted };
}

describe("tipos novos: identidade, rótulo e classificação inicial", () => {
  it("I:/C: + 10 letras ou dígitos; o nome aparece no lugar do código", () => {
    expect(isValidTicker("I:ABCDEFGH23")).toBe(true);
    expect(isValidTicker("C:ABCDEFGH23")).toBe(true);
    expect(isValidTicker("I:ABC")).toBe(false);
    expect(isValidTicker("Z:ABCDEFGH23")).toBe(false);
    expect(assetTypeOfTicker("I:ABCDEFGH23")).toBe("illiquid");
    expect(assetTypeOfTicker("C:ABCDEFGH23")).toBe("cash");
    expect(assetTypeOfTicker("X:BTCUSD")).toBe("crypto");
    expect(assetTypeOfTicker("C")).toBe("us_stock"); // Citigroup stays a stock
    expect(assetLabel({ ticker: "I:ABCDEFGH23", name: "Apto Icaraí" })).toBe("Apto Icaraí");
    expect(assetLabel({ ticker: "X:BTCUSD", name: "Bitcoin" })).toBe("BTC");
  });

  it("ilíquido nasce ilíquido; caixa nasce líquido e curtíssimo; ação EUA em instituição; o resto sem custódia", () => {
    expect(defaultClassification("illiquid")).toEqual({ liquidity: "illiquid", horizon: null, jurisdiction: null, custody: null });
    expect(defaultClassification("cash")).toEqual({ liquidity: "liquid", horizon: "ultra_short", jurisdiction: null, custody: null });
    expect(defaultClassification("us_stock").custody).toBe("institution");
    expect(defaultClassification("crypto").custody).toBeNull();
  });
});

describe("preço de ativo sem cotação", () => {
  const vals = [
    { id: 1, date: "2025-01-10", price: "500000", note: "" },
    { id: 2, date: "2026-03-01", price: "650000", note: "laudo" },
    { id: 3, date: "2027-01-01", price: "999999", note: "futura" },
  ];

  it("vale a última avaliação até hoje (uma data futura ainda não conta)", () => {
    expect(latestValuation(vals, "2026-11-18")?.id).toBe(2);
    expect(latestValuation(vals, "2026-03-01")?.id).toBe(2);
    expect(latestValuation(vals, "2026-02-28")?.id).toBe(1);
    expect(latestValuation(vals, "2024-01-01")).toBeNull();
    const p = manualPrice("illiquid", vals, 400000, "2026-11-18")!;
    expect(p).toMatchObject({ price: 650000, source: "valuation", date: "2026-03-01", ageDays: 262, stale: false });
  });

  it("avaliação com mais de 365 dias é marcada; exatamente 365 ainda não", () => {
    expect(manualPrice("illiquid", vals, 0, "2027-03-01")!.stale).toBe(false); // 2027-01-01 counts now
    const old = [{ id: 1, date: "2025-01-10", price: "1", note: "" }];
    expect(manualPrice("illiquid", old, 0, "2026-01-10")!).toMatchObject({ ageDays: STALE_VALUATION_DAYS, stale: false });
    expect(manualPrice("illiquid", old, 0, "2026-01-11")!.stale).toBe(true);
  });

  it("sem avaliação vale pelo custo; caixa vale 1; ativo de mercado não tem preço manual", () => {
    expect(manualPrice("illiquid", [], 1234.5, "2026-11-18")).toMatchObject({ price: 1234.5, source: "cost" });
    expect(manualPrice("cash", undefined, 0, "2026-11-18")).toMatchObject({ price: 1, source: "cash" });
    expect(manualPrice("us_stock", vals, 10, "2026-11-18")).toBeNull();
  });
});

describe("consolidado com ilíquido e caixa", () => {
  const live = { USD: "5", EUR: "6", CHF: "6.25" };
  const tx = (id: number, ticker: string, type: "BUY" | "SELL", shares: string, price: string, currency: "BRL" | "USD", date = "2025-01-02"): Transaction => ({
    id, ticker, type, shares, price, date, sort_order: id, currency, fx: null,
  });

  it("ilíquido em BRL pela avaliação, caixa em USD pelo saldo; tudo convertido; somem sem câmbio só se não for a moeda pedida", () => {
    const stocks: Stock[] = [
      { ticker: "I:AAAAAAAAAA", name: "Apto", asset_type: "illiquid", currency: "BRL", portfolio_id: 1, valuations: [{ id: 1, date: "2025-06-01", price: "600000", note: "" }] },
      { ticker: "C:BBBBBBBBBB", name: "Conta USD", asset_type: "cash", currency: "USD", portfolio_id: 1 },
    ];
    // trades are matched to assets by portfolio and ticker
    const transactions = [tx(1, "I:AAAAAAAAAA", "BUY", "1", "500000", "BRL"), tx(2, "C:BBBBBBBBBB", "BUY", "1000", "1", "USD"), tx(3, "C:BBBBBBBBBB", "SELL", "200", "1", "USD")].map(
      (t) => ({ ...t, portfolio_id: 1 })
    );
    const brl = buildRows(stocks, transactions, {}, "BRL", live, "2026-11-18");
    const apto = brl.find((r) => r.ticker === "I:AAAAAAAAAA")!;
    expect(apto).toMatchObject({ currentPrice: 600000, marketValue: 600000, unrealizedPnL: 100000, assetType: "illiquid", liquidity: "illiquid" });
    expect(apto.manualPrice).toMatchObject({ source: "valuation", date: "2025-06-01" });
    const cash = brl.find((r) => r.ticker === "C:BBBBBBBBBB")!;
    expect(cash.marketValue).toBeCloseTo(800 * 5, 9);
    expect(cash).toMatchObject({ assetType: "cash", liquidity: "liquid", horizon: "ultra_short" });
    // the switcher: dollars, with today's rates the asset in reais is summed too
    expect(valueByPortfolio(buildRows(stocks, transactions, {}, "USD", live, "2026-11-18")).get(1)).toBeCloseTo(600000 / 5 + 800, 9);
    // without rates (the bug the switcher had): the asset in reais is left out
    expect(buildRows(stocks, transactions, {}, "USD", null, "2026-11-18").map((r) => r.ticker)).toEqual(["C:BBBBBBBBBB"]);
    // ...and the screen is told how many, never just a smaller total
    expect(assetsLeftOut(stocks, "USD", null)).toBe(1);
    expect(assetsLeftOut(stocks, "USD", live)).toBe(0);
    expect(assetsLeftOut(stocks, "BRL", null)).toBe(1);
  });

  it("ilíquido sem avaliação: valor = custo, resultado zero", () => {
    const stocks: Stock[] = [{ ticker: "I:AAAAAAAAAA", name: "Fazenda", asset_type: "illiquid", currency: "BRL", valuations: [] }];
    const [row] = buildRows(stocks, [tx(1, "I:AAAAAAAAAA", "BUY", "2", "150", "BRL"), tx(2, "I:AAAAAAAAAA", "BUY", "2", "250", "BRL")], {}, "BRL", live, "2026-11-18");
    expect(row).toMatchObject({ currentPrice: 200, marketValue: 800, unrealizedPnL: 0 });
    expect(row.manualPrice?.source).toBe("cost");
  });

  it("maturação: caixa fica na faixa da tese (não tem tranche que matura)", () => {
    const stocks: Stock[] = [{ ticker: "C:BBBBBBBBBB", name: "Cofre", asset_type: "cash", currency: "BRL", horizon: "ultra_short", target_days: 30 }];
    const transactions = [tx(1, "C:BBBBBBBBBB", "BUY", "1000", "1", "BRL", "2020-01-01")];
    const rows = buildRows(stocks, transactions, {}, "BRL", live, "2026-11-18");
    expect([...maturityAllocation(rows, stocks, transactions, "2026-11-18", live).entries()]).toEqual([["ultra_short", 1000]]);
  });
});

describe("API: ativo ilíquido e caixa", () => {
  it("cadastro pelo nome na aba do tipo, com a moeda escolhida; a busca não cria esses ativos", async () => {
    const { agent, illiquidTab, cashTab, stockTab, manual } = await setup();
    const r = await manual("Apto Icaraí", illiquidTab, "BRL");
    expect(r.status).toBe(201);
    expect(isManualTicker(r.body.ticker) && r.body.ticker.startsWith("I:")).toBe(true);
    expect(r.body).toMatchObject({ name: "Apto Icaraí", asset_type: "illiquid", currency: "BRL", liquidity: "illiquid", custody: null, valuations: [] });
    const c = (await manual("Conta Avenue", cashTab, "USD")).body;
    expect(c).toMatchObject({ asset_type: "cash", currency: "USD", liquidity: "liquid", horizon: "ultra_short", target_days: 30 });
    expect(c.ticker.startsWith("C:")).toBe(true);

    expect((await manual("Errado", stockTab)).status).toBe(400); // a search tab
    expect((await manual("", illiquidTab)).status).toBe(400);
    expect((await agent.post("/api/stocks/manual").send({ name: "X", tabId: illiquidTab, currency: "JPY" })).status).toBe(400);
    expect((await agent.post("/api/stocks/manual").send({ name: "X", tabId: illiquidTab, currency: "BRL", ticker: "I:ZZZZZZZZZZ" })).status).toBe(400);
    // the identity is never chosen by the client
    expect((await agent.post("/api/stocks").send({ ticker: "I:ZZZZZZZZZZ", name: "X", tabId: illiquidTab })).status).toBe(400);
    expect((await agent.post("/api/stocks").send({ ticker: "AAPL", name: "Apple", tabId: illiquidTab })).status).toBe(400);
  });

  it("renomeia só ilíquido e caixa", async () => {
    const { agent, illiquidTab, stockTab, manual } = await setup();
    const { ticker } = (await manual("Sala", illiquidTab)).body;
    const r = await agent.patch(`/api/stocks/${ticker}`).send({ name: "Sala comercial Centro" });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("Sala comercial Centro");
    await agent.post("/api/stocks").send({ ticker: "AAPL", name: "Apple", tabId: stockTab });
    expect((await agent.patch("/api/stocks/AAPL").send({ name: "Maçã" })).status).toBe(400);
    expect((await agent.patch(`/api/stocks/I:ZZZZZZZZZZ`).send({ name: "Nada" })).status).toBe(404);
  });

  it("avaliações: uma por data, editar, apagar; só em ilíquido; somem com o ativo", async () => {
    const { agent, db, illiquidTab, cashTab, manual } = await setup();
    const { ticker } = (await manual("Apto", illiquidTab)).body;
    const add = (body: object) => agent.post(`/api/stocks/${ticker}/valuations`).send(body);
    expect((await add({ date: "2025-01-10", price: "500000", note: "compra" })).status).toBe(201);
    const list = (await add({ date: "2026-03-01", price: "650000.50" })).body;
    expect(list.map((v: any) => [v.date, v.price, v.note])).toEqual([["2025-01-10", "500000", "compra"], ["2026-03-01", "650000.5", ""]]);
    const dup = await add({ date: "2026-03-01", price: "1" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain("01/03/2026");
    expect((await add({ date: "2026-13-01", price: "1" })).status).toBe(400);
    expect((await add({ date: "2026-04-01", price: "-1" })).status).toBe(400);
    expect((await add({ date: "2026-04-01", price: "1", note: "x".repeat(201) })).status).toBe(400);

    const [v1, v2] = list;
    const moved = await agent.patch(`/api/valuations/${v2.id}`).send({ date: "2025-01-10", price: "1" });
    expect(moved.status).toBe(409); // would collide with v1
    const edited = await agent.patch(`/api/valuations/${v2.id}`).send({ date: "2026-03-02", price: "700000", note: "laudo" });
    expect(edited.body.map((v: any) => [v.date, v.price, v.note])).toEqual([["2025-01-10", "500000", "compra"], ["2026-03-02", "700000", "laudo"]]);

    const stocks = (await agent.get("/api/stocks")).body as any[];
    expect(stocks.find((s) => s.ticker === ticker).valuations).toHaveLength(2);
    expect((await agent.delete(`/api/valuations/${v1.id}`)).status).toBe(204);
    expect((await agent.delete(`/api/valuations/${v1.id}`)).status).toBe(204); // idempotent

    const cash = (await manual("Cofre", cashTab)).body.ticker;
    expect((await agent.post(`/api/stocks/${cash}/valuations`).send({ date: "2026-01-01", price: "1" })).status).toBe(400);

    expect((await agent.delete(`/api/stocks/${ticker}`)).status).toBe(204);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM valuations`).get()).toEqual({ n: 0 });
  });

  it("teto de avaliações na conta = o que um backup consegue restaurar", async () => {
    const { agent, db, illiquidTab, manual } = await setup();
    const a = (await manual("A", illiquidTab)).body.ticker;
    const c = (await manual("C", illiquidTab)).body.ticker;
    const idA = (db.prepare(`SELECT id FROM stocks WHERE ticker = ?`).get(a) as { id: number }).id;
    const ins = db.prepare(`INSERT INTO valuations (stock_id, date, price, note, created_at) VALUES (?, ?, '1', '', 'x')`);
    const day = (i: number) => new Date(Date.UTC(1950, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    db.transaction(() => {
      for (let i = 0; i < 20_000; i++) ins.run(idA, day(i)); // set up by hand: the API stops at 1,000 per asset
    })();
    // a fresh asset (no per-asset limit hit) still cannot pass the account limit
    const r = await agent.post(`/api/stocks/${c}/valuations`).send({ date: "2099-12-31", price: "1" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("na conta");
  });

  it("avaliação de outra carteira ou de outro usuário não é achada", async () => {
    const { agent, app, illiquidTab, manual } = await setup();
    const { ticker } = (await manual("Apto", illiquidTab)).body;
    const [v] = (await agent.post(`/api/stocks/${ticker}/valuations`).send({ date: "2025-01-10", price: "500000" })).body;
    const other = (await agent.post("/api/portfolios").send({ name: "Outra", color: "#089981" })).body;
    expect((await agent.patch(`/api/valuations/${v.id}`).set("X-Portfolio-Id", String(other.id)).send({ date: "2025-01-10", price: "1" })).status).toBe(404);
    expect((await agent.delete(`/api/valuations/${v.id}`).set("X-Portfolio-Id", String(other.id))).status).toBe(204);
    expect((await agent.post(`/api/stocks/${ticker}/valuations`).set("X-Portfolio-Id", String(other.id)).send({ date: "2025-02-10", price: "1" })).status).toBe(404);

    const bia = request.agent(app);
    await bia.post("/api/auth/register").send({ email: "bia@example.com", password: PASSWORD, confirmPassword: PASSWORD });
    expect((await bia.patch(`/api/valuations/${v.id}`).send({ date: "2025-01-10", price: "1" })).status).toBe(404);
    expect((await bia.delete(`/api/valuations/${v.id}`)).status).toBe(204);
    const still = (await agent.get("/api/stocks")).body.find((s: any) => s.ticker === ticker).valuations;
    expect(still.map((x: any) => x.price)).toEqual(["500000"]);
  });

  it("caixa: na própria moeda o preço é 1; em outra moeda, o câmbio pago; saque maior que o saldo é recusado", async () => {
    const { agent, cashTab, manual } = await setup();
    const { ticker } = (await manual("Conta USD", cashTab, "USD")).body;
    const move = (body: object) => agent.post("/api/transactions").send({ ticker, date: "2025-03-03", ...body });
    expect((await move({ type: "BUY", shares: "1000", price: "1" })).status).toBe(201);
    const wrong = await move({ type: "BUY", shares: "1000", price: "5.4" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain("cada unidade vale 1");
    expect((await move({ type: "BUY", shares: "500", price: "5.4", currency: "BRL" })).status).toBe(201);
    expect((await move({ type: "SELL", shares: "1600", price: "1" })).status).toBe(400);
    expect((await move({ type: "SELL", shares: "1500", price: "1" })).status).toBe(201);
  });

  it("cotação: ilíquido e caixa nunca vão à Finnhub; pedido direto é recusado", async () => {
    const { agent, cashTab, manual, quoted } = await setup();
    const { ticker } = (await manual("Cofre", cashTab)).body;
    const r = await agent.get(`/api/prices?symbols=AAPL,${ticker}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(["AAPL"]);
    expect((await agent.get(`/api/prices?symbols=${ticker}`)).body).toEqual({});
    expect((await agent.get(`/api/quote?symbol=${ticker}`)).status).toBe(400);
    expect((await agent.get(`/api/candles?symbol=${ticker}`)).status).toBe(400);
    expect((await agent.get(`/api/stats?symbol=${ticker}`)).status).toBe(400);
    expect(quoted).not.toContain(ticker);
  });

  it("custódia: por ativo e por aba; valor inválido recusado", async () => {
    const { agent, cashTab, manual } = await setup();
    const a = (await manual("Cofre de casa", cashTab)).body.ticker;
    const b = (await manual("Conta", cashTab)).body.ticker;
    expect((await agent.patch(`/api/stocks/${a}/classification`).send({ custody: "self" })).body.custody).toBe("self");
    expect((await agent.patch(`/api/stocks/${a}/classification`).send({ custody: "bank" })).status).toBe(400);
    expect((await agent.post(`/api/tabs/${cashTab}/classification`).send({ custody: "institution" })).body.changed).toBe(2);
    const all = (await agent.get("/api/stocks")).body as any[];
    expect(all.filter((s) => s.ticker === a || s.ticker === b).map((s) => s.custody)).toEqual(["institution", "institution"]);
    expect((await agent.patch(`/api/stocks/${a}/classification`).send({ custody: null })).body.custody).toBeNull();
  });

  it("backup: ilíquido, caixa, moedas, custódia e avaliações vão e voltam; lixo é pulado", async () => {
    const { agent, illiquidTab, cashTab, manual } = await setup();
    const apto = (await manual("Apto", illiquidTab, "EUR")).body.ticker;
    const cofre = (await manual("Cofre", cashTab, "CHF")).body.ticker;
    await agent.patch(`/api/stocks/${cofre}/classification`).send({ custody: "self", jurisdiction: "offshore" });
    await agent.post(`/api/stocks/${apto}/valuations`).send({ date: "2025-01-10", price: "300000", note: "laudo" });
    await agent.post(`/api/stocks/${apto}/valuations`).send({ date: "2026-01-10", price: "320000" });
    await agent.post("/api/transactions").send({ ticker: apto, type: "BUY", shares: "1", price: "280000", date: "2024-12-01" });
    await agent.post("/api/transactions").send({ ticker: cofre, type: "BUY", shares: "5000", price: "1", date: "2025-01-02" });

    const backup = (await agent.get("/api/export")).body;
    expect(backup.valuations).toHaveLength(2);
    backup.valuations.push({ portfolio_id: backup.valuations[0].portfolio_id, ticker: apto, date: "2026-01-10", price: "1" }); // same date
    backup.valuations.push({ portfolio_id: backup.valuations[0].portfolio_id, ticker: cofre, date: "2026-01-11", price: "1" }); // cash
    backup.valuations.push({ portfolio_id: backup.valuations[0].portfolio_id, ticker: apto, date: "nope", price: "1" });
    // a cash movement in its own currency with a price other than 1
    backup.transactions.push({ ticker: cofre, type: "BUY", shares: "1", price: "7", date: "2025-02-02", currency: "CHF", portfolio_id: backup.valuations[0].portfolio_id });

    const r = await agent.post("/api/import").send(backup);
    expect(r.status).toBe(200);
    expect(r.body.skipped).toBe(4);
    const stocks = (await agent.get("/api/stocks")).body as any[];
    const a = stocks.find((s) => s.ticker === apto);
    const c = stocks.find((s) => s.ticker === cofre);
    expect(a).toMatchObject({ asset_type: "illiquid", currency: "EUR", liquidity: "illiquid" });
    expect(a.valuations.map((v: any) => [v.date, v.price, v.note])).toEqual([["2025-01-10", "300000", "laudo"], ["2026-01-10", "320000", ""]]);
    expect(c).toMatchObject({ asset_type: "cash", currency: "CHF", custody: "self", jurisdiction: "offshore" });
    const tabs = (await agent.get("/api/tabs")).body as any[];
    expect(tabs.map((t) => t.assetType).sort()).toEqual(["cash", "illiquid", "us_stock"]);
    expect(stocks.find((s) => s.ticker === apto).tab_id).toBe(tabs.find((t) => t.assetType === "illiquid").id);
  });
});

describe("migração v10", () => {
  it("abas ficam iguais (ids, ordem, contador), aceitam os tipos novos; ações EUA viram instituição; nada some", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, 9);
    const T = "2026-01-01T00:00:00.000Z";
    db.prepare(`INSERT INTO users (email, display_name, password_hash, created_at, updated_at) VALUES ('a@test.local', 'A', 'h', ?, ?)`).run(T, T);
    db.prepare(`INSERT INTO portfolios (user_id, name, color, created_at, updated_at) VALUES (1, 'P', '#2962ff', ?, ?)`).run(T, T);
    const tab = db.prepare(`INSERT INTO tabs (user_id, portfolio_id, name, asset_type, color, sort_order, created_at) VALUES (1, 1, ?, ?, '#2962ff', ?, ?)`);
    tab.run("Ações", "us_stock", 2, T);
    tab.run("Cripto", "crypto", 1, T);
    tab.run("Lixo", "crypto", 9, T);
    db.prepare(`DELETE FROM tabs WHERE name = 'Lixo'`).run(); // id 3 is gone: the counter must not fall back to 2
    expect(() => tab.run("Imóveis", "illiquid", 3, T)).toThrow(/CHECK/);
    const stock = db.prepare(`INSERT INTO stocks (user_id, portfolio_id, ticker, name, created_at, asset_type, tab_id) VALUES (1, 1, ?, ?, ?, ?, ?)`);
    stock.run("AAPL", "Apple", T, "us_stock", 1);
    stock.run("X:BTCUSD", "Bitcoin", T, "crypto", 2);
    db.prepare(`INSERT INTO transactions (user_id, portfolio_id, ticker, type, shares, price, date, created_at, shares_dec, price_dec) VALUES (1, 1, 'AAPL', 'BUY', 1, 10, '2025-01-01', ?, '1', '10')`).run(T);
    const tabsBefore = db.prepare(`SELECT * FROM tabs ORDER BY id`).all();
    const stocksBefore = db.prepare(`SELECT * FROM stocks ORDER BY id`).all();
    const txBefore = db.prepare(`SELECT * FROM transactions ORDER BY id`).all();

    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(10);
    expect(db.prepare(`SELECT * FROM tabs ORDER BY id`).all()).toEqual(tabsBefore);
    const after = db.prepare(`SELECT * FROM stocks ORDER BY id`).all() as any[];
    after.forEach((row, i) => expect(row).toMatchObject(stocksBefore[i] as object));
    expect(after.map((s) => [s.ticker, s.custody])).toEqual([["AAPL", "institution"], ["X:BTCUSD", null]]);
    expect(db.prepare(`SELECT * FROM transactions ORDER BY id`).all()).toEqual(txBefore);
    // new types accepted, the counter kept (no id reused), FKs intact
    const id = Number(tab.run("Imóveis", "illiquid", 3, T).lastInsertRowid);
    expect(id).toBe(4);
    tab.run("Caixa", "cash", 4, T);
    expect(() => tab.run("X", "bond", 5, T)).toThrow(/CHECK/);
    expect(() => db.prepare(`UPDATE stocks SET custody = 'bank' WHERE id = 1`).run()).toThrow(/CHECK/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    // a deleted tab still leaves its assets without a tab (ON DELETE SET NULL survived the rebuild)
    db.prepare(`DELETE FROM tabs WHERE id = 2`).run();
    expect((db.prepare(`SELECT tab_id FROM stocks WHERE ticker = 'X:BTCUSD'`).get() as any).tab_id).toBeNull();
  });
});
