import { describe, expect, it } from "vitest";
import { filterRegularSession, groupTradesByCandle, nySessionDate } from "../shared/chartData";

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
