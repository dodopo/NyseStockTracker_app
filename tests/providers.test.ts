import { describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { loadConfig } from "../server/config";
import { migrate, openDatabase, SCHEMA_VERSION } from "../server/db";
import { createApp } from "../server/app";
import { createCandleService } from "../server/candles";
import { aggregateCandles } from "../server/providers/aggregate";
import { ProviderError, type DataFetch } from "../server/providers/types";
import { alignToCandles, movingAverage } from "../shared/indicators";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 13, 20, 0); // Fri 13 Nov 2026, 15:00 New York
const KEY_ID = "PKTESTKEY0000000000000000A";
const SECRET = "testsecret0000000000000000000000000000000AB";
const PASSWORD = "correct-horse-battery";

/** Fake Coinbase: daily BTC-USD since 20 Jul 2015, 15-min candles for the last days; newest first, max 300. */
function fakeCoinbase(listed = Date.UTC(2015, 6, 20)) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (!u.pathname.startsWith("/products/BTC-USD/")) throw new ProviderError(404, "NotFound");
    const g = Number(u.searchParams.get("granularity")) * 1000;
    const start = Date.parse(u.searchParams.get("start")!);
    const end = Date.parse(u.searchParams.get("end")!);
    expect((end - start) / g).toBeLessThanOrEqual(300);
    const out: number[][] = [];
    for (let t = end - (end % g); t >= start; t -= g) {
      if (t < listed) break;
      const p = 100 + (t - listed) / DAY; // +1 per day: easy averages
      out.push([t / 1000, p - 1, p + 1, p, p, 10]); // [time, low, high, open, close, volume]
    }
    return out;
  };
  return { fetch, calls };
}

/** Fake Alpaca: daily AAPL bars since 4 Jan 2016, pages of 1000, checks headers and the free-plan rules. */
function fakeAlpaca() {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fetch: DataFetch = async (url, headers = {}) => {
    const u = new URL(url);
    calls.push({ url: u, headers });
    if (headers["APCA-API-KEY-ID"] !== KEY_ID || headers["APCA-API-SECRET-KEY"] !== SECRET) throw new ProviderError(401, "unauthorized");
    const symbol = u.searchParams.get("symbols")!;
    const start = Math.max(Date.parse(u.searchParams.get("start")!), Date.UTC(2016, 0, 4, 5));
    const end = Date.parse(u.searchParams.get("end")!);
    const all = [];
    for (let t = Date.UTC(2016, 0, 4, 5); t <= end; t += DAY) if (t >= start) all.push({ t: new Date(t).toISOString(), o: 1, h: 2, l: 0.5, c: 1.5, v: 100 });
    const offset = Number(u.searchParams.get("page_token") ?? 0);
    const page = all.slice(offset, offset + 1000);
    return { bars: { [symbol]: page }, next_page_token: offset + 1000 < all.length ? String(offset + 1000) : null };
  };
  return { fetch, calls };
}

describe("provedores de velas", () => {
  it("Coinbase: 'Máx' diário volta até a listagem, em páginas de 300, sem buracos nem repetições", async () => {
    const cb = fakeCoinbase();
    const svc = createCandleService({ fetch: async () => ({}), dataFetch: cb.fetch, now: () => NOW });
    const r = await svc.getCandles({ symbol: "X:BTCUSD", range: "MAX", interval: "1D" });
    expect(r.source).toBe("coinbase");
    expect(new Date(r.candles[0].t).toISOString().slice(0, 10)).toBe("2015-07-20");
    const days = Math.floor((NOW - Date.UTC(2015, 6, 20)) / DAY) + 1;
    expect(r.candles).toHaveLength(days);
    expect(r.candles.every((c, i) => i === 0 || c.t - r.candles[i - 1].t === DAY)).toBe(true);
    expect(cb.calls.length).toBe(Math.ceil(days / 300) + 1); // the last page comes back empty
  });

  it("Coinbase: 30 min, semana e mês são montados a partir das velas menores", async () => {
    const cb = fakeCoinbase();
    const svc = createCandleService({ fetch: async () => ({}), dataFetch: cb.fetch, now: () => NOW });
    const m30 = await svc.getCandles({ symbol: "X:BTCUSD", range: "1S", interval: "30m" });
    expect(m30.candles.every((c) => c.t % (30 * 60_000) === 0)).toBe(true);
    expect(cb.calls.every((u) => u.includes("granularity=900"))).toBe(true);

    const weeks = aggregateCandles(
      [Date.UTC(2026, 10, 8), Date.UTC(2026, 10, 9), Date.UTC(2026, 10, 10)].map((t, i) => ({ t, o: i, h: 10 + i, l: i, c: i + 1, v: 1 })),
      "1W"
    );
    // Sunday 8 Nov belongs to the week of Monday 2 Nov; 9 and 10 Nov to the week of Monday 9 Nov
    expect(weeks.map((w) => new Date(w.t).toISOString().slice(0, 10))).toEqual(["2026-11-02", "2026-11-09"]);
    expect(weeks[1]).toMatchObject({ o: 1, h: 12, l: 1, c: 3, v: 2 });
  });

  it("cripto fora da Coinbase cai na Binance; sem nenhum provedor, na Massive", async () => {
    const binanceCalls: string[] = [];
    const dataFetch: DataFetch = async (url) => {
      if (url.includes("coinbase")) throw new ProviderError(404, "NotFound");
      binanceCalls.push(url);
      return [[NOW - DAY, "1", "2", "0.5", "1.5", "10"], [NOW, "1.5", "3", "1", "2.5", "20"]];
    };
    const svc = createCandleService({ fetch: async () => ({}), dataFetch, now: () => NOW });
    const r = await svc.getCandles({ symbol: "X:PEPEUSD", range: "1A", interval: "1D" });
    expect(r.source).toBe("binance");
    expect(binanceCalls[0]).toContain("symbol=PEPEUSDT");
    expect(r.candles.at(-1)).toMatchObject({ o: 1.5, h: 3, l: 1, c: 2.5, v: 20 });
  });

  it("Alpaca: chaves no cabeçalho, todas as bolsas, ajuste por desdobramento, fim com 15 min de atraso e paginação", async () => {
    const al = fakeAlpaca();
    const svc = createCandleService({ fetch: async () => ({}), dataFetch: al.fetch, now: () => NOW });
    const r = await svc.getCandles({ symbol: "AAPL", range: "MAX", interval: "1D", alpaca: { keyId: KEY_ID, secret: SECRET } });
    expect(r.source).toBe("alpaca");
    expect(new Date(r.candles[0].t).toISOString().slice(0, 10)).toBe("2016-01-04");
    expect(al.calls.length).toBeGreaterThan(1); // more than one page
    for (const { url } of al.calls) {
      expect(url.searchParams.get("feed")).toBe("sip");
      expect(url.searchParams.get("adjustment")).toBe("split");
      expect(NOW - Date.parse(url.searchParams.get("end")!)).toBeGreaterThanOrEqual(15 * 60_000);
      expect(url.toString()).not.toContain(SECRET); // never in the URL
    }
  });

  it("ação: sem Alpaca nem Massive pede a chave; chave da Alpaca recusada vira mensagem clara", async () => {
    const al = fakeAlpaca();
    const svc = createCandleService({ fetch: async () => ({}), dataFetch: al.fetch, now: () => NOW });
    await expect(svc.getCandles({ symbol: "AAPL", range: "1A" })).rejects.toMatchObject({ status: 400, code: "CHART_KEY_MISSING" });
    await expect(
      svc.getCandles({ symbol: "AAPL", range: "1A", alpaca: { keyId: KEY_ID, secret: "wrongsecret000000000000000000000000" } })
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Alpaca recusou/) });
  });
});

describe("cache de velas por chave (v0.9.1)", () => {
  const massiveDaily = async () => ({ results: [{ t: NOW - DAY, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] });

  it("chave da Alpaca salva depois de abrir o gráfico vale na hora (não fica presa no cache da Massive)", async () => {
    const al = fakeAlpaca();
    const svc = createCandleService({ fetch: massiveDaily, dataFetch: al.fetch, now: () => NOW });
    const before = await svc.getCandles({ symbol: "AAPL", range: "1A", interval: "1D", apiKey: "massivekey123456" });
    expect(before.source).toBe("massive");
    const after = await svc.getCandles({ symbol: "AAPL", range: "1A", interval: "1D", apiKey: "massivekey123456", alpaca: { keyId: KEY_ID, secret: SECRET } });
    expect(after.source).toBe("alpaca");
    expect(after.cached).toBe(false);
  });

  it("usuário sem chave não recebe o gráfico que outro usuário deixou no cache", async () => {
    const al = fakeAlpaca();
    const svc = createCandleService({ fetch: massiveDaily, dataFetch: al.fetch, now: () => NOW });
    await svc.getCandles({ symbol: "AAPL", range: "1A", alpaca: { keyId: KEY_ID, secret: SECRET } });
    await expect(svc.getCandles({ symbol: "AAPL", range: "1A" })).rejects.toMatchObject({ code: "CHART_KEY_MISSING" });
  });

  it("Alpaca fora do ar: a reserva responde, o aviso vai junto e a Alpaca é tentada de novo em 5 min", async () => {
    let t = NOW;
    let alpacaDown = true;
    const al = fakeAlpaca();
    const dataFetch: DataFetch = async (url, headers) => {
      if (alpacaDown) throw new ProviderError(500, "HTTP 500");
      return al.fetch(url, headers);
    };
    const warn = console.warn;
    const logs: string[] = [];
    console.warn = (msg: string) => logs.push(msg);
    try {
      const svc = createCandleService({ fetch: massiveDaily, dataFetch, now: () => t });
      const keys = { apiKey: "massivekey123456", alpaca: { keyId: KEY_ID, secret: SECRET } };
      const first = await svc.getCandles({ symbol: "AAPL", range: "1A", interval: "1D", ...keys });
      expect(first).toMatchObject({ source: "massive", fallbackFrom: "alpaca" });
      expect(logs.join("\n")).toContain("alpaca falhou para AAPL (status 500)");
      expect(logs.join("\n")).not.toContain(SECRET);

      alpacaDown = false;
      t += 4 * 60_000; // still inside the short fallback cache
      expect((await svc.getCandles({ symbol: "AAPL", range: "1A", interval: "1D", ...keys })).source).toBe("massive");
      t += 2 * 60_000; // past 5 minutes: Alpaca again
      const back = await svc.getCandles({ symbol: "AAPL", range: "1A", interval: "1D", ...keys });
      expect(back.source).toBe("alpaca");
      expect(back.fallbackFrom).toBeUndefined();
    } finally {
      console.warn = warn;
    }
  });

  it("cripto que a Coinbase não lista (404) vai para a Binance sem aviso de falha", async () => {
    const dataFetch: DataFetch = async (url) => {
      if (url.includes("coinbase")) throw new ProviderError(404, "NotFound");
      return [[NOW, "1", "2", "0.5", "1.5", "10"]];
    };
    const svc = createCandleService({ fetch: async () => ({}), dataFetch, now: () => NOW });
    const r = await svc.getCandles({ symbol: "X:PEPEUSD", range: "1A", interval: "1D" });
    expect(r.source).toBe("binance");
    expect(r.fallbackFrom).toBeUndefined();
  });
});

describe("médias móveis", () => {
  const daily = (n: number, start = Date.UTC(2020, 0, 6, 5)) => Array.from({ length: n }, (_, i) => ({ t: start + i * DAY, c: i + 1 }));

  it("MM 200 dias = média simples dos últimos 200 fechamentos; antes disso não aparece", () => {
    const ma = movingAverage(daily(250), "200D");
    expect(ma).toHaveLength(51);
    expect(ma[0].v).toBe(100.5); // (1..200)/200
    expect(ma.at(-1)!.v).toBe(150.5); // (51..250)/200
  });

  it("MM 200 semanas usa o fechamento de cada semana e, na semana corrente, o fechamento do dia (sem olhar o futuro)", () => {
    const days = daily(7 * 210); // 210 weeks starting on a Monday
    const ma = movingAverage(days, "200W");
    // first value: the 200th week, on its Monday: 199 finished weeks (closes 7, 14, ..., 1393) + that Monday (1394)
    const firstT = days[199 * 7].t;
    expect(ma[0].t).toBe(firstT);
    const expected = (Array.from({ length: 199 }, (_, w) => (w + 1) * 7).reduce((a, b) => a + b, 0) + 1394) / 200;
    expect(ma[0].v).toBeCloseTo(expected, 9);
    expect(movingAverage(daily(7 * 150), "200W")).toHaveLength(0); // not enough history
  });

  it("MM 50 meses só aparece com 50 meses; o valor de cada vela é o do último dia até o fim dela", () => {
    expect(movingAverage(daily(365 * 4), "50M")).toHaveLength(0);
    expect(movingAverage(daily(365 * 5), "50M").length).toBeGreaterThan(0);

    const series = [
      { t: 1000, v: 1 },
      { t: 2000, v: 2 },
      { t: 3000, v: 3 },
    ];
    expect(alignToCandles(series, [500, 1500, 2600])).toEqual([
      { t: 500, v: 1 }, // series point 1000 is before the next candle (1500)
      { t: 1500, v: 2 },
      { t: 2600, v: 3 },
    ]);
  });
});

describe("chave da Alpaca e rota das médias", () => {
  async function setup() {
    const db = openDatabase(":memory:");
    const al = fakeAlpaca();
    const app = createApp(db, loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
      finnhubFetch: async () => ({ c: 100 }),
      massiveFetch: async () => ({ results: [] }),
      dataFetch: al.fetch,
    });
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ email: "ana@example.com", password: PASSWORD, confirmPassword: PASSWORD });
    return { db, agent, al };
  }

  it("testa antes de salvar, mostra só o final e nunca vai para o backup", async () => {
    const { db, agent } = await setup();
    expect((await agent.post("/api/auth/alpaca-key").send({ keyId: KEY_ID, secret: "wrongsecret000000000000000000000000" })).status).toBe(400);
    expect((await agent.post("/api/auth/alpaca-key").send({ keyId: "x", secret: SECRET })).status).toBe(400);

    const ok = await agent.post("/api/auth/alpaca-key").send({ keyId: KEY_ID, secret: SECRET });
    expect(ok.status).toBe(200);
    expect(ok.body.user.hasAlpacaKey).toBe(true);
    expect(JSON.stringify(ok.body)).not.toContain(SECRET);

    const info = await agent.get("/api/account");
    expect(info.body.alpacaKeyHint).toBe("••••000A");
    const backup = await agent.get("/api/export");
    expect(JSON.stringify(backup.body)).not.toContain(KEY_ID);
    expect(JSON.stringify(backup.body)).not.toContain(SECRET);
    expect(db.prepare("SELECT alpaca_secret FROM users").get()).toEqual({ alpaca_secret: SECRET });
  });

  it("/api/candles usa a Alpaca para ações e /api/indicators devolve só as médias pedidas, a partir da data do gráfico", async () => {
    const { agent } = await setup();
    await agent.post("/api/auth/alpaca-key").send({ keyId: KEY_ID, secret: SECRET });
    const candles = await agent.get("/api/candles?symbol=AAPL&range=1A");
    expect(candles.status).toBe(200);
    expect(candles.body.source).toBe("alpaca");

    const from = Date.now() - 365 * DAY;
    const res = await agent.get(`/api/indicators?symbol=AAPL&ma=200D,50M&from=${from}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.series).sort()).toEqual(["200D", "50M"]);
    expect(res.body.series["200D"].length).toBeGreaterThan(300);
    expect(res.body.series["200D"][0].t).toBeGreaterThanOrEqual(from - 40 * DAY);
    expect((await agent.get("/api/indicators?symbol=AAPL&ma=nada")).status).toBe(400);
    expect((await agent.get("/api/indicators?symbol=<x>&ma=200D")).status).toBe(400);
  });
});

describe("migração v6", () => {
  it("banco da v0.8 ganha as colunas da chave da Alpaca, sem perder nada", () => {
    const legacy = new Database(":memory:");
    migrate(legacy);
    legacy.exec("INSERT INTO users (email, created_at, updated_at, massive_key) VALUES ('a@b.c', 'x', 'x', 'mk')");
    legacy.exec("ALTER TABLE users DROP COLUMN alpaca_key_id; ALTER TABLE users DROP COLUMN alpaca_secret; PRAGMA user_version = 5;");
    migrate(legacy);
    expect(legacy.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(6);
    expect(legacy.prepare("SELECT massive_key, alpaca_key_id FROM users").get()).toEqual({ massive_key: "mk", alpaca_key_id: null });
  });
});
