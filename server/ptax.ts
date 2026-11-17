/**
 * PTAX (Banco Central do Brasil) frozen on each trade.
 *
 * Source: BCB "Olinda" open data API (no key), closing bulletin ("Fechamento")
 * of USD, EUR and CHF, buy and sell, in reais per unit. Conversions use the sell
 * rate (IN RFB 2.180/2024, art. 57). Only dates and currency codes are sent.
 *
 * Rule for a trade on date D:
 * - the rate used is the last closing bulletin on or before D (weekends and
 *   holidays have no PTAX, so the previous business day counts);
 * - it is FINAL once the BCB has published a bulletin on D or later (D's own,
 *   or a later business day, which proves none will come for D);
 * - otherwise (D is today before ~13h, or in the future) it is PROVISIONAL and
 *   replaced by `refreshPending` once the bulletin is out.
 * Final snapshots are cached per trade date in `ptax_cache`.
 */
import type { DB } from "./db";
import { PTAX_CURRENCIES, RATE_MAX, RATE_MIN, fxSnapshotSchema, parseFxSnapshot, type FxSnapshot, type PtaxCurrency } from "../shared/currencies";
import type { DataFetch } from "./providers/types";

const DAY_MS = 86_400_000;
/** Longest run of days without PTAX (Carnaval, year end) is well under this. */
const LOOKBACK_DAYS = 10;
const LOOKAHEAD_DAYS = 7;
/** A date this old with no USD bulletin at all will never get one: stop asking. */
const GIVE_UP_AFTER_DAYS = 30;
const UNAVAILABLE = JSON.stringify({ unavailable: true });
/** From this date on, USD, EUR and CHF must all be in a snapshot (the euro started in 1999). */
const ALL_CURRENCIES_FROM = "2000-01-01";

type Bulletin = { date: string; buy: string; sell: string };

function addDays(iso: string, days: number) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD -> MM-DD-YYYY (format the BCB API expects). */
function bcbDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${m}-${d}-${y}`;
}

/** Today in Brasília (PTAX dates are Brazilian dates). */
export function brazilToday(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** A rate as a plain decimal string ("5.4321"), or null if the answer is not a sane positive number. */
function rateString(value: unknown): string | null {
  const n = typeof value === "number" ? value : Number(value);
  // Sanity range for reais per USD/EUR/CHF: protects values from a broken answer.
  if (!Number.isFinite(n) || n <= RATE_MIN || n >= RATE_MAX) return null;
  const s = n.toFixed(6).replace(/\.?0+$/, "");
  return s;
}

export function createPtax(db: DB, deps: { fetchJson: DataFetch; baseUrl?: string; now?: () => number }) {
  const baseUrl = (deps.baseUrl ?? "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata").replace(/\/+$/, "");
  const now = deps.now ?? Date.now;

  const getCached = db.prepare(`SELECT snapshot FROM ptax_cache WHERE trade_date = ?`);
  const putCached = db.prepare(
    `INSERT INTO ptax_cache (trade_date, snapshot, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(trade_date) DO UPDATE SET snapshot = excluded.snapshot, fetched_at = excluded.fetched_at`
  );

  /** Closing bulletins of one currency between two dates (inclusive). */
  async function bulletins(currency: PtaxCurrency, from: string, to: string): Promise<Bulletin[]> {
    const url =
      `${baseUrl}/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)` +
      `?@moeda='${currency}'&@dataInicial='${bcbDate(from)}'&@dataFinalCotacao='${bcbDate(to)}'` +
      `&$format=json&$select=cotacaoCompra,cotacaoVenda,dataHoraCotacao,tipoBoletim`;
    const raw = await deps.fetchJson(url);
    const list: unknown[] = Array.isArray(raw?.value) ? raw.value : [];
    const out: Bulletin[] = [];
    for (const item of list as any[]) {
      if (item?.tipoBoletim !== "Fechamento") continue;
      const date = String(item?.dataHoraCotacao ?? "").slice(0, 10);
      const buy = rateString(item?.cotacaoCompra);
      const sell = rateString(item?.cotacaoVenda);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !buy || !sell) continue;
      out.push({ date, buy, sell });
    }
    return out;
  }

  /**
   * Asks the BCB. Null when the answer does not allow a snapshot yet (tried
   * again later), or "unavailable" when it never will (no PTAX for that date).
   */
  async function fetchSnapshot(tradeDate: string): Promise<FxSnapshot | null | "unavailable"> {
    const today = brazilToday(now());
    const from = addDays(tradeDate, -LOOKBACK_DAYS);
    const ahead = addDays(tradeDate, LOOKAHEAD_DAYS);
    const to = ahead < today ? ahead : today;
    if (to < from) return null;

    const lists = await Promise.all(PTAX_CURRENCIES.map((c) => bulletins(c, from, to)));
    const byCurrency = new Map(PTAX_CURRENCIES.map((c, i) => [c, new Map(lists[i].map((b) => [b.date, b]))]));
    const usdDates = [...byCurrency.get("USD")!.keys()].sort();
    const used = usdDates.filter((d) => d <= tradeDate).pop();
    if (!used) {
      // Nothing at all around an old date: the BCB has no PTAX for it.
      return usdDates.length === 0 && tradeDate <= addDays(today, -GIVE_UP_AFTER_DAYS) ? "unavailable" : null;
    }

    const buy: Record<string, string> = {};
    const sell: Record<string, string> = {};
    for (const c of PTAX_CURRENCIES) {
      const list = byCurrency.get(c)!;
      const b = list.get(used);
      if (b) {
        buy[c] = b.buy;
        sell[c] = b.sell;
      } else if (c === "USD" || list.size > 0 || used >= ALL_CURRENCIES_FROM) {
        return null; // should be there (a broken or partial answer): try again later
      }
      // else: an old date the BCB did not quote this currency on (the euro before 1999): left out
    }
    const provisional = !usdDates.some((d) => d >= tradeDate);
    return fxSnapshotSchema.parse({ date: used, provisional, buy, sell });
  }

  /** Snapshot for a trade date: cached when final, else asked to the BCB. */
  async function snapshotFor(tradeDate: string): Promise<FxSnapshot | null> {
    const cached = getCached.get(tradeDate) as { snapshot: string } | undefined;
    if (cached?.snapshot === UNAVAILABLE) return null; // the BCB has none for that date: do not ask again
    const fromCache = parseFxSnapshot(cached?.snapshot);
    if (fromCache && !fromCache.provisional) return fromCache;
    const fresh = await fetchSnapshot(tradeDate);
    const at = new Date(now()).toISOString();
    if (fresh === "unavailable") {
      putCached.run(tradeDate, UNAVAILABLE, at);
      return null;
    }
    if (fresh && !fresh.provisional) putCached.run(tradeDate, JSON.stringify(fresh), at);
    return fresh;
  }

  // Future dates wait for their day; dates the BCB has no PTAX for are skipped.
  const pendingDates = db.prepare(
    `SELECT DISTINCT date FROM transactions
     WHERE (fx IS NULL OR json_extract(fx, '$.provisional') = 1)
       AND date <= ?
       AND date NOT IN (SELECT trade_date FROM ptax_cache WHERE snapshot = ?)
     ORDER BY date DESC LIMIT ?`
  );
  const updatePending = db.prepare(
    `UPDATE transactions SET fx = ? WHERE date = ? AND (fx IS NULL OR json_extract(fx, '$.provisional') = 1)`
  );

  /**
   * Fills trades without PTAX (added offline, by an older version, restored)
   * and replaces provisional ones. Bounded per run; errors only postpone it.
   * Returns how many trade dates got a snapshot.
   */
  async function refreshPending(maxDates = 60): Promise<number> {
    const dates = (pendingDates.all(brazilToday(now()), UNAVAILABLE, maxDates) as Array<{ date: string }>).map((r) => r.date);
    let done = 0;
    for (const date of dates) {
      let snap: FxSnapshot | null;
      try {
        snap = await snapshotFor(date);
      } catch (error: any) {
        const status = Number(error?.status) || 0;
        if (status >= 400 && status < 500) {
          console.warn(`[ptax] BCB recusou a data ${date} (status ${status}); sigo com as outras`);
          continue; // a problem with this date only
        }
        console.warn(`[ptax] BCB indisponível (status ${status || "-"}); tento de novo depois`);
        break; // the BCB is down: the next run tries again
      }
      if (!snap) continue;
      updatePending.run(JSON.stringify(snap), date); // a database error here is not the BCB's: it propagates
      done++;
    }
    return done;
  }

  return { snapshotFor, refreshPending };
}

export type PtaxService = ReturnType<typeof createPtax>;
