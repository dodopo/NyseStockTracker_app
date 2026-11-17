/**
 * The dependency gate (scripts/audit-check.mjs): only listed, unexpired
 * exceptions pass; anything else of moderate or higher severity fails.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../scripts/audit-check.mjs");
let dir: string;

const report = (...advisories: Array<{ id: string; severity: string; pkg?: string }>) => ({
  vulnerabilities: Object.fromEntries(
    advisories.map((a) => [
      a.pkg ?? "pkg",
      { severity: a.severity, via: [{ source: 1, url: `https://github.com/advisories/${a.id}`, severity: a.severity, title: "t" }] },
    ])
  ),
});

function check(rep: object, allow: object[], today = "2026-11-17") {
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(rep));
  fs.writeFileSync(path.join(dir, "allow.json"), JSON.stringify(allow));
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, AUDIT_JSON_FILE: path.join(dir, "report.json"), AUDIT_ALLOWLIST: path.join(dir, "allow.json"), AUDIT_TODAY: today },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dam-audit-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("portão de dependências (audit-check)", () => {
  const allow = [{ id: "GHSA-aaaa", reason: "motivo", expires: "2026-12-17" }];

  it("sem alertas passa; alerta baixo não reprova", () => {
    expect(check({ vulnerabilities: {} }, []).code).toBe(0);
    expect(check(report({ id: "GHSA-low", severity: "low" }), []).code).toBe(0);
  });

  it("só a exceção listada e dentro da validade passa", () => {
    expect(check(report({ id: "GHSA-aaaa", severity: "high" }), allow).code).toBe(0);
  });

  it("qualquer outro alerta moderado ou pior reprova, mesmo junto da exceção", () => {
    const r = check(report({ id: "GHSA-aaaa", severity: "high", pkg: "a" }, { id: "GHSA-bbbb", severity: "moderate", pkg: "b" }), allow);
    expect(r.code).toBe(1);
    expect(r.out).toContain("GHSA-bbbb");
  });

  it("exceção vencida reprova sozinha", () => {
    const r = check(report({ id: "GHSA-aaaa", severity: "critical" }), allow, "2026-12-18");
    expect(r.code).toBe(1);
    expect(r.out).toContain("venceu em 2026-12-17");
  });

  it("relatório ilegível reprova", () => {
    fs.writeFileSync(path.join(dir, "allow.json"), "[]");
    fs.writeFileSync(path.join(dir, "report.json"), "not json");
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, AUDIT_JSON_FILE: path.join(dir, "report.json"), AUDIT_ALLOWLIST: path.join(dir, "allow.json") },
    });
    expect(r.status).toBe(1);
  });
});
