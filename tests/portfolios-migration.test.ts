/**
 * v7 (v0.13.0) rebuilds tabs, stocks and transactions to add portfolios. These
 * tests start from a real v6 database with data and check that every row
 * survives unchanged, ids and counters are kept, and a failed check leaves the
 * old database untouched.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION, type DB } from "../server/db";

const T = "2026-01-01T00:00:00.000Z";

function v6Database(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, 6);
  expect(db.pragma("user_version", { simple: true })).toBe(6);

  const user = db.prepare(`INSERT INTO users (email, display_name, password_hash, created_at, updated_at) VALUES (?, ?, 'h', ?, ?)`);
  user.run("a@test.local", "A", T, T);
  user.run("b@test.local", "B", T, T);
  db.prepare(`INSERT INTO user_settings (user_id, currency, created_at, updated_at) VALUES (1, 'USD', ?, ?)`).run(T, T);
  db.prepare(`INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (1, 'x', ?, '2099-01-01')`).run(T);

  const tab = db.prepare(`INSERT INTO tabs (user_id, name, asset_type, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  tab.run(1, "Ações", "us_stock", "#2962ff", 1, T); // 1
  tab.run(1, "Cripto", "crypto", "#f7931a", 2, T); // 2
  tab.run(2, "Ações", "us_stock", "#2962ff", 1, T); // 3
  tab.run(1, "Apagada", "us_stock", "#78909c", 3, T); // 4, deleted below: its id must not be reused
  db.prepare(`DELETE FROM tabs WHERE id = 4`).run();

  const stock = db.prepare(`INSERT INTO stocks (user_id, ticker, name, created_at, asset_type, tab_id) VALUES (?, ?, ?, ?, ?, ?)`);
  stock.run(1, "AAPL", "Apple", T, "us_stock", 1);
  stock.run(1, "X:BTCUSD", "Bitcoin", T, "crypto", 2);
  stock.run(1, "NVDA", "Nvidia", T, "us_stock", null); // orphan: goes to "Ações"
  stock.run(2, "AAPL", "Apple", T, "us_stock", 3);

  const tx = db.prepare(
    `INSERT INTO transactions (user_id, ticker, type, shares, price, date, created_at, sort_order, shares_dec, price_dec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  tx.run(1, "AAPL", "BUY", 10, 150.25, "2025-01-02", T, 1, "10", "150.25");
  tx.run(1, "AAPL", "SELL", 2.5, 180, "2025-03-04", T, 2, "2.5", "180");
  tx.run(1, "X:BTCUSD", "BUY", 0.12345678, 60000.5, "2025-02-01", T, 3, "0.12345678", "60000.5");
  tx.run(1, "NVDA", "BUY", 1, 100, "2025-05-05", T, 4, null, null); // written by an old version (REAL only)
  tx.run(2, "AAPL", "BUY", 3, 200, "2025-06-06", T, 1, "3", "200");
  tx.run(2, "AAPL", "BUY", 1, 1, "2025-06-07", T, 2, "1", "1");
  db.prepare(`DELETE FROM transactions WHERE id = 6`).run(); // counter must stay at 6
  return db;
}

const rows = (db: DB, sql: string) => db.prepare(sql).all();

describe("migração v7: carteiras", () => {
  it("cada usuário ganha a 'Carteira principal' com tudo o que tinha, linha por linha", () => {
    const db = v6Database();
    const before = {
      tabs: rows(db, `SELECT id, user_id, name, asset_type, color, sort_order, created_at FROM tabs ORDER BY id`),
      stocks: rows(db, `SELECT id, user_id, ticker, name, created_at, asset_type FROM stocks ORDER BY id`),
      tx: rows(db, `SELECT id, user_id, ticker, type, shares, price, date, created_at, sort_order FROM transactions ORDER BY id`),
    };

    migrate(db);

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(7);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");

    const portfolios = rows(db, `SELECT id, user_id, name, archived_at FROM portfolios ORDER BY user_id`);
    expect(portfolios).toEqual([
      { id: 1, user_id: 1, name: "Carteira principal", archived_at: null },
      { id: 2, user_id: 2, name: "Carteira principal", archived_at: null },
    ]);

    expect(rows(db, `SELECT id, user_id, name, asset_type, color, sort_order, created_at FROM tabs ORDER BY id`)).toEqual(before.tabs);
    expect(rows(db, `SELECT id, user_id, ticker, name, created_at, asset_type FROM stocks ORDER BY id`)).toEqual(before.stocks);
    expect(
      rows(db, `SELECT id, user_id, ticker, type, shares, price, date, created_at, sort_order FROM transactions ORDER BY id`)
    ).toEqual(before.tx);

    // every row belongs to its owner's portfolio
    for (const table of ["tabs", "stocks", "transactions"]) {
      expect(rows(db, `SELECT COUNT(*) AS n FROM ${table} WHERE portfolio_id != user_id`)).toEqual([{ n: 0 }]);
    }
    // the orphan asset went to the portfolio's "Ações" tab; decimals were backfilled
    expect(rows(db, `SELECT tab_id FROM stocks WHERE ticker = 'NVDA'`)).toEqual([{ tab_id: 1 }]);
    expect(rows(db, `SELECT shares_dec, price_dec FROM transactions WHERE id = 4`)).toEqual([{ shares_dec: "1", price_dec: "100" }]);
    // untouched tables
    expect(rows(db, `SELECT COUNT(*) AS n FROM sessions`)).toEqual([{ n: 1 }]);
    expect(rows(db, `SELECT COUNT(*) AS n FROM user_settings`)).toEqual([{ n: 1 }]);
  });

  it("ids apagados não voltam a ser usados", () => {
    const db = v6Database();
    migrate(db);
    const tabId = db
      .prepare(`INSERT INTO tabs (user_id, portfolio_id, name, asset_type, color, sort_order, created_at) VALUES (1, 1, 'Nova', 'us_stock', '#fff', 9, ?)`)
      .run(T).lastInsertRowid;
    expect(Number(tabId)).toBe(5);
    const txId = db
      .prepare(
        `INSERT INTO transactions (user_id, portfolio_id, ticker, type, shares, price, date, created_at) VALUES (1, 1, 'AAPL', 'BUY', 1, 1, '2025-01-01', ?)`
      )
      .run(T).lastInsertRowid;
    expect(Number(txId)).toBe(7);
  });

  it("depois: mesmo ticker em duas carteiras; excluir uma carteira não toca na outra", () => {
    const db = v6Database();
    migrate(db);
    const p3 = Number(
      db
        .prepare(`INSERT INTO portfolios (user_id, name, color, sort_order, created_at, updated_at) VALUES (1, 'Holding', '#089981', 2, ?, ?)`)
        .run(T, T).lastInsertRowid
    );
    db.prepare(`INSERT INTO stocks (user_id, portfolio_id, ticker, name, created_at) VALUES (1, ?, 'AAPL', 'Apple', ?)`).run(p3, T);
    db.prepare(
      `INSERT INTO transactions (user_id, portfolio_id, ticker, type, shares, price, date, created_at) VALUES (1, ?, 'AAPL', 'BUY', 5, 10, '2025-01-01', ?)`
    ).run(p3, T);
    expect(() =>
      db.prepare(`INSERT INTO stocks (user_id, portfolio_id, ticker, name, created_at) VALUES (1, ?, 'AAPL', 'Apple', ?)`).run(p3, T)
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare(`INSERT INTO portfolios (user_id, name, color, created_at, updated_at) VALUES (1, 'holding', '#fff', ?, ?)`).run(T, T)
    ).toThrow(/UNIQUE/); // names are unique per user, ignoring case

    db.prepare(`DELETE FROM portfolios WHERE id = ?`).run(p3);
    expect(rows(db, `SELECT COUNT(*) AS n FROM stocks WHERE portfolio_id = 1`)).toEqual([{ n: 3 }]);
    expect(rows(db, `SELECT COUNT(*) AS n FROM transactions WHERE portfolio_id = 1`)).toEqual([{ n: 4 }]);
    expect(rows(db, `SELECT COUNT(*) AS n FROM transactions WHERE user_id = 1 AND portfolio_id NOT IN (SELECT id FROM portfolios)`)).toEqual([{ n: 0 }]);

    // deleting the user removes everything of that user, and only that
    db.prepare(`DELETE FROM users WHERE id = 1`).run();
    expect(rows(db, `SELECT COUNT(*) AS n FROM portfolios`)).toEqual([{ n: 1 }]);
    expect(rows(db, `SELECT COUNT(*) AS n FROM transactions`)).toEqual([{ n: 1 }]);
  });

  it("se a conferência falhar, nada muda: o banco continua na v6, com tudo", () => {
    const db = v6Database();
    // a trade whose owner no longer exists (only possible with foreign keys off at some point)
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO transactions (user_id, ticker, type, shares, price, date, created_at) VALUES (99, 'ZZZ', 'BUY', 1, 1, '2025-01-01', ?)`
    ).run(T);
    db.pragma("foreign_keys = ON");
    const before = rows(db, `SELECT * FROM transactions ORDER BY id`);

    expect(() => migrate(db)).toThrow(/Migration check failed for transactions/);
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(rows(db, `SELECT * FROM transactions ORDER BY id`)).toEqual(before);
    expect(rows(db, `SELECT name FROM sqlite_master WHERE name IN ('portfolios', 'tabs_v7', 'stocks_v7', 'transactions_v7')`)).toEqual([]);
  });
});
