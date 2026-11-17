/**
 * Runs scripts/update.sh end to end against a fake service: a real git clone
 * of a local repository with two release tags, plus fake launchctl, curl and
 * npm on the PATH. The fake service "starts" whatever version is checked out,
 * and a broken version can also change the database when it starts, like a
 * migration would. Checks the happy path and that a failed update puts back
 * both the code and the database.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../scripts/update.sh");
let work: string;
let fake: string;
let app: string;
let data: string;

function write(file: string, content: string, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

const FAKES: Record<string, string> = {
  // start/restart: the service now runs the version checked out in the app folder
  launchctl: `#!/bin/sh
start() {
  v=$(sed -n 's/.*"version": "\\([^"]*\\)".*/\\1/p' "$APP/package.json")
  echo "$v" > "$FAKE/running"
  [ "$v" = "\${FAKE_MIGRATES:-}" ] && printf 'MIGRATED' >> "$DATA/portfolio.db"
  exit 0
}
case "$1" in
  kickstart) start ;;
  bootstrap) [ -n "\${FAKE_BOOTSTRAP_FAIL:-}" ] && exit 5; start ;;
  bootout) rm -f "$FAKE/running" ;;
esac`,
  curl: `#!/bin/sh
[ -f "$FAKE/running" ] || exit 7
v=$(cat "$FAKE/running")
[ "$v" = "\${FAKE_BROKEN:-}" ] && exit 7
printf '{"status":"ok","version":"%s"}' "$v"`,
  // "disk full" while staging the restore copy
  cp: `#!/bin/sh
for a in "$@"; do case "$a" in *.restaurando-*) [ -n "\${FAKE_CP_FAIL:-}" ] && exit 1 ;; esac; done
exec /bin/cp "$@"`,
  npm: `#!/bin/sh
case "$*" in
  *backup*)
    n=$(( $(cat "$FAKE/backups" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE/backups"
    mkdir -p "$DATA/backups"; cp "$DATA/portfolio.db" "$DATA/backups/portfolio-$n.db"
    echo "[backup] 2026-11-17T12:00:0\${n}Z ok $DATA/backups/portfolio-$n.db" ;;
  *db-path*) echo "$DATA/portfolio.db" ;;
  test) [ -n "\${FAKE_TEST_FAIL:-}" ] && exit 1; exit 0 ;;
  *) exit 0 ;;
esac`,
};

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "dam-update-"));
  fake = path.join(work, "fake");
  for (const [name, body] of Object.entries(FAKES)) write(path.join(fake, "bin", name), body + "\n", 0o755);

  const src = path.join(work, "src");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: src, stdio: "pipe" });
  write(path.join(src, ".gitignore"), ".env\n");
  write(path.join(src, "scripts/update.sh"), fs.readFileSync(SCRIPT, "utf8"), 0o755); // the published updater
  for (const v of ["0.12.0", "0.13.0"]) {
    write(path.join(src, "package.json"), `{\n  "name": "x",\n  "version": "${v}"\n}\n`);
    if (v === "0.12.0") git("init", "-q");
    git("add", ".");
    git("commit", "-qm", v);
    git("tag", `v${v}`);
  }
  app = path.join(work, "app");
  data = path.join(work, "data");
  execFileSync("git", ["clone", "-q", src, app]);
  execFileSync("git", ["checkout", "-q", "v0.12.0"], { cwd: app });
  write(path.join(app, ".env"), `PORT=3100\nDATA_DIR=${data}\n`);
  write(path.join(data, "portfolio.db"), "DB-v12");
  write(path.join(fake, "running"), "0.12.0\n");
});

afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

function update(tag: string, env: Record<string, string> = {}) {
  const r = spawnSync("sh", [SCRIPT, tag], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(fake, "bin")}:${process.env.PATH}`,
      FAKE: fake,
      APP: app,
      DATA: data,
      DAM_SERVICE_USER: os.userInfo().username,
      DAM_APP_DIR: app,
      DAM_LAUNCHD_LABEL: "local.test.app",
      DAM_HEALTH_TIMEOUT: "2",
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const running = () => fs.readFileSync(path.join(fake, "running"), "utf8").trim();
const checkedOut = () => execFileSync("git", ["describe", "--tags"], { cwd: app, encoding: "utf8" }).trim();

describe("atualização (scripts/update.sh)", () => {
  it("atualiza: dois backups (antes de instalar e antes de reiniciar) e a versão nova no ar", () => {
    const r = update("v0.13.0");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("OK: v0.13.0 no ar");
    expect(running()).toBe("0.13.0");
    expect(fs.readdirSync(path.join(data, "backups"))).toHaveLength(2);
  }, 30_000);

  it("versão nova não sobe depois de migrar o banco: volta o código E o banco; o banco da tentativa fica guardado", () => {
    const r = update("v0.13.0", { FAKE_BROKEN: "0.13.0", FAKE_MIGRATES: "0.13.0" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("atualização desfeita");
    expect(r.out).toContain("banco restaurado");
    expect(checkedOut()).toBe("v0.12.0");
    expect(running()).toBe("0.12.0");
    expect(fs.readFileSync(path.join(data, "portfolio.db"), "utf8")).toBe("DB-v12");
    const kept = fs.readdirSync(data).filter((f) => f.startsWith("portfolio.db.falhou-"));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(data, kept[0]), "utf8")).toBe("DB-v12MIGRATED");
  }, 30_000);

  it("testes da versão nova falham: o app nem é reiniciado e o banco não é tocado", () => {
    const r = update("v0.13.0", { FAKE_TEST_FAIL: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("não foi reiniciado");
    expect(checkedOut()).toBe("v0.12.0");
    expect(running()).toBe("0.12.0");
    expect(fs.readFileSync(path.join(data, "portfolio.db"), "utf8")).toBe("DB-v12");
  }, 30_000);
  it("cópia do backup falha (disco cheio) depois de migrar: banco intacto, serviço PARADO de propósito, com instrução", () => {
    const r = update("v0.13.0", { FAKE_BROKEN: "0.13.0", FAKE_MIGRATES: "0.13.0", FAKE_CP_FAIL: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("não consegui preparar a cópia");
    expect(r.out).toContain("ficou PARADO de propósito");
    expect(fs.readFileSync(path.join(data, "portfolio.db"), "utf8")).toBe("DB-v12MIGRATED");
    expect(fs.readdirSync(data).filter((f) => f.includes("restaurando") || f.includes("falhou"))).toEqual([]);
    expect(fs.existsSync(path.join(fake, "running"))).toBe(false);
  }, 60_000);

  it("cópia falha mas o banco não mudou (a versão nova nem migrou): a anterior volta normalmente", () => {
    const r = update("v0.13.0", { FAKE_BROKEN: "0.13.0", FAKE_CP_FAIL: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("o banco não mudou desde o backup");
    expect(r.out).toContain("atualização desfeita");
    expect(running()).toBe("0.12.0");
    expect(fs.readFileSync(path.join(data, "portfolio.db"), "utf8")).toBe("DB-v12");
  }, 60_000);

  it("serviço não liga de volta: avisa com o comando, nunca termina calado", () => {
    const r = update("v0.13.0", { FAKE_BROKEN: "0.13.0", FAKE_MIGRATES: "0.13.0", FAKE_BOOTSTRAP_FAIL: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("banco restaurado");
    expect(r.out).toContain("não ligou. Rode: sudo launchctl bootstrap");
    expect(fs.readFileSync(path.join(data, "portfolio.db"), "utf8")).toBe("DB-v12");
  }, 60_000);

  it("comando de atualização diferente do publicado na versão: recusa antes de qualquer coisa", () => {
    const src = path.join(work, "src");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: src, stdio: "pipe" });
    write(path.join(src, "scripts/update.sh"), "#!/bin/sh\n# newer updater\n", 0o755);
    write(path.join(src, "package.json"), `{\n  "name": "x",\n  "version": "0.14.0"\n}\n`);
    git("commit", "-qam", "0.14.0");
    git("tag", "v0.14.0");
    const r = update("v0.14.0");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("é diferente deste");
    expect(checkedOut()).toBe("v0.12.0");
    expect(running()).toBe("0.12.0");
    expect(fs.existsSync(path.join(data, "backups"))).toBe(false);
  }, 30_000);
});
