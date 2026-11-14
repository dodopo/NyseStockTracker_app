import { describe, expect, it } from "vitest";
import request from "supertest";
import { createCandleService, nyDate, type MassiveFetch } from "../server/candles";
import { loadConfig } from "../server/config";
import { migrate, openDatabase, SCHEMA_VERSION } from "../server/db";
import { createApp, type FinnhubFetch } from "../server/app";

const GOOD_MASSIVE = "massivegood12345678";
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0); // 2026-11-14 12:00 UTC

function bar(isoTime: string, close: number) {
  const t = Date.parse(isoTime);
  return { t, o: close - 1, h: close + 1, l: close - 2, c: close, v: 1000 };
}

/** Fake Massive: records calls; only GOOD_MASSIVE is accepted. */
function fakeMassive(results = [bar("2026-11-12T15:00:00Z", 100), bar("2026-11-13T15:00:00Z", 101)]) {
  const calls: string[] = [];
  const fetch: MassiveFetch = async (path, key) => {
    calls.push(path);
    if (key !== GOOD_MASSIVE) {
      const e = new Error("Massive HTTP 401") as Error & { status: number };
      e.status = 401;
      throw e;
    }
    return { status: "DELAYED", results };
  };
  return { fetch, calls };
}

describe("serviço de velas (server/candles)", () => {
  it("monta a consulta certa, converte as velas e usa cache", async () => {
    const m = fakeMassive();
    const svc = createCandleService({ fetch: m.fetch, now: () => NOW });

    const a = await svc.getCandles({ symbol: "AAPL", range: "1A", apiKey: GOOD_MASSIVE });
    expect(a.interval).toBe("1D");
    expect(a.candles).toHaveLength(2);
    expect(a.candles[1]).toEqual({ t: Date.parse("2026-11-13T15:00:00Z"), o: 100, h: 102, l: 99, c: 101, v: 1000 });
    expect(m.calls[0]).toBe("/v2/aggs/ticker/AAPL/range/1/day/2025-11-13/2026-11-14?adjusted=true&sort=asc&limit=50000");

    const b = await svc.getCandles({ symbol: "AAPL", range: "1A", apiKey: GOOD_MASSIVE });
    expect(b.cached).toBe(true);
    expect(m.calls).toHaveLength(1);
  });

  it("período MAX nunca pede mais de 2 anos (limite do plano grátis)", async () => {
    const m = fakeMassive();
    const svc = createCandleService({ fetch: m.fetch, now: () => NOW });
    await svc.getCandles({ symbol: "AAPL", range: "MAX", apiKey: GOOD_MASSIVE });
    expect(m.calls[0]).toContain("/range/1/week/2024-11-14/2026-11-14");
  });

  it("1D mostra só o último pregão", async () => {
    const m = fakeMassive([
      bar("2026-11-12T15:00:00Z", 100),
      bar("2026-11-13T14:35:00Z", 101),
      bar("2026-11-13T20:55:00Z", 102),
    ]);
    const svc = createCandleService({ fetch: m.fetch, now: () => NOW });
    const r = await svc.getCandles({ symbol: "AAPL", range: "1D", apiKey: GOOD_MASSIVE });
    expect(r.interval).toBe("5m");
    expect(r.candles.map((c) => nyDate(c.t))).toEqual(["2026-11-13", "2026-11-13"]);
  });

  it("recusa período inválido e vela incompatível com o período", async () => {
    const svc = createCandleService({ fetch: fakeMassive().fetch, now: () => NOW });
    await expect(svc.getCandles({ symbol: "AAPL", range: "10A", apiKey: GOOD_MASSIVE })).rejects.toMatchObject({ status: 400 });
    await expect(
      svc.getCandles({ symbol: "AAPL", range: "MAX", interval: "5m", apiKey: GOOD_MASSIVE })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("respeita 5 consultas por minuto por chave e devolve dado antigo do cache se houver", async () => {
    let t = NOW;
    const m = fakeMassive();
    const svc = createCandleService({ fetch: m.fetch, now: () => t });
    const symbols = ["A", "B", "C", "D", "E"];
    for (const s of symbols) await svc.getCandles({ symbol: s, range: "1A", apiKey: GOOD_MASSIVE });
    expect(m.calls).toHaveLength(5);

    await expect(svc.getCandles({ symbol: "F", range: "1A", apiKey: GOOD_MASSIVE })).rejects.toMatchObject({ status: 429 });
    expect(m.calls).toHaveLength(5); // the 6th call never reached the provider

    // 7 h later: every cached entry expired (daily TTL 6 h) and the minute window reset.
    t += 7 * 60 * 60_000;
    for (const s of ["B", "C", "D", "E", "F"]) await svc.getCandles({ symbol: s, range: "1A", apiKey: GOOD_MASSIVE });
    expect(m.calls).toHaveLength(10); // window full again

    // "A" is expired but still in cache: served stale, no provider call.
    const stale = await svc.getCandles({ symbol: "A", range: "1A", apiKey: GOOD_MASSIVE });
    expect(stale).toMatchObject({ cached: true, stale: true });
    expect(stale.candles).toHaveLength(2);
    expect(m.calls).toHaveLength(10);

    // A combination never fetched has nothing to fall back on: must wait.
    await expect(svc.getCandles({ symbol: "A", range: "3M", apiKey: GOOD_MASSIVE })).rejects.toMatchObject({ status: 429 });
  });

  it("chave recusada vira mensagem clara, sem detalhes internos", async () => {
    const svc = createCandleService({ fetch: fakeMassive().fetch, now: () => NOW });
    await expect(svc.getCandles({ symbol: "AAPL", range: "1A", apiKey: "wrongkey1234567" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/recusou a chave/),
    });
  });
});

describe("rotas de gráfico", () => {
  const finnhub: FinnhubFetch = async (url) => {
    if (url.includes("/stock/metric")) {
      return { metric: { "52WeekHigh": 359.37, "52WeekLow": 243.42, "10DayAverageTradingVolume": 45.1, marketCapitalization: 5_300_000 } };
    }
    return { c: 100 };
  };

  async function setup() {
    const db = openDatabase(":memory:");
    const m = fakeMassive();
    const app = createApp(db, loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
      finnhubFetch: finnhub,
      massiveFetch: m.fetch,
    });
    const reg = await request(app)
      .post("/api/auth/register")
      .send({ email: "ana@example.com", password: "correct-horse-battery", confirmPassword: "correct-horse-battery" });
    const cookie = String(reg.headers["set-cookie"]).split(";")[0];
    await request(app).post("/api/auth/finnhub-key").set("Cookie", cookie).send({ apiKey: "finnhubkey123456" });
    return { app, db, cookie, m };
  }

  it("sem chave da Massive: avisa como configurar", async () => {
    const { app, cookie } = await setup();
    const res = await request(app).get("/api/candles?symbol=AAPL&range=1A").set("Cookie", cookie);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MASSIVE_KEY_MISSING");
  });

  it("chave da Massive é testada antes de salvar e nunca aparece inteira", async () => {
    const { app, cookie } = await setup();
    const bad = await request(app).post("/api/auth/massive-key").set("Cookie", cookie).send({ apiKey: "wrongkey1234567" });
    expect(bad.status).toBe(400);

    const ok = await request(app).post("/api/auth/massive-key").set("Cookie", cookie).send({ apiKey: GOOD_MASSIVE });
    expect(ok.status).toBe(200);
    expect(ok.body.user.hasMassiveKey).toBe(true);

    const account = await request(app).get("/api/account").set("Cookie", cookie);
    expect(account.body.massiveKeyHint).toBe("••••5678");
    expect(JSON.stringify(account.body)).not.toContain(GOOD_MASSIVE);

    const backup = await request(app).get("/api/export").set("Cookie", cookie);
    expect(JSON.stringify(backup.body)).not.toContain(GOOD_MASSIVE);
  });

  it("devolve velas com a chave configurada e recusa símbolo inválido", async () => {
    const { app, cookie } = await setup();
    await request(app).post("/api/auth/massive-key").set("Cookie", cookie).send({ apiKey: GOOD_MASSIVE });

    const res = await request(app).get("/api/candles?symbol=aapl&range=1A").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: "AAPL", range: "1A", interval: "1D", source: "massive" });
    expect(res.body.candles).toHaveLength(2);

    expect((await request(app).get("/api/candles?symbol=<x>&range=1A").set("Cookie", cookie)).status).toBe(400);
    expect((await request(app).get("/api/candles?symbol=AAPL&range=99").set("Cookie", cookie)).status).toBe(400);
  });

  it("estatísticas de 52 semanas vêm da Finnhub, só os campos usados", async () => {
    const { app, cookie } = await setup();
    const res = await request(app).get("/api/stats?symbol=AAPL").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: "AAPL", high52w: 359.37, low52w: 243.42, avgVolume10d: 45.1 });
  });

  it("sem sessão, as rotas de gráfico não respondem", async () => {
    const { app } = await setup();
    expect((await request(app).get("/api/candles?symbol=AAPL&range=1A")).status).toBe(401);
    expect((await request(app).get("/api/stats?symbol=AAPL")).status).toBe(401);
    expect((await request(app).post("/api/auth/massive-key").send({ apiKey: GOOD_MASSIVE })).status).toBe(401);
  });

  it("migração v4 é aditiva: só acrescenta a coluna da chave", () => {
    const db = openDatabase(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const cols = (db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("massive_key");
    expect(cols).toContain("finnhub_key");
    expect(() => migrate(db)).not.toThrow();
  });
});
