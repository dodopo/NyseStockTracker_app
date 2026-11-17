/**
 * Portfolios (v0.13.0): one login, many portfolios. Every portfolio route and
 * every scoped route must only ever reach the logged-in user's portfolios.
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { loadConfig } from "../server/config";
import { openDatabase } from "../server/db";
import { createApp } from "../server/app";

const PASSWORD = "correct-horse-battery";

function setup() {
  const db = openDatabase(":memory:");
  const app = createApp(db, loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
    finnhubFetch: async () => ({ c: 100, d: 1, dp: 1, h: 101, l: 99, o: 99, pc: 99 }),
  });
  return { db, app };
}

async function login(app: ReturnType<typeof createApp>, email = "ana@example.com") {
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/register").send({ email, password: PASSWORD, confirmPassword: PASSWORD })).status).toBe(201);
  return agent;
}

type P = { id: number; name: string; archived: boolean; assetCount: number };
const list = async (agent: request.Agent) => (await agent.get("/api/portfolios")).body as P[];
const create = async (agent: request.Agent, name: string, color = "#089981") =>
  (await agent.post("/api/portfolios").send({ name, color })).body as P;
/** Requests scoped to one portfolio (X-Portfolio-Id). */
const inP = (agent: request.Agent, id: number | string) => ({
  get: (url: string) => agent.get(url).set("X-Portfolio-Id", String(id)),
  post: (url: string, body: object) => agent.post(url).set("X-Portfolio-Id", String(id)).send(body),
  patch: (url: string, body: object) => agent.patch(url).set("X-Portfolio-Id", String(id)).send(body),
  del: (url: string) => agent.delete(url).set("X-Portfolio-Id", String(id)),
});

async function addAsset(agent: request.Agent, portfolioId: number, ticker: string, shares = "1") {
  const p = inP(agent, portfolioId);
  const tabId = (await p.get("/api/tabs")).body[0].id;
  expect((await p.post("/api/stocks", { ticker, name: ticker, tabId })).status).toBe(201);
  expect((await p.post("/api/transactions", { ticker, type: "BUY", shares, price: "10", date: "2026-01-02" })).status).toBe(201);
}

describe("carteiras", () => {
  it("cadastro cria a 'Carteira principal' com a aba 'Ações'", async () => {
    const { app } = setup();
    const agent = await login(app);
    const [main] = await list(agent);
    expect(main).toMatchObject({ name: "Carteira principal", archived: false, assetCount: 0 });
    expect((await inP(agent, main.id).get("/api/tabs")).body).toMatchObject([{ name: "Ações", assetType: "us_stock" }]);
  });

  it("cada carteira tem seus ativos; o mesmo ticker pode estar nas duas; sem cabeçalho = a primeira", async () => {
    const { app } = setup();
    const agent = await login(app);
    const [main] = await list(agent);
    const holding = await create(agent, "Holding");
    expect((await inP(agent, holding.id).get("/api/tabs")).body).toHaveLength(1); // nasce com 'Ações'

    await addAsset(agent, main.id, "AAPL", "2");
    await addAsset(agent, holding.id, "AAPL", "5");
    await addAsset(agent, holding.id, "NVDA");

    expect((await inP(agent, main.id).get("/api/stocks")).body.map((s: { ticker: string }) => s.ticker)).toEqual(["AAPL"]);
    expect((await inP(agent, holding.id).get("/api/stocks")).body.map((s: { ticker: string }) => s.ticker)).toEqual(["AAPL", "NVDA"]);
    expect((await inP(agent, holding.id).get("/api/transactions?ticker=AAPL")).body.map((t: { shares: string }) => t.shares)).toEqual(["5"]);
    expect((await agent.get("/api/stocks")).body.map((s: { ticker: string }) => s.ticker)).toEqual(["AAPL"]);

    // selling in one portfolio only sees that portfolio's position
    const sell = await inP(agent, main.id).post("/api/transactions", { ticker: "AAPL", type: "SELL", shares: "3", price: "1", date: "2026-02-01" });
    expect(sell.status).toBe(400);

    // deleting the asset in one portfolio keeps the other
    expect((await inP(agent, main.id).del("/api/stocks/AAPL")).status).toBe(204);
    expect((await inP(agent, holding.id).get("/api/transactions?ticker=AAPL")).body).toHaveLength(1);
    expect((await list(agent)).map((p) => `${p.name}:${p.assetCount}`)).toEqual(["Carteira principal:0", "Holding:2"]);
  });

  it("não alcança carteira de outro usuário (anti-IDOR): sempre 404, nada muda", async () => {
    const { app } = setup();
    const ana = await login(app, "ana@example.com");
    const bob = await login(app, "bob@example.com");
    const [anaMain] = await list(ana);
    await addAsset(ana, anaMain.id, "AAPL");
    const anaTx = (await inP(ana, anaMain.id).get("/api/transactions")).body[0].id;
    const anaTab = (await inP(ana, anaMain.id).get("/api/tabs")).body[0].id;

    const asBob = inP(bob, anaMain.id);
    for (const res of [
      await asBob.get("/api/stocks"),
      await asBob.get("/api/tabs"),
      await asBob.get("/api/transactions"),
      await asBob.post("/api/stocks", { ticker: "MSFT", name: "MSFT", tabId: anaTab }),
      await asBob.post("/api/tabs", { name: "x", assetType: "us_stock", color: "#2962ff" }),
      await asBob.del(`/api/transactions/${anaTx}`),
      await asBob.del("/api/stocks/AAPL"),
      await bob.patch(`/api/portfolios/${anaMain.id}`).send({ name: "Hackeada" }),
      await bob.post(`/api/portfolios/${anaMain.id}/delete`).send({ password: PASSWORD, confirmName: "Carteira principal" }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("PORTFOLIO_NOT_FOUND");
    }
    for (const bad of ["0", "-1", "1.5", "abc", "1;DROP", "99999999999999"]) {
      expect((await inP(bob, bad).get("/api/stocks")).status).toBe(404);
    }

    expect((await list(ana))[0].name).toBe("Carteira principal");
    expect((await inP(ana, anaMain.id).get("/api/transactions")).body).toHaveLength(1);
    expect((await bob.get("/api/global")).body.stocks).toEqual([]);
  });

  it("aba de outra carteira do mesmo usuário não serve para adicionar ativo", async () => {
    const { app } = setup();
    const agent = await login(app);
    const [main] = await list(agent);
    const holding = await create(agent, "Holding");
    const mainTab = (await inP(agent, main.id).get("/api/tabs")).body[0].id;
    const res = await inP(agent, holding.id).post("/api/stocks", { ticker: "AAPL", name: "Apple", tabId: mainTab });
    expect(res.status).toBe(404);
  });

  it("criar, renomear, trocar a cor, reordenar; nome repetido é recusado", async () => {
    const { app } = setup();
    const agent = await login(app);
    const a = await create(agent, "Offshore");
    expect((await agent.post("/api/portfolios").send({ name: "offshore", color: "#2962ff" })).status).toBe(400);
    expect((await agent.post("/api/portfolios").send({ name: "", color: "#2962ff" })).status).toBe(400);
    expect((await agent.post("/api/portfolios").send({ name: "X", color: "red" })).status).toBe(400);
    expect((await agent.patch(`/api/portfolios/${a.id}`).send({ name: "Carteira principal" })).status).toBe(400);

    const renamed = await agent.patch(`/api/portfolios/${a.id}`).send({ name: "Offshore EUA", color: "#f7931a" });
    expect(renamed.body).toMatchObject({ name: "Offshore EUA", color: "#f7931a" });

    const ids = (await list(agent)).map((p) => p.id);
    const reordered = await agent.post("/api/portfolios/reorder").send({ ids: [...ids].reverse() });
    expect(reordered.body.map((p: P) => p.name)).toEqual(["Offshore EUA", "Carteira principal"]);
    expect((await agent.post("/api/portfolios/reorder").send({ ids: [ids[0]] })).status).toBe(400);
  });

  it("arquivar: some da Visão Global, nada é apagado; a única ativa não pode ser arquivada", async () => {
    const { app } = setup();
    const agent = await login(app);
    const [main] = await list(agent);
    expect((await agent.patch(`/api/portfolios/${main.id}`).send({ archived: true })).status).toBe(400);

    const old = await create(agent, "Antiga");
    await addAsset(agent, old.id, "AAPL");
    await addAsset(agent, main.id, "NVDA");
    expect((await agent.patch(`/api/portfolios/${old.id}`).send({ archived: true })).body.archived).toBe(true);

    const global = (await agent.get("/api/global")).body;
    expect(global.portfolios.map((p: P) => p.name)).toEqual(["Carteira principal"]);
    expect(global.stocks.map((s: { ticker: string }) => s.ticker)).toEqual(["NVDA"]);
    expect((await inP(agent, old.id).get("/api/stocks")).body).toHaveLength(1); // still there

    expect((await agent.patch(`/api/portfolios/${main.id}`).send({ archived: true })).status).toBe(400); // last active
    await agent.patch(`/api/portfolios/${old.id}`).send({ archived: false });
    expect((await agent.get("/api/global")).body.stocks).toHaveLength(2);
  });

  it("excluir pede senha e o nome; apaga só aquela carteira; nunca a única", async () => {
    const { app, db } = setup();
    const agent = await login(app);
    const [main] = await list(agent);
    const temp = await create(agent, "Teste");
    await addAsset(agent, temp.id, "AAPL");
    await addAsset(agent, main.id, "AAPL");

    const del = (id: number, body: object) => agent.post(`/api/portfolios/${id}/delete`).send(body);
    expect((await del(temp.id, { password: "wrong-password", confirmName: "Teste" })).status).toBe(401);
    expect((await del(temp.id, { password: PASSWORD, confirmName: "Outro" })).status).toBe(400);
    expect((await del(temp.id, { password: PASSWORD, confirmName: "teste" })).status).toBe(200);

    expect((await list(agent)).map((p) => p.name)).toEqual(["Carteira principal"]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM tabs`).get()).toEqual({ n: 1 });
    expect((await del(main.id, { password: PASSWORD, confirmName: "Carteira principal" })).status).toBe(400);
  });

  it("Visão Global traz todas as carteiras ativas, cada linha com a sua carteira", async () => {
    const { app } = setup();
    const agent = await login(app);
    const [main] = await list(agent);
    const holding = await create(agent, "Holding");
    await addAsset(agent, main.id, "AAPL", "2");
    await addAsset(agent, holding.id, "AAPL", "5");

    const g = (await agent.get("/api/global")).body;
    expect(g.portfolios.map((p: P) => p.id)).toEqual([main.id, holding.id]);
    expect(g.stocks.map((s: { portfolio_id: number; ticker: string }) => `${s.portfolio_id}:${s.ticker}`).sort()).toEqual(
      [`${main.id}:AAPL`, `${holding.id}:AAPL`].sort()
    );
    expect(g.transactions.map((t: { portfolio_id: number; shares: string }) => `${t.portfolio_id}:${t.shares}`).sort()).toEqual(
      [`${main.id}:2`, `${holding.id}:5`].sort()
    );
    expect(g.tabs.every((t: { portfolioId: number }) => [main.id, holding.id].includes(t.portfolioId))).toBe(true);
  });
});

describe("backup com carteiras (formato 2)", () => {
  it("exporta e restaura todas as carteiras, inclusive arquivadas", async () => {
    const { app } = setup();
    const agent = await login(app);
    const [main] = await list(agent);
    const holding = await create(agent, "Holding", "#f7931a");
    const old = await create(agent, "Antiga");
    await addAsset(agent, main.id, "AAPL", "2");
    await addAsset(agent, holding.id, "AAPL", "5");
    await addAsset(agent, old.id, "NVDA");
    await agent.patch(`/api/portfolios/${old.id}`).send({ archived: true });

    const backup = (await agent.get("/api/export")).body;
    expect(backup.version).toBe(2);
    expect(backup.portfolios.map((p: { name: string }) => p.name)).toEqual(["Carteira principal", "Holding", "Antiga"]);

    const restored = await agent.post("/api/import").send(backup);
    expect(restored.status).toBe(200);
    const after = await list(agent);
    expect(after.map((p) => `${p.name}:${p.archived}:${p.assetCount}`)).toEqual([
      "Carteira principal:false:1",
      "Holding:false:1",
      "Antiga:true:1",
    ]);
    const h = after.find((p) => p.name === "Holding")!;
    expect((await inP(agent, h.id).get("/api/transactions")).body.map((t: { shares: string }) => t.shares)).toEqual(["5"]);
    expect((await agent.get("/api/export")).body.transactions).toHaveLength(3);
  });

  it("backup antigo (sem carteiras) vira uma 'Carteira principal'; backup v2 que não fecha é recusado sem mexer em nada", async () => {
    const { app } = setup();
    const agent = await login(app);
    await create(agent, "Será substituída");

    const v1 = {
      user: { email: "ana@example.com" },
      stocks: [{ ticker: "AAPL", name: "Apple" }],
      transactions: [{ ticker: "AAPL", type: "BUY", shares: "1", price: "100", date: "2026-01-02" }],
    };
    expect((await agent.post("/api/import").send(v1)).status).toBe(200);
    expect((await list(agent)).map((p) => `${p.name}:${p.assetCount}`)).toEqual(["Carteira principal:1"]);

    const v2 = {
      version: 2,
      user: { email: "ana@example.com" },
      portfolios: [{ id: 7, name: "Única", color: "#2962ff" }],
      stocks: [
        { ticker: "AAPL", name: "Apple", portfolio_id: 7 },
        { ticker: "MSFT", name: "Microsoft", portfolio_id: 999 },
      ],
      transactions: [{ ticker: "MSFT", type: "BUY", shares: "1", price: "1", date: "2026-01-02", portfolio_id: 999 }],
    };
    const r = await agent.post("/api/import").send(v2);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/carteira que não está no arquivo/);
    expect((await list(agent)).map((p) => `${p.name}:${p.assetCount}`)).toEqual(["Carteira principal:1"]); // untouched

    const dupIds = { ...v2, portfolios: [{ id: 1, name: "X", color: "#2962ff" }, { id: 1, name: "Y", color: "#2962ff" }], stocks: [], transactions: [] };
    expect((await agent.post("/api/import").send(dupIds)).status).toBe(400);
    const badColor = { ...v2, portfolios: [{ id: 1, name: "X", color: "red" }], stocks: [], transactions: [] };
    expect((await agent.post("/api/import").send(badColor)).status).toBe(400);
    expect((await list(agent)).map((p) => p.name)).toEqual(["Carteira principal"]);

    const ok = { ...v2, stocks: [{ ticker: "AAPL", name: "Apple", portfolio_id: 7 }], transactions: [] };
    const r2 = await agent.post("/api/import").send(ok);
    expect(r2.status).toBe(200);
    expect((await list(agent)).map((p) => `${p.name}:${p.assetCount}`)).toEqual(["Única:1"]);
  });

  it("nomes iguais ignorando maiúsculas e acentos maiúsculos (Ações × AÇÕES) são recusados; backup antigo com os dois restaura os dois", async () => {
    const { app } = setup();
    const agent = await login(app);
    await create(agent, "Ações");
    expect((await agent.post("/api/portfolios").send({ name: "AÇÕES", color: "#2962ff" })).status).toBe(400);
    expect((await agent.post("/api/portfolios").send({ name: "ações", color: "#2962ff" })).status).toBe(400);

    const backup = {
      user: { email: "ana@example.com" },
      portfolios: [
        { id: 1, name: "Ações", color: "#2962ff" },
        { id: 2, name: "AÇÕES", color: "#089981" },
      ],
      stocks: [
        { ticker: "AAPL", name: "Apple", portfolio_id: 1 },
        { ticker: "NVDA", name: "Nvidia", portfolio_id: 2 },
      ],
      transactions: [],
    };
    const r = await agent.post("/api/import").send(backup);
    expect(r.status).toBe(200);
    expect((await list(agent)).map((p) => `${p.name}:${p.assetCount}`)).toEqual(["Ações:1", "AÇÕES (2):1"]);
  });

  it("restaurar com todas as carteiras arquivadas deixa a primeira ativa", async () => {
    const { app } = setup();
    const agent = await login(app);
    const backup = {
      user: { email: "ana@example.com" },
      portfolios: [
        { id: 1, name: "A", color: "#2962ff", archived_at: "2026-01-01" },
        { id: 2, name: "B", color: "#2962ff", archived_at: "2026-01-01" },
      ],
      stocks: [],
      transactions: [],
    };
    expect((await agent.post("/api/import").send(backup)).status).toBe(200);
    expect((await list(agent)).map((p) => `${p.name}:${p.archived}`)).toEqual(["A:false", "B:true"]);
  });
});
