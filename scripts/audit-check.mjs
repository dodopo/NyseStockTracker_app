#!/usr/bin/env node
/**
 * Security gate for dependencies (used by CI instead of a bare `npm audit`).
 * Fails on any advisory of severity moderate or higher, except the ones listed
 * in .audit-allowlist.json with a reason and an expiry date. An expired entry
 * fails again by itself, so an exception can never be forgotten.
 *
 *   node scripts/audit-check.mjs              # runs npm audit --json
 *   AUDIT_JSON_FILE=report.json node scripts/audit-check.mjs   # tests
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEVELS = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const today = (process.env.AUDIT_TODAY || new Date().toISOString().slice(0, 10)).slice(0, 10);

function readReport() {
  if (process.env.AUDIT_JSON_FILE) return fs.readFileSync(process.env.AUDIT_JSON_FILE, "utf8");
  try {
    return execFileSync("npm", ["audit", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    // npm audit exits non-zero when it finds something; the JSON is still on stdout.
    if (err && typeof err.stdout === "string" && err.stdout.trim()) return err.stdout;
    throw err;
  }
}

const allowFile = process.env.AUDIT_ALLOWLIST || path.join(root, ".audit-allowlist.json");
const allowlist = fs.existsSync(allowFile) ? JSON.parse(fs.readFileSync(allowFile, "utf8")) : [];
let report;
try {
  report = JSON.parse(readReport());
} catch (err) {
  console.error(`[audit] não consegui ler o relatório do npm audit: ${err?.message ?? err}`);
  process.exit(1);
}

// Every advisory (GHSA id) reported, with its package and severity.
const advisories = new Map();
for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== "object" || !via) continue;
    const id = String(via.url ?? "").split("/").pop() || String(via.source);
    advisories.set(id, { id, pkg, severity: via.severity, title: via.title ?? "", url: via.url ?? "" });
  }
}

const failures = [];
const used = new Set();
for (const adv of advisories.values()) {
  if ((LEVELS[adv.severity] ?? 4) < LEVELS.moderate) continue;
  const entry = allowlist.find((e) => e.id === adv.id);
  if (!entry) {
    failures.push(`${adv.id} (${adv.severity}) em ${adv.pkg}: ${adv.title} ${adv.url}`);
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? "") || entry.expires < today) {
    failures.push(`${adv.id} em ${adv.pkg}: a exceção venceu em ${entry.expires ?? "?"} (revise: ${entry.reason ?? ""})`);
  } else {
    used.add(entry.id);
    console.log(`[audit] exceção aceita até ${entry.expires}: ${adv.id} (${adv.severity}) em ${adv.pkg}. ${entry.reason}`);
  }
}
for (const e of allowlist) if (!used.has(e.id)) console.log(`[audit] aviso: exceção sem uso, pode sair da lista: ${e.id}`);

if (failures.length) {
  console.error(`[audit] REPROVADO:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`[audit] OK (${advisories.size} alerta(s) no relatório; nenhum sem exceção válida)`);
