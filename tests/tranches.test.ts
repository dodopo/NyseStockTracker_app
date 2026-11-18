/**
 * v0.15.0: tranches and maturity (shared/tranches.ts), with fixed dates.
 */
import { describe, expect, it } from "vitest";
import { calculatePosition } from "../shared/positions";
import { defaultTargetDays, maturityOf, replayTranches, type TrancheTrade } from "../shared/tranches";

const buy = (id: number, date: string, shares: string, extra: Partial<TrancheTrade> = {}): TrancheTrade => ({ id, type: "BUY", shares, price: "10", date, sort_order: id, ...extra });
const sell = (id: number, date: string, shares: string, extra: Partial<TrancheTrade> = {}): TrancheTrade => ({ id, type: "SELL", shares, price: "12", date, sort_order: id, ...extra });

describe("tranches", () => {
  it("cada compra é uma tranche com data-alvo = compra + prazo (o da tranche, senão o do ativo)", () => {
    const r = replayTranches([buy(1, "2025-11-09", "1"), buy(2, "2026-11-15", "2", { target_days: 365 })], 1800);
    expect(r.errors).toEqual([]);
    expect(r.open.map((t) => [t.buyId, t.remaining, t.targetDays, t.targetDate])).toEqual([
      [1, "1", 1800, "2030-10-14"],
      [2, "2", 365, "2027-11-15"],
    ]);
  });

  it("venda sem escolha consome a mais antiga primeiro, atravessando tranches", () => {
    const r = replayTranches([buy(1, "2025-01-01", "1"), buy(2, "2025-06-01", "2"), sell(3, "2025-07-01", "1.5")], 1800);
    expect(r.open.map((t) => [t.buyId, t.remaining])).toEqual([[2, "1.5"]]);
  });

  it("venda com escolha tira exatamente das tranches escolhidas", () => {
    const r = replayTranches(
      [buy(1, "2025-01-01", "1"), buy(2, "2025-06-01", "2"), sell(3, "2025-07-01", "1.5", { lots: [{ buyId: 2, shares: "1.5" }] })],
      1800
    );
    expect(r.errors).toEqual([]);
    expect(r.open.map((t) => [t.buyId, t.remaining])).toEqual([[1, "1"], [2, "0.5"]]);
  });

  it("escolha impossível vira erro: mais que o restante, compra inexistente ou depois da venda, soma diferente", () => {
    const base = [buy(1, "2025-01-01", "1"), buy(2, "2025-06-01", "2")];
    expect(replayTranches([...base, sell(3, "2025-07-01", "1.5", { lots: [{ buyId: 1, shares: "1.5" }] })], 1).errors).toHaveLength(1);
    expect(replayTranches([...base, sell(3, "2025-07-01", "1", { lots: [{ buyId: 99, shares: "1" }] })], 1).errors).toHaveLength(1);
    expect(replayTranches([buy(1, "2025-01-01", "1"), sell(2, "2025-02-01", "1", { lots: [{ buyId: 3, shares: "1" }] }), buy(3, "2025-03-01", "1")], 1).errors).toHaveLength(1);
    expect(replayTranches([...base, sell(3, "2025-07-01", "1.5", { lots: [{ buyId: 1, shares: "1" }] })], 1).errors).toHaveLength(1);
  });

  it("venda automática anterior que come a tranche escolhida por uma venda posterior é detectada", () => {
    const trades = [
      buy(1, "2025-01-01", "1"),
      buy(2, "2025-06-01", "1"),
      sell(3, "2025-08-01", "1", { lots: [{ buyId: 1, shares: "1" }] }),
      sell(4, "2025-07-01", "1"), // backdated, oldest first: takes tranche 1
    ];
    expect(replayTranches(trades, 1).errors.length).toBeGreaterThan(0);
  });

  it("a soma das tranches abertas é sempre a posição", () => {
    const trades = [buy(1, "2025-01-01", "0.3"), buy(2, "2025-02-01", "0.7"), sell(3, "2025-03-01", "0.25"), buy(4, "2025-04-01", "1"), sell(5, "2025-05-01", "0.5", { lots: [{ buyId: 4, shares: "0.5" }] })];
    const open = replayTranches(trades, 1).open;
    const sum = open.reduce((s, t) => s + Number(t.remaining), 0);
    expect(sum).toBeCloseTo(calculatePosition(trades, 1).shares, 12);
  });

  it("maturação: dias que faltam e faixa de hoje; passou da data = maturada; sem alvo = não definido", () => {
    expect(maturityOf("2030-10-14", "2026-11-18")).toEqual({ daysLeft: 1426, bucket: "long" });
    expect(maturityOf("2027-11-15", "2026-11-18")).toEqual({ daysLeft: 362, bucket: "medium" });
    expect(maturityOf("2026-12-01", "2026-11-18")).toEqual({ daysLeft: 13, bucket: "ultra_short" });
    expect(maturityOf("2026-11-18", "2026-11-18")).toEqual({ daysLeft: 0, bucket: "matured" });
    expect(maturityOf(null, "2026-11-18")).toEqual({ daysLeft: null, bucket: "none" });
  });

  it("prazo-alvo inicial de cada faixa: o teto dela; Longuíssimo começa em 3.650", () => {
    expect([null, "ultra_short", "short", "medium", "long", "ultra_long"].map((h) => defaultTargetDays(h as any))).toEqual([null, 30, 180, 720, 1800, 3650]);
  });
});

// ---------------------------------------------------------------------------
// API and database
// ---------------------------------------------------------------------------
import Database from "better-sqlite3";
import request from "supertest";
import { createApp } from "../server/app";
import { loadConfig } from "../server/config";
import { migrate, openDatabase } from "../server/db";

const PASSWORD = "correct-horse-battery";

async function setup() {
  const db = openDatabase(":memory:");
  const app = createApp(db, loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
    finnhubFetch: async () => ({ c: 100, d: 1, dp: 1, h: 101, l: 99, o: 99, pc: 99 }),
  });
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/register").send({ email: "ana@example.com", password: PASSWORD, confirmPassword: PASSWORD })).status).toBe(201);
  const tabId = (await agent.get("/api/tabs")).body[0].id;
  for (const t of ["AAPL", "MSFT"]) expect((await agent.post("/api/stocks").send({ ticker: t, name: t, tabId })).status).toBe(201);
  const trade = async (body: object) => agent.post("/api/transactions").send({ ticker: "AAPL", price: "10", ...body });
  const ids = async () => ((await agent.get("/api/transactions?ticker=AAPL")).body as any[]).map((t) => [t.id, t.type, t.date, t.lots, t.target_days]);
  return { db, agent, tabId, trade, ids };
}

describe("API: prazo-alvo e tranches", () => {
  it("faixa e prazo-alvo andam juntos: faixa sozinha usa o teto; dias sozinhos definem a faixa; os dois em conflito são recusados", async () => {
    const { agent } = await setup();
    const c = (body: object) => agent.patch("/api/stocks/AAPL/classification").send(body);
    expect((await c({ horizon: "long" })).body).toMatchObject({ horizon: "long", target_days: 1800 });
    expect((await c({ targetDays: 900 })).body).toMatchObject({ horizon: "long", target_days: 900 });
    expect((await c({ targetDays: 100 })).body).toMatchObject({ horizon: "short", target_days: 100 });
    expect((await c({ horizon: "ultra_long" })).body).toMatchObject({ horizon: "ultra_long", target_days: 3650 });
    expect((await c({ horizon: "long", targetDays: 100 })).status).toBe(400);
    expect((await c({ targetDays: 0 })).status).toBe(400);
    expect((await c({ targetDays: 1.5 })).status).toBe(400);
    expect((await c({ targetDays: null })).body).toMatchObject({ horizon: null, target_days: null });
  });

  it("compra guarda o prazo da tranche; venda não aceita prazo; compra não escolhe tranches", async () => {
    const { trade, ids } = await setup();
    expect((await trade({ type: "BUY", shares: "1", date: "2025-01-01", targetDays: 365 })).status).toBe(201);
    expect((await trade({ type: "SELL", shares: "1", date: "2025-02-01", targetDays: 365 })).status).toBe(400);
    expect((await trade({ type: "BUY", shares: "1", date: "2025-02-01", lots: [{ buyId: 1, shares: "1" }] })).status).toBe(400);
    expect((await ids()).map((t) => t[4])).toEqual([365]);
  });

  it("venda escolhendo tranches: grava e devolve a escolha; escolhas impossíveis são recusadas e nada é gravado", async () => {
    const { trade, ids, agent } = await setup();
    await trade({ type: "BUY", shares: "1", date: "2025-01-01" });
    await trade({ type: "BUY", shares: "2", date: "2025-06-01" });
    await agent.post("/api/transactions").send({ ticker: "MSFT", type: "BUY", shares: "5", price: "10", date: "2025-01-01" });
    const [b1, b2] = (await ids()).map((t) => t[0]);
    const msftBuy = ((await agent.get("/api/transactions?ticker=MSFT")).body as any[])[0].id;

    for (const lots of [
      [{ buyId: b1, shares: "1.5" }], // more than it has
      [{ buyId: msftBuy, shares: "1.5" }], // another asset
      [{ buyId: b2, shares: "1" }], // does not add up to 1.5
      [{ buyId: b2, shares: "1" }, { buyId: b2, shares: "0.5" }], // same tranche twice
      [{ buyId: 9999, shares: "1.5" }], // does not exist
    ]) {
      expect((await trade({ type: "SELL", shares: "1.5", date: "2025-07-01", lots })).status).toBe(400);
    }
    expect(await ids()).toHaveLength(2);

    expect((await trade({ type: "SELL", shares: "1.5", date: "2025-07-01", lots: [{ buyId: b2, shares: "1.5" }] })).status).toBe(201);
    expect((await ids()).find((t) => t[1] === "SELL")![3]).toEqual([{ buyId: b2, shares: "1.5" }]);
  });

  it("venda automática com data anterior que comeria a tranche já escolhida é recusada", async () => {
    const { trade, ids } = await setup();
    await trade({ type: "BUY", shares: "1", date: "2025-01-01" });
    await trade({ type: "BUY", shares: "1", date: "2025-06-01" });
    const [b1] = (await ids()).map((t) => t[0]);
    expect((await trade({ type: "SELL", shares: "1", date: "2025-08-01", lots: [{ buyId: b1, shares: "1" }] })).status).toBe(201);
    const r = await trade({ type: "SELL", shares: "1", date: "2025-07-01" });
    expect(r.status).toBe(400);
  });

  it("não apaga a compra escolhida por uma venda; apagando a venda, a escolha vai junto e a compra pode sair", async () => {
    const { trade, ids, agent, db } = await setup();
    await trade({ type: "BUY", shares: "1", date: "2025-01-01" });
    await trade({ type: "BUY", shares: "1", date: "2025-02-01" });
    const [b1, b2] = (await ids()).map((t) => t[0]);
    await trade({ type: "SELL", shares: "1", date: "2025-03-01", lots: [{ buyId: b2, shares: "1" }] });
    const s1 = (await ids()).find((t) => t[1] === "SELL")![0];
    const del = await agent.delete(`/api/transactions/${b2}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toContain("2025-03-01");
    expect(del.body.error).toContain("Apague essa venda antes");
    expect((await agent.delete(`/api/transactions/${s1}`)).status).toBe(204);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sell_lots`).get()).toEqual({ n: 0 });
    expect((await agent.delete(`/api/transactions/${b2}`)).status).toBe(204);
    expect((await ids()).map((t) => t[0])).toEqual([b1]);
  });

  it("apagar uma compra que não foi escolhida, mas cuja falta faz a venda automática comer a tranche escolhida, é recusado", async () => {
    const { trade, ids, agent } = await setup();
    await trade({ type: "BUY", shares: "1", date: "2025-01-01" }); // B0
    await trade({ type: "BUY", shares: "1", date: "2025-02-01" }); // B1
    await trade({ type: "BUY", shares: "1", date: "2025-03-01" }); // B2
    const [b0, b1] = (await ids()).map((t) => t[0]);
    await trade({ type: "SELL", shares: "1", date: "2025-04-01" }); // oldest first: takes B0
    await trade({ type: "SELL", shares: "1", date: "2025-05-01", lots: [{ buyId: b1, shares: "1" }] });
    // without B0, the April sale would take B1, which May chose: the position stays >= 0, the tranches would not
    const r = await agent.delete(`/api/transactions/${b0}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("desmontaria as tranches");
    expect(await ids()).toHaveLength(5);
  });

    it("excluir o ativo ou a carteira inteira funciona mesmo com tranches escolhidas", async () => {
    const { trade, ids, agent, db } = await setup();
    await trade({ type: "BUY", shares: "1", date: "2025-01-01" });
    const [b1] = (await ids()).map((t) => t[0]);
    await trade({ type: "SELL", shares: "1", date: "2025-03-01", lots: [{ buyId: b1, shares: "1" }] });
    expect((await agent.delete("/api/stocks/AAPL")).status).toBe(204);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sell_lots`).get()).toEqual({ n: 0 });

    const other = (await agent.post("/api/portfolios").send({ name: "Outra", color: "#089981" })).body;
    const inOther = (u: string) => agent.post(u).set("X-Portfolio-Id", String(other.id));
    const tab = (await agent.get("/api/tabs").set("X-Portfolio-Id", String(other.id))).body[0].id;
    await inOther("/api/stocks").send({ ticker: "AAPL", name: "AAPL", tabId: tab });
    const buy = (await inOther("/api/transactions").send({ ticker: "AAPL", type: "BUY", shares: "1", price: "1", date: "2025-01-01" })).body.id;
    expect((await inOther("/api/transactions").send({ ticker: "AAPL", type: "SELL", shares: "1", price: "1", date: "2025-02-01", lots: [{ buyId: buy, shares: "1" }] })).status).toBe(201);
    expect((await agent.post(`/api/portfolios/${other.id}/delete`).send({ password: PASSWORD, confirmName: "Outra" })).status).toBe(200);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sell_lots`).get()).toEqual({ n: 0 });
  });

  it("prazo de uma tranche depois de gravada: só da compra, só da própria carteira", async () => {
    const { trade, ids, agent } = await setup();
    await trade({ type: "BUY", shares: "1", date: "2025-01-01" });
    await trade({ type: "SELL", shares: "1", date: "2025-02-01" });
    const [b1, s1] = (await ids()).map((t) => t[0]);
    expect((await agent.patch(`/api/transactions/${b1}/target`).send({ targetDays: 500 })).status).toBe(200);
    expect((await agent.patch(`/api/transactions/${s1}/target`).send({ targetDays: 500 })).status).toBe(404);
    const other = (await agent.post("/api/portfolios").send({ name: "Outra", color: "#089981" })).body;
    expect((await agent.patch(`/api/transactions/${b1}/target`).set("X-Portfolio-Id", String(other.id)).send({ targetDays: 9 })).status).toBe(404);
    expect((await ids())[0][4]).toBe(500);
    expect((await agent.patch(`/api/transactions/${b1}/target`).send({ targetDays: null })).status).toBe(200);
    expect((await ids())[0][4]).toBeNull();
  });

  it("backup leva e traz tranches escolhidas (ids novos) e prazos; escolha forjada para outro ativo é descartada", async () => {
    const { trade, ids, agent } = await setup();
    await agent.patch("/api/stocks/AAPL/classification").send({ targetDays: 900 });
    await trade({ type: "BUY", shares: "1", date: "2025-01-01", targetDays: 400 });
    await trade({ type: "BUY", shares: "1", date: "2025-02-01" });
    const [, b2] = (await ids()).map((t) => t[0]);
    await trade({ type: "SELL", shares: "1", date: "2025-03-01", lots: [{ buyId: b2, shares: "1" }] });
    await agent.post("/api/transactions").send({ ticker: "MSFT", type: "BUY", shares: "1", price: "1", date: "2025-01-01" });
    const backup = (await agent.get("/api/export")).body;

    expect((await agent.post("/api/import").send(backup)).status).toBe(200);
    const after = (await agent.get("/api/transactions?ticker=AAPL")).body as any[];
    const newB2 = after.find((t) => t.date === "2025-02-01").id;
    expect(after.find((t) => t.type === "SELL").lots).toEqual([{ buyId: newB2, shares: "1" }]);
    expect(after.find((t) => t.date === "2025-01-01").target_days).toBe(400);
    expect((await agent.get("/api/stocks")).body.find((s: any) => s.ticker === "AAPL")).toMatchObject({ horizon: "long", target_days: 900 });

    const forged = structuredClone(backup);
    const msftId = forged.transactions.find((t: any) => t.ticker === "MSFT").id;
    forged.transactions.find((t: any) => t.type === "SELL").lots = [{ buyId: msftId, shares: "1" }];
    const r = await agent.post("/api/import").send(forged);
    expect(r.status).toBe(200);
    expect(r.body.skipped).toBe(1);
    expect(((await agent.get("/api/transactions?ticker=AAPL")).body as any[]).find((t) => t.type === "SELL").lots).toBeNull(); // oldest first
  });

  it("o banco recusa sozinho uma escolha entre ativos diferentes (mesmo sem passar pela API)", async () => {
    const { trade, agent, db } = await setup();
    await trade({ type: "BUY", shares: "1", date: "2025-01-01" });
    await trade({ type: "SELL", shares: "1", date: "2025-02-01" });
    await agent.post("/api/transactions").send({ ticker: "MSFT", type: "BUY", shares: "1", price: "1", date: "2025-01-01" });
    const id = (ticker: string, type: string) => (db.prepare(`SELECT id FROM transactions WHERE ticker = ? AND type = ?`).get(ticker, type) as { id: number }).id;
    expect(() => db.prepare(`INSERT INTO sell_lots VALUES (?, ?, '1')`).run(id("AAPL", "SELL"), id("MSFT", "BUY"))).toThrow(/mesmo ativo/);
    expect(() => db.prepare(`INSERT INTO sell_lots VALUES (?, ?, '1')`).run(id("AAPL", "SELL"), id("AAPL", "SELL"))).toThrow(/mesmo ativo/);
  });
});

describe("migração v9", () => {
  it("ativos com faixa ganham o prazo-alvo inicial dela; operações sem prazo próprio; só acrescenta", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, 8);
    const T = "2026-01-01T00:00:00.000Z";
    db.prepare(`INSERT INTO users (email, display_name, password_hash, created_at, updated_at) VALUES ('a@test.local', 'A', 'h', ?, ?)`).run(T, T);
    db.prepare(`INSERT INTO portfolios (user_id, name, color, created_at, updated_at) VALUES (1, 'P', '#2962ff', ?, ?)`).run(T, T);
    const stock = db.prepare(`INSERT INTO stocks (user_id, portfolio_id, ticker, name, created_at, asset_type, horizon) VALUES (1, 1, ?, ?, ?, 'us_stock', ?)`);
    stock.run("AAPL", "Apple", T, "long");
    stock.run("MSFT", "Microsoft", T, null);
    stock.run("NVDA", "Nvidia", T, "ultra_long");
    const before = db.prepare(`SELECT * FROM stocks ORDER BY id`).all();
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(9);
    const after = db.prepare(`SELECT * FROM stocks ORDER BY id`).all() as any[];
    // tab_id aside: opening the database puts assets without a tab in a default tab
    const noTab = ({ tab_id: _t, ...rest }: any) => rest;
    after.forEach((row, i) => expect(noTab(row)).toMatchObject(noTab(before[i])));
    expect(after.map((s) => [s.ticker, s.target_days])).toEqual([["AAPL", 1800], ["MSFT", null], ["NVDA", 3650]]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  });
});

import { buildRows, maturityAllocation } from "../src/features/consolidated/rows";

describe("alocação por maturação (consolidado)", () => {
  it("cada tranche cai na faixa do tempo que falta; as fatias somam o patrimônio", () => {
    const stocks = [{ ticker: "X:BTCUSD", name: "Bitcoin", asset_type: "crypto" as const, horizon: "long" as const, target_days: 1800, currency: "USD" as const }];
    const tx = (id: number, date: string, shares: string, extra = {}) => ({ id, ticker: "X:BTCUSD", type: "BUY" as const, shares, price: "50000", date, sort_order: id, currency: "USD" as const, fx: null, ...extra });
    const transactions = [
      tx(1, "2021-01-01", "1"), // 1800 d -> 2025-12-06: matured
      tx(2, "2025-11-09", "2"), // -> 2030-10-14: 1426 d left -> Longo
      tx(3, "2026-06-01", "1", { target_days: 300 }), // -> 2027-03-28: 130 d -> Curto
    ];
    const prices = { "X:BTCUSD": { symbol: "X:BTCUSD", price: 90000, change: 0, changePercent: 0 } } as any;
    const rows = buildRows(stocks, transactions, prices, "USD", null);
    const by = maturityAllocation(rows, stocks, transactions, "2026-11-18");
    expect(Object.fromEntries(by)).toEqual({ matured: 90000, long: 180000, short: 90000 });
    expect([...by.values()].reduce((a, b) => a + b, 0)).toBe(rows[0].marketValue);
  });
});

describe("achados da revisão independente (v0.15.0)", () => {
  it("histórico já inconsistente (deixado por versão antiga) não trava operações sem relação; só o que cria problema novo é recusado", async () => {
    const { trade, ids, agent, db } = await setup();
    await trade({ type: "BUY", shares: "1", date: "2025-01-01" });
    await trade({ type: "BUY", shares: "1", date: "2025-06-01" });
    const [b1, b2] = (await ids()).map((t) => t[0]);
    await trade({ type: "SELL", shares: "1", date: "2025-08-01", lots: [{ buyId: b1, shares: "1" }] });
    // what v0.14 would write after a rollback: a back-dated oldest-first sale that eats the chosen tranche
    db.prepare(
      `INSERT INTO transactions (user_id, portfolio_id, ticker, type, shares, price, shares_dec, price_dec, date, created_at, sort_order)
       SELECT user_id, portfolio_id, ticker, 'SELL', 1, 10, '1', '10', '2025-07-01', created_at, 99 FROM transactions WHERE id = ?`
    ).run(b1);
    expect((await trade({ type: "BUY", shares: "1", date: "2026-01-01" })).status).toBe(201);
    const later = (await ids()).find((t) => t[2] === "2026-01-01")![0];
    expect((await agent.delete(`/api/transactions/${later}`)).status).toBe(204);
    // but a new choice that does not fit is still refused
    expect((await trade({ type: "SELL", shares: "1", date: "2026-02-01", lots: [{ buyId: b2, shares: "2" }] })).status).toBe(400);
  });

  it("escolha inválida é recusada antes de perguntar ao Banco Central", async () => {
    let calls = 0;
    const db = openDatabase(":memory:");
    const app = createApp(db, loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
      finnhubFetch: async () => ({ c: 100 }),
      dataFetch: async () => {
        calls++;
        return { value: [] };
      },
    });
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ email: "ana@example.com", password: PASSWORD, confirmPassword: PASSWORD });
    const tabId = (await agent.get("/api/tabs")).body[0].id;
    await agent.post("/api/stocks").send({ ticker: "AAPL", name: "AAPL", tabId });
    const buy = (await agent.post("/api/transactions").send({ ticker: "AAPL", type: "BUY", shares: "1", price: "1", date: "2025-01-01" })).body.id;
    calls = 0;
    const r = await agent.post("/api/transactions").send({ ticker: "AAPL", type: "SELL", shares: "1", price: "1", date: "2025-02-01", lots: [{ buyId: buy, shares: "0.5" }] });
    expect(r.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("compra de OUTRO usuário não serve de tranche; excluir a conta com escolhas funciona", async () => {
    const { trade, ids, agent, db } = await setup();
    await trade({ type: "BUY", shares: "1", date: "2025-01-01" });
    const [b1] = (await ids()).map((t) => t[0]);
    await trade({ type: "SELL", shares: "1", date: "2025-02-01", lots: [{ buyId: b1, shares: "1" }] });
    // a second user tries to sell from the first user's purchase
    const app2 = request.agent((agent as any).app);
    await app2.post("/api/auth/register").send({ email: "bia@example.com", password: PASSWORD, confirmPassword: PASSWORD });
    const tab2 = (await app2.get("/api/tabs")).body[0].id;
    await app2.post("/api/stocks").send({ ticker: "AAPL", name: "AAPL", tabId: tab2 });
    await app2.post("/api/transactions").send({ ticker: "AAPL", type: "BUY", shares: "1", price: "1", date: "2025-01-01" });
    expect((await app2.post("/api/transactions").send({ ticker: "AAPL", type: "SELL", shares: "1", price: "1", date: "2025-03-01", lots: [{ buyId: b1, shares: "1" }] })).status).toBe(400);
    // deleting the first account (with chosen tranches) works and leaves nothing behind
    expect((await agent.post("/api/auth/delete-account").send({ password: PASSWORD, confirmEmail: "ana@example.com" })).status).toBe(200);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sell_lots`).get()).toEqual({ n: 0 });
  });

  it("restore: venda com escolha mas sem id utilizável conta em skipped", async () => {
    const { trade, ids, agent } = await setup();
    await trade({ type: "BUY", shares: "1", date: "2025-01-01" });
    const [b1] = (await ids()).map((t) => t[0]);
    await trade({ type: "SELL", shares: "1", date: "2025-02-01", lots: [{ buyId: b1, shares: "1" }] });
    const backup = (await agent.get("/api/export")).body;
    delete backup.transactions.find((t: any) => t.type === "SELL").id;
    const r = await agent.post("/api/import").send(backup);
    expect(r.status).toBe(200);
    expect(r.body.skipped).toBe(1);
  });

  it("o banco não deixa mudar data, quantidade, ativo ou tipo de uma operação que faz parte de uma escolha", async () => {
    const { trade, ids, db } = await setup();
    await trade({ type: "BUY", shares: "1", date: "2025-01-01" });
    const [b1] = (await ids()).map((t) => t[0]);
    await trade({ type: "SELL", shares: "1", date: "2025-02-01", lots: [{ buyId: b1, shares: "1" }] });
    for (const set of [`date = '2025-12-01'`, `shares_dec = '5'`, `ticker = 'MSFT'`, `type = 'SELL'`]) {
      expect(() => db.prepare(`UPDATE transactions SET ${set} WHERE id = ?`).run(b1)).toThrow(/escolha de tranches/);
    }
    expect(() => db.prepare(`UPDATE transactions SET target_days = 10 WHERE id = ?`).run(b1)).not.toThrow(); // not part of the choice
  });

  it("alocação por maturação usa as mesmas operações da posição (sem conversão, fica fora das duas)", () => {
    const stocks = [{ ticker: "AAPL", name: "Apple", asset_type: "us_stock" as const, horizon: "long" as const, target_days: 1800, currency: "USD" as const }];
    const transactions = [
      { id: 1, ticker: "AAPL", type: "BUY" as const, shares: "10", price: "100", date: "2026-01-01", sort_order: 1, currency: "USD" as const, fx: null },
      { id: 2, ticker: "AAPL", type: "BUY" as const, shares: "5", price: "500", date: "2026-11-18", sort_order: 2, currency: "BRL" as const, fx: null }, // no PTAX, no live rate
    ];
    const prices = { AAPL: { symbol: "AAPL", price: 200, change: 0, changePercent: 0 } } as any;
    const rows = buildRows(stocks, transactions, prices, "USD", null);
    const total = [...maturityAllocation(rows, stocks, transactions, "2026-11-18", null).values()].reduce((a, b) => a + b, 0);
    expect(rows[0].marketValue).toBe(2000);
    expect(total).toBe(2000);
  });
});

import { evaluatePicks } from "../src/features/actions/tranchePicks";

describe("venda escolhendo tranches: quantidade = soma das escolhas", () => {
  const open = replayTranches([buy(1, "2025-11-09", "0.00295"), buy(2, "2026-10-29", "0.00001"), buy(3, "2026-11-15", "3")], 1800).open;

  it("soma exata, com decimais (0,0009 + 0,00001 + 1 = 1,00091); vazio não conta", () => {
    expect(evaluatePicks(open, { 1: "0.0009", 2: "0.00001", 3: "1" }).total).toBe("1.00091");
    expect(evaluatePicks(open, { 1: "0.1", 3: "0.2" }).total).toBe("0.3");
    expect(evaluatePicks(open, {}).total).toBe("");
  });

  it("acima do saldo da tranche ou texto inválido fica marcado (e não entra na soma se inválido)", () => {
    const r = evaluatePicks(open, { 1: "0.01", 2: "abc", 3: "1" });
    expect(r.picks.map((p) => [p.over, p.invalid])).toEqual([[true, false], [false, true], [false, false]]);
    expect(r.total).toBe("1.01");
  });

  it("tranche que não está aberta na data não entra, mesmo se digitada antes", () => {
    expect(evaluatePicks(open, { 99: "5", 3: "1" }).total).toBe("1");
  });
});

import { suggestPrice } from "../src/features/actions/priceSuggestion";

describe("preço em branco: sugestão pela cotação atual", () => {
  it("na moeda do ativo: a cotação, com até 8 casas", () => {
    expect(suggestPrice({ quote: 63495.88, assetCurrency: "USD", tradeCurrency: "USD" })).toEqual({ value: "63495.88", converted: false });
    expect(suggestPrice({ quote: 0.123456789, assetCurrency: "USD", tradeCurrency: "USD" })).toEqual({ value: "0.12345679", converted: false });
  });

  it("pago em outra moeda: convertida pelo câmbio de hoje (reais por unidade)", () => {
    const live = { USD: "5.8", EUR: "6.4", CHF: "6.9" };
    expect(suggestPrice({ quote: 100, assetCurrency: "USD", tradeCurrency: "BRL", live })).toEqual({ value: "580", converted: true });
    expect(suggestPrice({ quote: 64, assetCurrency: "USD", tradeCurrency: "EUR", live })).toEqual({ value: "58", converted: true });
  });

  it("sem cotação, ou sem câmbio para converter: não sugere", () => {
    expect(suggestPrice({ quote: 0, assetCurrency: "USD", tradeCurrency: "USD" })).toBeNull();
    expect(suggestPrice({ quote: undefined, assetCurrency: "USD", tradeCurrency: "USD" })).toBeNull();
    expect(suggestPrice({ quote: 100, assetCurrency: "USD", tradeCurrency: "BRL", live: null })).toBeNull();
  });
});
