import { describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { parsePositiveDecimal } from "../shared/decimal";
import { calculatePosition } from "../shared/positions";
import { transactionSchema } from "../shared/schemas";
import { migrate, openDatabase, SCHEMA_VERSION } from "../server/db";
import { createApp } from "../server/app";
import { loadConfig } from "../server/config";

describe("decimais exatos (shared/decimal)", () => {
  it("normaliza para a forma canônica", () => {
    expect(parsePositiveDecimal("0.10")).toBe("0.1");
    expect(parsePositiveDecimal("10")).toBe("10");
    expect(parsePositiveDecimal(1e-8)).toBe("0.00000001");
    expect(parsePositiveDecimal("123.45678901")).toBe("123.45678901");
  });

  it("recusa zero, negativos, mais de 8 casas, notação estranha e números gigantes", () => {
    for (const bad of ["0", "-1", "0.000000001", "1e3", "1,5", "abc", "", "1234567890123", NaN, Infinity, null]) {
      expect(parsePositiveDecimal(bad as unknown)).toBeNull();
    }
  });
});

describe("cálculo de preço médio (shared/positions)", () => {
  it("compra, compra, venda: PM ponderado e lucro realizado", () => {
    const p = calculatePosition(
      [
        { id: 1, type: "BUY", shares: "10", price: "100", date: "2026-01-01" },
        { id: 2, type: "BUY", shares: "10", price: "200", date: "2026-01-02" },
        { id: 3, type: "SELL", shares: "5", price: "300", date: "2026-01-03" },
      ],
      250
    );
    expect(p.quantity).toBe("15");
    expect(p.avgCost).toBe(150);
    expect(p.openCost).toBe(2250);
    expect(p.realizedPnL).toBe(750);
    expect(p.unrealizedPnL).toBe(1500);
  });

  it("frações sem erro de ponto flutuante: 0.1 + 0.2 - 0.3 zera a posição", () => {
    const p = calculatePosition(
      [
        { id: 1, type: "BUY", shares: "0.1", price: "100", date: "2026-01-01" },
        { id: 2, type: "BUY", shares: "0.2", price: "100", date: "2026-01-02" },
        { id: 3, type: "SELL", shares: "0.3", price: "100", date: "2026-01-03" },
      ],
      100
    );
    expect(p.quantity).toBe("0");
    expect(p.openCost).toBe(0);
    expect(p.realizedPnL).toBe(0);
  });

  it("ordem por data, não por ordem de inserção", () => {
    const p = calculatePosition(
      [
        { id: 2, type: "SELL", shares: "1", price: "20", date: "2026-02-01" },
        { id: 1, type: "BUY", shares: "1", price: "10", date: "2026-01-01" },
      ],
      0
    );
    expect(p.realizedPnL).toBe(10);
    expect(p.quantity).toBe("0");
  });
});

describe("schema de transação (shared/schemas)", () => {
  it("aceita número ou texto e devolve texto exato", () => {
    const r = transactionSchema.parse({ ticker: "aapl", type: "buy", shares: 0.5, price: "162.85", date: "2026-11-14" });
    expect(r).toEqual({ ticker: "AAPL", type: "BUY", shares: "0.5", price: "162.85", date: "2026-11-14" });
  });

  it("explica o erro em português", () => {
    const r = transactionSchema.safeParse({ ticker: "AAPL", type: "BUY", shares: "0.123456789", price: "1", date: "2026-11-14" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toMatch(/até 8 casas decimais/);
  });
});

describe("migração v3 e compatibilidade de rollback", () => {
  it("converte REAL antigo em texto exato, mantendo as colunas antigas", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, 6);
    db.prepare(`INSERT INTO users (email, created_at, updated_at) VALUES ('a@example.com','x','x')`).run();
    db.prepare(`INSERT INTO stocks (user_id, ticker, name, created_at) VALUES (1,'AAPL','Apple','x')`).run();
    // Row written the v0.4.x way (only REAL columns), e.g. after a rollback.
    db.prepare(
      `INSERT INTO transactions (user_id, ticker, type, shares, price, date, created_at, sort_order)
       VALUES (1,'AAPL','BUY',0.1,162.85,'2026-01-01','x',1)`
    ).run();

    migrate(db); // runs the idempotent backfill again

    const row = db.prepare(`SELECT shares, price, shares_dec, price_dec FROM transactions`).get();
    expect(row).toEqual({ shares: 0.1, price: 162.85, shares_dec: "0.1", price_dec: "162.85" });
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  it("v0.5.0 continua gravando as colunas REAL (a v0.4.1 lê o mesmo banco)", async () => {
    const db = openDatabase(":memory:");
    const app = createApp(db, loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
      finnhubFetch: async () => ({}),
    });
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({
      email: "a@example.com",
      password: "correct-horse-battery",
      confirmPassword: "correct-horse-battery",
    });
    const tabId = (await agent.get("/api/tabs")).body[0].id; // default "Ações" tab
    await agent.post("/api/stocks").send({ ticker: "BTC", name: "Grayscale Bitcoin Mini Trust", tabId });
    const res = await agent
      .post("/api/transactions")
      .send({ ticker: "BTC", type: "BUY", shares: "0.00000001", price: "65721.55", date: "2026-11-14" });
    expect(res.status).toBe(201);

    const row = db.prepare(`SELECT shares, price, shares_dec, price_dec FROM transactions`).get();
    expect(row).toEqual({ shares: 1e-8, price: 65721.55, shares_dec: "0.00000001", price_dec: "65721.55" });

    const list = await agent.get("/api/transactions");
    expect(list.body[0].shares).toBe("0.00000001");
  });

  it("um banco v2 (v0.4.x) sobe para a versão atual sem perder nada", () => {
    const legacy = new Database(":memory:");
    legacy.pragma("foreign_keys = ON");
    migrate(legacy, 2);
    legacy.exec(`
      INSERT INTO users (email, created_at, updated_at) VALUES ('a@example.com','x','x');
      INSERT INTO stocks (user_id, ticker, name, created_at) VALUES (1,'AAPL','Apple','x');
      INSERT INTO transactions (user_id, ticker, type, shares, price, date, created_at, sort_order)
        VALUES (1,'AAPL','BUY',3,100.5,'2026-01-01','x',1);
    `);

    migrate(legacy);

    expect(legacy.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(legacy.prepare(`SELECT shares_dec, price_dec FROM transactions`).get()).toEqual({
      shares_dec: "3",
      price_dec: "100.5",
    });
  });
});
