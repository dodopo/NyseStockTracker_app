import { describe, expect, it } from "vitest";
import { allocationSlices, passesTabFilter, toggleTabFilter } from "../shared/allocation";

describe("filtro do consolidado por aba", () => {
  const all = ["1", "3", "none"];

  it("vazio é 'Todas'; marcar abas filtra; desmarcar a última volta para 'Todas'", () => {
    expect(toggleTabFilter([], "3", all)).toEqual(["3"]);
    expect(toggleTabFilter(["3"], "1", all)).toEqual(["1", "3"]); // kept in tab order
    expect(toggleTabFilter(["3"], "3", all)).toEqual([]);
  });

  it("marcar todas as abas é o mesmo que 'Todas'; abas que não existem mais são ignoradas", () => {
    expect(toggleTabFilter(["1", "3"], "none", all)).toEqual([]);
    expect(toggleTabFilter(["99"], "1", all)).toEqual(["1"]);
  });

  it("passa no filtro", () => {
    expect(passesTabFilter([], "3")).toBe(true);
    expect(passesTabFilter(["1"], "3")).toBe(false);
  });
});

describe("fatias da alocação", () => {
  it("maior primeiro, percentuais somam 100, posições zeradas ficam de fora", () => {
    const s = allocationSlices([
      { key: "AAPL", label: "AAPL", value: 580 },
      { key: "BTC", label: "BTC", value: 420 },
      { key: "OLD", label: "OLD", value: 0 },
    ]);
    expect(s.map((x) => x.key)).toEqual(["AAPL", "BTC"]);
    expect(s[0].pct).toBeCloseTo(58, 9);
    expect(s.reduce((sum, x) => sum + x.pct, 0)).toBeCloseTo(100, 9);
  });

  it("fatias pequenas viram 'Outros', mas uma só pequena aparece com o nome", () => {
    const many = allocationSlices([
      { key: "A", label: "A", value: 900 },
      { key: "B", label: "B", value: 20 },
      { key: "C", label: "C", value: 10 },
    ]);
    expect(many.map((x) => x.label)).toEqual(["A", "Outros (2)"]);
    const one = allocationSlices([
      { key: "A", label: "A", value: 990 },
      { key: "B", label: "B", value: 10 },
    ]);
    expect(one.map((x) => x.label)).toEqual(["A", "B"]);
  });

  it("carteira vazia não quebra", () => {
    expect(allocationSlices([])).toEqual([]);
  });
});
