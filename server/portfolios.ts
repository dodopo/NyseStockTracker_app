/**
 * Portfolios (carteiras): one login, many portfolios. Each portfolio has its
 * own tabs, assets and trades. This module owns the portfolio routes, the
 * middleware that scopes a request to one portfolio, and the global view.
 *
 * Scoping: the client sends the active portfolio in the X-Portfolio-Id header.
 * The server always checks that it belongs to the logged-in user; anything
 * else is 404 (never reveals whether another user's portfolio exists).
 */
import type express from "express";
import { DEFAULT_TAB, type DB } from "./db";
import { HttpError, nowIso, parseBody, wrap } from "./http";
import {
  portfolioCreateSchema,
  portfolioDeleteSchema,
  portfolioReorderSchema,
  portfolioUpdateSchema,
} from "../shared/schemas";

export const PORTFOLIO_HEADER = "x-portfolio-id";

/** One rule for "same name" everywhere (create, rename, restore): Unicode-aware, case-insensitive. */
export function nameKey(name: string) {
  return name.normalize("NFC").toLocaleLowerCase("pt-BR");
}
export const MAX_PORTFOLIOS = 50;

type PortfolioRow = {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  asset_count?: number;
};

export type PortfolioDto = ReturnType<typeof portfolioDto>;

function portfolioDto(p: PortfolioRow) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    sortOrder: p.sort_order,
    archived: p.archived_at !== null,
    archivedAt: p.archived_at,
    createdAt: p.created_at,
    assetCount: p.asset_count ?? 0,
  };
}

const TX_COLUMNS = `id, portfolio_id, ticker, type, shares_dec AS shares, price_dec AS price, date, created_at, sort_order`;

export function createPortfolios(
  db: DB,
  deps: {
    requireAuth: express.RequestHandler;
    currentUser: (res: express.Response) => { id: number };
    checkPassword: (user: any, password: string) => Promise<void>;
    authLimiter: express.RequestHandler;
  }
) {
  const q = {
    list: db.prepare(
      `SELECT p.id, p.name, p.color, p.sort_order, p.archived_at, p.created_at,
              (SELECT COUNT(*) FROM stocks s WHERE s.portfolio_id = p.id) AS asset_count
       FROM portfolios p WHERE p.user_id = ? ORDER BY p.sort_order ASC, p.id ASC`
    ),
    get: db.prepare(`SELECT id, name, color, sort_order, archived_at, created_at FROM portfolios WHERE user_id = ? AND id = ?`),
    first: db.prepare(
      `SELECT id FROM portfolios WHERE user_id = ? ORDER BY (archived_at IS NOT NULL), sort_order ASC, id ASC LIMIT 1`
    ),
    count: db.prepare(`SELECT COUNT(*) AS n FROM portfolios WHERE user_id = ?`),
    countActive: db.prepare(`SELECT COUNT(*) AS n FROM portfolios WHERE user_id = ? AND archived_at IS NULL`),
    nextOrder: db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM portfolios WHERE user_id = ?`),
    insert: db.prepare(
      `INSERT INTO portfolios (user_id, name, color, sort_order, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)`
    ),
    insertTab: db.prepare(
      `INSERT INTO tabs (user_id, portfolio_id, name, asset_type, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`
    ),
    update: db.prepare(
      `UPDATE portfolios SET name = COALESCE(?, name), color = COALESCE(?, color), updated_at = ? WHERE user_id = ? AND id = ?`
    ),
    setArchived: db.prepare(`UPDATE portfolios SET archived_at = ?, updated_at = ? WHERE user_id = ? AND id = ?`),
    setOrder: db.prepare(`UPDATE portfolios SET sort_order = ? WHERE user_id = ? AND id = ?`),
    remove: db.prepare(`DELETE FROM portfolios WHERE user_id = ? AND id = ?`),

    globalTabs: db.prepare(
      `SELECT t.id, t.portfolio_id, t.name, t.asset_type, t.color, t.sort_order,
              (SELECT COUNT(*) FROM stocks s WHERE s.tab_id = t.id) AS asset_count
       FROM tabs t JOIN portfolios p ON p.id = t.portfolio_id
       WHERE t.user_id = ? AND p.archived_at IS NULL ORDER BY p.sort_order, p.id, t.sort_order, t.id`
    ),
    globalStocks: db.prepare(
      `SELECT s.id, s.portfolio_id, s.ticker, s.name, s.created_at, s.asset_type, s.tab_id
       FROM stocks s JOIN portfolios p ON p.id = s.portfolio_id
       WHERE s.user_id = ? AND p.archived_at IS NULL ORDER BY s.ticker`
    ),
    globalTx: db.prepare(
      `SELECT ${TX_COLUMNS} FROM transactions
       WHERE user_id = ? AND portfolio_id IN (SELECT id FROM portfolios WHERE user_id = ? AND archived_at IS NULL)
       ORDER BY date DESC, sort_order DESC, id DESC`
    ),
  };

  /** Creates a portfolio with the default tab. Call inside a transaction. */
  function createPortfolio(userId: number, name: string, color: string) {
    const now = nowIso();
    const order = (q.nextOrder.get(userId) as { n: number }).n;
    const id = Number(q.insert.run(userId, name, color, order, now, now).lastInsertRowid);
    q.insertTab.run(userId, id, DEFAULT_TAB.name, DEFAULT_TAB.assetType, DEFAULT_TAB.color, now);
    return id;
  }

  const notFound = () => new HttpError(404, "Carteira não encontrada", "PORTFOLIO_NOT_FOUND");

  function ownPortfolio(userId: number, raw: unknown) {
    const id = Number(raw);
    const row = typeof raw === "string" && /^\d{1,12}$/.test(raw) ? (q.get.get(userId, id) as PortfolioRow | undefined) : undefined;
    if (!row) throw notFound();
    return row;
  }

  /**
   * Scopes the request to one portfolio of the logged-in user (after requireAuth).
   * Without the header: the user's first active portfolio (older clients).
   */
  const requirePortfolio: express.RequestHandler = (req, res, next) => {
    try {
      const user = deps.currentUser(res);
      const header = req.headers[PORTFOLIO_HEADER];
      if (header === undefined) {
        const first = q.first.get(user.id) as { id: number } | undefined;
        if (!first) throw notFound();
        res.locals.portfolioId = first.id;
      } else {
        res.locals.portfolioId = ownPortfolio(user.id, Array.isArray(header) ? header[0] : header).id;
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  const currentPortfolio = (res: express.Response) => res.locals.portfolioId as number;

  const list = (userId: number) => (q.list.all(userId) as PortfolioRow[]).map(portfolioDto);
  const nameTaken = (userId: number, name: string, exceptId?: number) =>
    list(userId).some((p) => p.id !== exceptId && nameKey(p.name) === nameKey(name));

  function register(app: express.Express) {
    const { requireAuth, currentUser } = deps;

    app.get("/api/portfolios", requireAuth, (_req, res) => {
      res.json(list(currentUser(res).id));
    });

    app.post("/api/portfolios", requireAuth, (req, res) => {
      const user = currentUser(res);
      const { name, color } = parseBody(portfolioCreateSchema, req.body);
      if ((q.count.get(user.id) as { n: number }).n >= MAX_PORTFOLIOS) {
        throw new HttpError(400, `Limite de ${MAX_PORTFOLIOS} carteiras`);
      }
      if (nameTaken(user.id, name)) throw new HttpError(400, "Já existe uma carteira com esse nome");
      const id = db.transaction(() => createPortfolio(user.id, name, color))();
      res.status(201).json(portfolioDto(q.get.get(user.id, id) as PortfolioRow));
    });

    app.patch("/api/portfolios/:id", requireAuth, (req, res) => {
      const user = currentUser(res);
      const portfolio = ownPortfolio(user.id, req.params.id);
      const { name, color, archived } = parseBody(portfolioUpdateSchema, req.body);
      if (name !== undefined && nameTaken(user.id, name, portfolio.id)) throw new HttpError(400, "Já existe uma carteira com esse nome");
      db.transaction(() => {
        const now = nowIso();
        if (name !== undefined || color !== undefined) q.update.run(name ?? null, color ?? null, now, user.id, portfolio.id);
        if (archived === true && portfolio.archived_at === null) {
          if ((q.countActive.get(user.id) as { n: number }).n <= 1) {
            throw new HttpError(400, "Não é possível arquivar a única carteira ativa");
          }
          q.setArchived.run(now, now, user.id, portfolio.id);
        }
        if (archived === false && portfolio.archived_at !== null) q.setArchived.run(null, now, user.id, portfolio.id);
      })();
      res.json(portfolioDto(q.get.get(user.id, portfolio.id) as PortfolioRow));
    });

    app.post("/api/portfolios/reorder", requireAuth, (req, res) => {
      const user = currentUser(res);
      const { ids } = parseBody(portfolioReorderSchema, req.body);
      const mine = new Set(list(user.id).map((p) => p.id));
      if (ids.length !== mine.size || ids.some((id) => !mine.has(id)) || new Set(ids).size !== ids.length) {
        throw new HttpError(400, "A nova ordem precisa conter todas as suas carteiras, uma vez cada");
      }
      db.transaction(() => ids.forEach((id, i) => q.setOrder.run(i + 1, user.id, id)))();
      res.json(list(user.id));
    });

    // Permanent: removes the portfolio's tabs, assets and trades (ON DELETE CASCADE).
    // POST (not DELETE) because it carries the password in the body.
    app.post(
      "/api/portfolios/:id/delete",
      deps.authLimiter,
      requireAuth,
      wrap(async (req, res) => {
        const user = currentUser(res);
        const portfolio = ownPortfolio(user.id, req.params.id);
        const { password, confirmName } = parseBody(portfolioDeleteSchema, req.body);
        await deps.checkPassword(user, password);
        if (nameKey(confirmName) !== nameKey(portfolio.name)) {
          throw new HttpError(400, "Digite o nome da carteira exatamente como ele aparece para confirmar");
        }
        db.transaction(() => {
          if ((q.count.get(user.id) as { n: number }).n <= 1) throw new HttpError(400, "Não é possível excluir a única carteira");
          if (portfolio.archived_at === null && (q.countActive.get(user.id) as { n: number }).n <= 1) {
            throw new HttpError(400, "Não é possível excluir a única carteira ativa");
          }
          q.remove.run(user.id, portfolio.id);
        })();
        res.json(list(user.id));
      })
    );

    // Global view: every active portfolio at once, each row tagged with its portfolio.
    app.get("/api/global", requireAuth, (_req, res) => {
      const user = currentUser(res);
      type GlobalTab = Omit<PortfolioRow, "archived_at" | "created_at"> & { portfolio_id: number; asset_type: string };
      res.json({
        portfolios: list(user.id).filter((p) => !p.archived),
        tabs: (q.globalTabs.all(user.id) as GlobalTab[]).map((t) => ({
          id: t.id,
          portfolioId: t.portfolio_id,
          name: t.name,
          assetType: t.asset_type,
          color: t.color,
          sortOrder: t.sort_order,
          assetCount: t.asset_count ?? 0,
        })),
        stocks: q.globalStocks.all(user.id),
        transactions: q.globalTx.all(user.id, user.id),
      });
    });
  }

  return { requirePortfolio, currentPortfolio, createPortfolio, list, register };
}
