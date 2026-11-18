/**
 * Nothing is deleted without asking. Every call in src/ to an endpoint that
 * deletes or replaces data must be preceded, inside the same function, by
 * confirmDestructive(...) (src/lib/confirm.ts). A new delete button that skips
 * the question fails here, in CI.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmDestructive } from "../src/lib/confirm";

const SRC = path.resolve(__dirname, "../src");

/** Endpoints (src/api/endpoints.ts) that delete or overwrite data. */
const DESTRUCTIVE = /\b(portfolioApi\.(deleteStock|deleteTransaction|deleteValuation|importBackup)|tabsApi\.(remove|classify)|authApi\.deleteAccount|portfoliosApi\.remove)\(/g;

/**
 * Protected another way: deleting a portfolio needs the password AND the
 * portfolio name typed by hand (ManagePortfoliosModal), checked by the server.
 */
const EXEMPT = new Set(["portfoliosApi.remove"]);

/** Where a function starts (const x = async ..., useCallback(async ..., function x(...)). */
const FUNCTION_START = /(const \w+ = (useCallback\()?async\b|function \w+\s*\()/g;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "api" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function callSites() {
  return sourceFiles(SRC).flatMap((file) => {
    const text = fs.readFileSync(file, "utf8");
    return [...text.matchAll(DESTRUCTIVE)].map((m) => {
      const before = text.slice(0, m.index);
      const starts = [...before.matchAll(FUNCTION_START)];
      const fnStart = starts.length ? starts[starts.length - 1].index! : 0;
      const line = before.split("\n").length;
      return {
        call: m[1],
        where: `${path.relative(SRC, file)}:${line}`,
        asks: text.slice(fnStart, m.index).includes("confirmDestructive("),
      };
    });
  });
}

describe("confirmação antes de apagar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("toda exclusão no app pergunta antes", () => {
    const sites = callSites();
    // The scan must actually find the deletes (guards against a broken regex passing silently).
    expect(sites.map((s) => s.call).sort()).toEqual(
      [
        "authApi.deleteAccount",
        "portfolioApi.deleteStock",
        "portfolioApi.deleteValuation",
        "portfolioApi.deleteTransaction",
        "portfolioApi.importBackup",
        "portfoliosApi.remove",
        "tabsApi.classify",
        "tabsApi.remove",
      ].sort()
    );
    const unprotected = sites.filter((s) => !s.asks && !EXEMPT.has(s.call)).map((s) => `${s.call} em ${s.where}`);
    expect(unprotected).toEqual([]);
  });

  it("Cancelar não apaga; a pergunta avisa que não tem volta", () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    expect(confirmDestructive("Excluir a COMPRA?")).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Excluir a COMPRA?\n\nIsso não pode ser desfeito.");
    confirm.mockReturnValue(true);
    expect(confirmDestructive("Excluir?")).toBe(true);
  });
});
