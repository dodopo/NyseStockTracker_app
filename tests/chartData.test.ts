import { describe, expect, it } from "vitest";
import { candleDate, chartTimeMs, filterRegularSession, groupTradesByCandle, nySessionDate } from "../shared/chartData";
import { isChartStale, isUsMarketOpen } from "../shared/chartRanges";

// 13 Nov 2026 is in EST (UTC-5): 09:30 NY = 14:30 UTC, 16:00 NY = 21:00 UTC.
const at = (utc: string) => ({ t: Date.parse(utc), o: 1, h: 1, l: 1, c: 1, v: 1 });

describe("pregão regular (9h30–16h de NY)", () => {
  const fiveMin = [
    at("2026-11-13T09:00:00Z"), // 04:00 NY pre-market
    at("2026-11-13T14:25:00Z"), // 09:25 NY pre-market (ends 09:30)
    at("2026-11-13T14:30:00Z"), // 09:30 NY open
    at("2026-11-13T20:55:00Z"), // 15:55 NY last regular bar
    at("2026-11-13T21:00:00Z"), // 16:00 NY after-hours
    at("2026-11-14T00:55:00Z"), // 19:55 NY after-hours
  ];

  it("velas de 5 min: tira pré e pós-mercado", () => {
    const kept = filterRegularSession(fiveMin, "5m").map((c) => new Date(c.t).toISOString().slice(11, 16));
    expect(kept).toEqual(["14:30", "20:55"]);
  });

  it("vela de 1 hora que começa às 9h contém 9h30–10h e fica", () => {
    const hours = [at("2026-11-13T13:00:00Z"), at("2026-11-13T14:00:00Z"), at("2026-11-13T20:00:00Z"), at("2026-11-13T21:00:00Z")];
    const kept = filterRegularSession(hours, "1h").map((c) => new Date(c.t).toISOString().slice(11, 16));
    expect(kept).toEqual(["14:00", "20:00"]); // 08:00 and 16:00 NY are out
  });

  it("respeita o horário de verão de NY (EDT, UTC-4)", () => {
    const july = [at("2026-07-15T13:25:00Z"), at("2026-07-15T13:30:00Z")]; // 09:25 and 09:30 EDT
    expect(filterRegularSession(july, "5m")).toHaveLength(1);
  });

  it("velas diárias ou maiores não são filtradas", () => {
    expect(filterRegularSession(fiveMin, "1D")).toHaveLength(fiveMin.length);
  });
});

describe("operações por vela", () => {
  const daily = ["2026-03-17", "2026-03-18", "2026-03-31", "2026-04-21", "2026-04-23"].map((d) => at(`${d}T21:00:00Z`));
  const trades = [
    { id: 1, type: "BUY" as const, shares: "1000", price: "283.98", date: "2026-03-18" },
    { id: 2, type: "BUY" as const, shares: "100", price: "290.32", date: "2026-03-31" },
    { id: 3, type: "SELL" as const, shares: "500", price: "301.64", date: "2026-04-21" },
    { id: 4, type: "SELL" as const, shares: "600", price: "304.34", date: "2026-04-23" },
    { id: 5, type: "BUY" as const, shares: "1", price: "1", date: "2025-01-01" }, // before the range
  ];

  it("no diário, cada operação na vela do seu dia; fora do período fica de fora", () => {
    const g = groupTradesByCandle(daily, trades);
    expect([...g.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(g.get(1)?.buys.map((t) => t.id)).toEqual([1]);
    expect(g.get(4)?.sells.map((t) => t.id)).toEqual([4]);
  });

  it("no mensal, operações do mesmo mês ficam juntas na mesma vela", () => {
    const monthly = ["2026-03-01", "2026-04-01", "2026-05-01"].map((d) => at(`${d}T05:00:00Z`));
    const g = groupTradesByCandle(monthly, trades);
    expect(g.get(0)?.buys.map((t) => t.id)).toEqual([1, 2]);
    expect(g.get(1)?.sells.map((t) => t.id)).toEqual([3, 4]);
  });

  it("data de pregão é a de NY, não a UTC", () => {
    expect(nySessionDate(Date.parse("2026-11-14T00:55:00Z"))).toBe("2026-11-13");
  });
});

describe("aviso de dados atrasados", () => {
  const fri15h = Date.parse("2026-11-13T20:00:00Z"); // Friday 15:00 New York
  const sat = Date.parse("2026-11-14T23:50:00Z");

  it("pregão aberto só em dia útil, das 9h30 às 16h de NY", () => {
    expect(isUsMarketOpen(fri15h)).toBe(true);
    expect(isUsMarketOpen(Date.parse("2026-11-13T14:29:00Z"))).toBe(false); // 09:29
    expect(isUsMarketOpen(sat)).toBe(false);
  });

  it("cripto: vela de ontem é atraso (caso real da Massive grátis); vela do minuto não é", () => {
    expect(isChartStale(Date.parse("2026-11-13T23:55:00Z"), "5m", true, sat)).toBe(true);
    expect(isChartStale(sat - 5 * 60_000, "5m", true, sat)).toBe(false);
    expect(isChartStale(Date.parse("2026-11-14T00:00:00Z"), "1D", true, sat)).toBe(false); // today's daily candle
  });

  it("ações: 15 min de atraso no pregão é normal; vela de ontem no pregão é atraso; fim de semana não avisa", () => {
    expect(isChartStale(fri15h - 20 * 60_000, "5m", false, fri15h)).toBe(false);
    expect(isChartStale(Date.parse("2026-11-12T05:00:00Z"), "1D", false, fri15h)).toBe(true);
    expect(isChartStale(Date.parse("2026-11-14T00:55:00Z"), "5m", false, sat)).toBe(false);
  });
});

describe("data da vela por tipo de ativo (v0.10.1)", () => {
  // Real case 15/11: Coinbase daily candle of 31/10 starts 2026-10-31T00:00Z = 30/10 21:00 in Brazil.
  const btc31 = Date.parse("2026-10-31T00:00:00Z");

  it("cripto usa a data UTC; ação usa a data de NY", () => {
    expect(candleDate(btc31, true)).toBe("2026-10-31");
    expect(candleDate(btc31, false)).toBe("2026-10-30"); // NY date of the same instant: why crypto must not use it
    expect(candleDate(Date.parse("2026-10-30T04:00:00Z"), false)).toBe("2026-10-30"); // stock daily candle (midnight NY)
  });

  it("compra de cripto em 29/10 fica na vela de 29/10, não na de 30/10", () => {
    const days = ["2026-10-28", "2026-10-29", "2026-10-30"].map((d) => ({ t: Date.parse(`${d}T00:00:00Z`) }));
    const trade = [{ type: "BUY" as const, shares: "0.00001", price: "81742", date: "2026-10-29" }];
    expect([...groupTradesByCandle(days, trade, true).keys()]).toEqual([1]);
  });

  it("virada de ano: a semana que começa em 01/01/2024 (segunda) é de 2024", () => {
    expect(candleDate(Date.parse("2024-01-01T00:00:00Z"), true).slice(0, 4)).toBe("2024");
  });
});

describe("horário do gráfico (v0.10.2)", () => {
  // Real case 15/11: on the 1M chart the November mark appeared at 31/10 22:00 (local) labeled "out.".
  const nov1utc = Date.parse("2026-11-01T00:00:00Z");
  const brazil = 180; // UTC-3, as Date#getTimezoneOffset returns it

  it("intradiário vai para o horário local: a virada de novembro em UTC ainda é 31/10 no Brasil", () => {
    const shifted = new Date(chartTimeMs(nov1utc, true, brazil));
    expect(shifted.toISOString().slice(0, 16)).toBe("2026-10-31T21:00");
    // and local midnight of 01/11 (03:00 UTC) becomes the chart's 01/11 00:00: the month mark lands there
    expect(new Date(chartTimeMs(Date.parse("2026-11-01T03:00:00Z"), true, brazil)).toISOString().slice(0, 16)).toBe("2026-11-01T00:00");
  });

  it("vela diária ou maior não muda: a data UTC já é a data da vela", () => {
    expect(chartTimeMs(nov1utc, false, brazil)).toBe(nov1utc);
  });
});
