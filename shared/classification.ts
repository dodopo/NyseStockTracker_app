import type { AssetType } from "./assetTypes";

/**
 * How each asset (in each portfolio) is classified. Values are fixed here and
 * checked by the database; `null` means "Não definido" where allowed.
 */
export const LIQUIDITY = { liquid: "Líquido", illiquid: "Ilíquido" } as const;
export type Liquidity = keyof typeof LIQUIDITY;

/** Investment horizon, in calendar days (decided by the Fundador, 17/11/2026). */
export const HORIZON = {
  ultra_short: { label: "Curtíssimo", range: "até 30 dias" },
  short: { label: "Curto", range: "31 a 180 dias" },
  medium: { label: "Médio", range: "181 a 720 dias" },
  long: { label: "Longo", range: "721 a 1.800 dias" },
  ultra_long: { label: "Longuíssimo", range: "mais de 1.800 dias" },
} as const;
export type Horizon = keyof typeof HORIZON;

/** Upper bound (inclusive, calendar days) of each horizon, for dates such as a maturity. */
export const HORIZON_MAX_DAYS: Record<Exclude<Horizon, "ultra_long">, number> = {
  ultra_short: 30,
  short: 180,
  medium: 720,
  long: 1800,
};

/** Horizon of a number of calendar days (e.g. days to maturity). */
export function horizonOfDays(days: number): Horizon {
  if (days <= HORIZON_MAX_DAYS.ultra_short) return "ultra_short";
  if (days <= HORIZON_MAX_DAYS.short) return "short";
  if (days <= HORIZON_MAX_DAYS.medium) return "medium";
  if (days <= HORIZON_MAX_DAYS.long) return "long";
  return "ultra_long";
}

/** Seen from Brazil: onshore = held in Brazil, offshore = held abroad. */
export const JURISDICTION = { onshore: "Onshore", offshore: "Offshore" } as const;
export type Jurisdiction = keyof typeof JURISDICTION;

/**
 * Who holds the asset: an institution (bank, broker, exchange) or the owner
 * (autocustódia: own wallet, safe at home, bank safe deposit box...).
 */
export const CUSTODY = { institution: "Instituição", self: "Autocustódia" } as const;
export type Custody = keyof typeof CUSTODY;

export const NOT_DEFINED = "Não definido";

export const LIQUIDITY_IDS = Object.keys(LIQUIDITY) as Liquidity[];
export const HORIZON_IDS = Object.keys(HORIZON) as Horizon[];
export const JURISDICTION_IDS = Object.keys(JURISDICTION) as Jurisdiction[];
export const CUSTODY_IDS = Object.keys(CUSTODY) as Custody[];

export type Classification = {
  liquidity: Liquidity;
  horizon: Horizon | null;
  jurisdiction: Jurisdiction | null;
  custody: Custody | null;
};

/**
 * Starting values of a new asset. A US stock is held abroad, at a broker;
 * crypto depends on where it is kept (exchange abroad, in Brazil, own wallet),
 * so the user says. An illiquid asset is illiquid; cash is liquid and
 * short-term (decided by the Fundador, 18/11/2026), and where it is (bank,
 * home, abroad) only the user knows.
 */
export function defaultClassification(assetType: AssetType): Classification {
  return {
    liquidity: assetType === "illiquid" ? "illiquid" : "liquid",
    horizon: assetType === "cash" ? "ultra_short" : null,
    jurisdiction: assetType === "us_stock" ? "offshore" : null,
    custody: assetType === "us_stock" ? "institution" : null,
  };
}

export const liquidityLabel = (v: Liquidity | null | undefined) => (v ? LIQUIDITY[v] : NOT_DEFINED);
export const horizonLabel = (v: Horizon | null | undefined) => (v ? HORIZON[v].label : NOT_DEFINED);
export const jurisdictionLabel = (v: Jurisdiction | null | undefined) => (v ? JURISDICTION[v] : NOT_DEFINED);
export const custodyLabel = (v: Custody | null | undefined) => (v ? CUSTODY[v] : NOT_DEFINED);
