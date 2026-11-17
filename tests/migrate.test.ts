/**
 * Runs scripts/migrate-from-nysetracker.sh end to end against a fake machine:
 * a temporary root folder plus fake dscl, launchctl, sudo, curl, npm and
 * sqlite3 on the PATH. The fake launchd keeps the "loaded" services in a
 * folder and the fake /api/health answers with the version of whichever app
 * service is loaded, so the switch and every rollback path are exercised.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../scripts/migrate-from-nysetracker.sh");
const TEMPLATES = path.resolve(__dirname, "../deploy/macos");
const UPDATE_SH = path.resolve(__dirname, "../scripts/update.sh");

let work: string;
let root: string;
let fake: string;
let repo: string;
let srcDir: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: srcDir, stdio: "pipe" });

/** Replaces the v0.12.0 tag of the published repository with a changed tree. */
function retag(change: () => void) {
  change();
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "changed");
  git("tag", "-f", "v0.12.0");
  git("push", "-q", "--force", repo, "refs/tags/v0.12.0");
}

function write(file: string, content: string, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

const FAKES: Record<string, string> = {
  id: `#!/bin/sh
[ "$1" = "-u" ] && { echo 0; exit 0; }
exec /usr/bin/id "$@"`,
  // sudo -u USER -H cmd... -> runs cmd as the current user
  sudo: `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -u) shift 2 ;; -H) shift ;; *) break ;; esac; done
exec "$@"`,
  chown: `#!/bin/sh
exit 0`,
  dscl: `#!/bin/sh
db="$FAKE/dscl"; mkdir -p "$db"
shift # "."
case "$1" in
  -read) f="$db/$(basename "$2")"; [ -f "$f" ] || exit 56; echo "UniqueID: $(cat "$f")" ;;
  -list) for f in "$db"/*; do [ -f "$f" ] && echo "$(basename "$f") $(cat "$f")"; done ;;
  -create) f="$db/$(basename "$2")"; [ -f "$f" ] || : > "$f"; [ "\${3:-}" = UniqueID ] && echo "$4" > "$f"; exit 0 ;;
esac`,
  launchctl: `#!/bin/sh
st="$FAKE/loaded"; mkdir -p "$st"
case "$1" in
  print) [ -e "$st/\${2#system/}" ] ;;
  bootout) [ "\${2#system/}" = "\${FAKE_BOOTOUT_FAIL:-}" ] && exit 9; [ -e "$st/\${2#system/}" ] || exit 3; rm "$st/\${2#system/}" ;;
  bootstrap)
    label="$(sed -n 's|.*<key>Label</key><string>\\([^<]*\\)</string>.*|\\1|p' "$3")"
    [ -n "$label" ] || exit 5
    [ "$label" = "\${FAKE_BOOTSTRAP_FAIL:-}" ] && exit 5
    touch "$st/$label" ;;
esac`,
  curl: `#!/bin/sh
st="$FAKE/loaded"
if [ -e "$st/local.dodopoam.app" ]; then
  [ -n "\${FAKE_NEW_UNHEALTHY:-}" ] && exit 7
  n=$(( $(cat "$FAKE/calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE/calls"
  [ "$n" -le "\${FAKE_NEW_HEALTHY_AFTER:-0}" ] && exit 7
  printf '{"status":"ok","version":"%s"}' "$FAKE_NEW_VERSION"
elif [ -e "$st/local.nysetracker.app" ]; then
  printf '{"status":"ok","version":"0.11.0"}'
else
  exit 7
fi`,
  npm: `#!/bin/sh
case "$*" in
  *backup*) mkdir -p ../data/backups && echo snap > ../data/backups/portfolio-test.db && echo "backup: ../data/backups/portfolio-test.db" ;;
  test) [ -n "\${FAKE_NPM_TEST_FAIL:-}" ] && exit 1; exit 0 ;;
  *) exit 0 ;;
esac`,
  lsof: `#!/bin/sh
exit 1`,
  sqlite3: `#!/bin/sh
if [ -n "\${FAKE_SQLITE_BAD:-}" ]; then echo "*** in database main ***"; else echo ok; fi`,
};

function setup() {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "dam-migrate-"));
  root = path.join(work, "root");
  fake = path.join(work, "fake");
  const bin = path.join(fake, "bin");
  for (const [name, body] of Object.entries(FAKES)) write(path.join(bin, name), body + "\n", 0o755);

  // published repository with the v0.12.0 tag
  const src = path.join(work, "src");
  for (const f of ["local.dodopoam.app.plist", "local.dodopoam.backup.plist"]) {
    write(path.join(src, "deploy/macos", f), fs.readFileSync(path.join(TEMPLATES, f), "utf8"));
  }
  write(path.join(src, "scripts/update.sh"), fs.readFileSync(UPDATE_SH, "utf8"), 0o755);
  write(path.join(src, "package.json"), '{\n  "name": "dodopo-asset-manager",\n  "version": "0.12.0",\n  "private": true\n}\n');
  srcDir = src;
  git("init", "-q");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v0.12.0");
  git("tag", "v0.12.0");
  repo = path.join(work, "repo.git");
  execFileSync("git", ["clone", "-q", "--bare", src, repo]);

  // old install, running
  const old = path.join(root, "Users/nysetracker");
  write(path.join(old, "app/.env"), "HOST=127.0.0.1\nPORT=3100\nDATA_DIR=/Users/nysetracker/data\nBACKUP_DIR=/Users/nysetracker/data/backups\n");
  write(path.join(old, "data/portfolio.db"), "SQLite format 3\u0000 main");
  write(path.join(old, "data/portfolio.db-wal"), "wal bytes");
  for (const f of ["app", "backup"]) {
    write(
      path.join(root, `Library/LaunchDaemons/local.nysetracker.${f}.plist`),
      `<plist><dict>\n\t<key>Label</key><string>local.nysetracker.${f}</string>\n</dict></plist>\n`
    );
    write(path.join(fake, "loaded", `local.nysetracker.${f}`), "");
  }
  write(path.join(root, "usr/local/sbin/nysetracker-update"), "#!/bin/sh\n", 0o755);
  write(path.join(fake, "dscl/nysetracker"), "509\n");
  write(path.join(fake, "dscl/finfamilia"), "507\n");
}

function scriptEnv(env: Record<string, string>) {
  return {
    ...process.env,
    PATH: `${path.join(fake, "bin")}:${process.env.PATH}`,
    FAKE: fake,
    FAKE_NEW_VERSION: "0.12.0",
    DAM_MIGRATE_ROOT: root,
    DAM_REPO_URL: repo,
    DAM_HEALTH_TIMEOUT: "2",
    DAM_POLL: "1",
    ...env,
  };
}

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", env: scriptEnv(env) });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Runs the migration and sends `signal` once the new services are being started. */
function runWithSignal(signal: NodeJS.Signals, env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn("sh", [SCRIPT, "v0.12.0"], { env: scriptEnv(env) });
    let out = "";
    let sent = false;
    const onData = (d: Buffer) => {
      out += d.toString();
      if (!sent && out.includes("ligando os serviços novos")) {
        sent = true;
        setTimeout(() => child.kill(signal), 300);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => resolve({ code, out }));
  });
}

const exists = (p: string) => fs.existsSync(path.join(root, p));
const loaded = () => fs.readdirSync(path.join(fake, "loaded")).sort();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

/** The old install is exactly as before: services in place and running, command present. */
function expectOldIntact() {
  expect(loaded()).toEqual(["local.nysetracker.app", "local.nysetracker.backup"]);
  expect(exists("Library/LaunchDaemons/local.nysetracker.app.plist")).toBe(true);
  expect(exists("Library/LaunchDaemons/local.nysetracker.backup.plist")).toBe(true);
  expect(exists("Library/LaunchDaemons/local.dodopoam.app.plist")).toBe(false);
  expect(exists("usr/local/sbin/nysetracker-update")).toBe(true);
  expect(exists("usr/local/sbin/dodopoam-update")).toBe(false);
  expect(read("Users/nysetracker/data/portfolio.db")).toBe("SQLite format 3\u0000 main");
}

describe("migração nysetracker -> dodopoam", { timeout: 60_000 }, () => {
  beforeEach(setup);
  afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

  it("simulação só lê: nada muda", () => {
    const r = run(["--dry-run", "v0.12.0"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("SIMULAÇÃO");
    expect(r.out).toContain("será criado (UID 510)");
    expectOldIntact();
    expect(exists("Users/dodopoam")).toBe(false);
    expect(fs.existsSync(path.join(fake, "dscl/dodopoam"))).toBe(false);
  });

  it("migra: usuário novo, dados idênticos, serviços trocados, antigo guardado e intacto", () => {
    const r = run(["v0.12.0"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("OK: v0.12.0 no ar como dodopoam");

    expect(fs.readFileSync(path.join(fake, "dscl/dodopoam"), "utf8").trim()).toBe("510");
    expect(read("Users/dodopoam/data/portfolio.db")).toBe(read("Users/nysetracker/data/portfolio.db"));
    expect(read("Users/dodopoam/data/portfolio.db-wal")).toBe("wal bytes");
    expect(exists("Users/dodopoam/data/backups/portfolio-test.db")).toBe(true);
    expect(read("Users/dodopoam/app/.env")).toContain("DATA_DIR=/Users/dodopoam/data");
    expect(read("Users/dodopoam/app/.env")).not.toContain("nysetracker");

    expect(loaded()).toEqual(["local.dodopoam.app", "local.dodopoam.backup"]);
    const plist = read("Library/LaunchDaemons/local.dodopoam.app.plist");
    expect(plist).toContain("<string>dodopoam</string>");
    expect(plist).toContain("/Users/dodopoam/app");
    expect(plist).not.toContain("__");
    expect(exists("Library/LaunchDaemons/local.nysetracker.app.plist")).toBe(false);
    expect(exists("usr/local/share/dodopoam-migration/local.nysetracker.app.plist")).toBe(true);
    expect(exists("usr/local/share/dodopoam-migration/nysetracker-update")).toBe(true);
    expect(exists("usr/local/sbin/nysetracker-update")).toBe(false);
    expect(read("usr/local/sbin/dodopoam-update")).toBe(fs.readFileSync(UPDATE_SH, "utf8"));
    // the old install is not deleted
    expect(read("Users/nysetracker/data/portfolio.db")).toBe("SQLite format 3\u0000 main");
  });

  it("não migra duas vezes; --rollback volta para a instalação antiga", () => {
    expect(run(["v0.12.0"]).code).toBe(0);
    const again = run(["v0.12.0"]);
    expect(again.code).not.toBe(0);
    expect(again.out).toContain("já foi feita");

    const back = run(["--rollback"]);
    expect(back.code, back.out).toBe(0);
    expectOldIntact();
    expect(fs.readdirSync(path.join(root, "usr/local/share")).some((d) => d.startsWith("dodopoam-migration.desfeita-"))).toBe(true);
  });

  it("versão nova não responde: desfaz sozinho e o antigo volta", () => {
    const r = run(["v0.12.0"], { FAKE_NEW_UNHEALTHY: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("migração desfeita");
    expectOldIntact();
  });

  it("banco copiado sem integridade: desfaz sozinho", () => {
    const r = run(["v0.12.0"], { FAKE_SQLITE_BAD: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("integridade");
    expectOldIntact();
  });

  it("serviço novo não liga: desfaz sozinho", () => {
    const r = run(["v0.12.0"], { FAKE_BOOTSTRAP_FAIL: "local.dodopoam.app" });
    expect(r.code).not.toBe(0);
    expectOldIntact();
  });

  it("testes da versão nova falham: o app antigo nem é parado", () => {
    const r = run(["v0.12.0"], { FAKE_NPM_TEST_FAIL: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("segue no ar");
    expectOldIntact();
    expect(exists("usr/local/share/dodopoam-migration")).toBe(false);
  });

  it("recusa antes de mexer em qualquer coisa", () => {
    write(path.join(fake, "dscl/outro"), "510\n");
    expect(run(["v0.12.0"]).out).toContain("UID 510 já é do usuário outro");
    fs.rmSync(path.join(fake, "dscl/outro"));

    expect(run(["v9.9.9"]).out).toContain("não foi encontrada");
    expect(run(["latest"]).out).toContain("formato vX.Y.Z");

    fs.rmSync(path.join(fake, "loaded/local.nysetracker.app"));
    expect(run(["v0.12.0"]).out).toContain("não está carregado");
    fs.writeFileSync(path.join(fake, "loaded/local.nysetracker.app"), "");

    expect(run(["--rollback"]).out).toContain("não há migração para desfazer");
    expectOldIntact();
    expect(exists("Users/dodopoam")).toBe(false);
  });
  it("recusa DATA_DIR diferente do esperado", () => {
    write(path.join(root, "Users/nysetracker/app/.env"), "PORT=3100\nDATA_DIR=/Users/nysetracker/app/data\n");
    const r = run(["v0.12.0"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("só migra DATA_DIR=/Users/nysetracker/data");
    expectOldIntact();
  });

  it("tag com versão diferente no package.json: recusa com o antigo no ar", () => {
    retag(() => write(path.join(srcDir, "package.json"), '{\n  "version": "0.11.9"\n}\n'));
    const r = run(["v0.12.0"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("declara a versão '0.11.9'");
    expectOldIntact();
  });

  it("modelo de serviço adulterado (UserName root): desfaz sem instalar", () => {
    retag(() => {
      const f = path.join(srcDir, "deploy/macos/local.dodopoam.app.plist");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("<string>__SERVICE_USER__</string>", "<string>root</string>"));
    });
    const r = run(["v0.12.0"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("não passou na conferência");
    expectOldIntact();
  });

  it("depois de um desfazer automático, tentar de novo funciona e guarda os restos ao lado", () => {
    expect(run(["v0.12.0"], { FAKE_NEW_UNHEALTHY: "1" }).code).not.toBe(0);
    const r = run(["v0.12.0"]);
    expect(r.code, r.out).toBe(0);
    const left = fs.readdirSync(path.join(root, "Users/dodopoam")).filter((d) => d.startsWith("data.tentativa-"));
    expect(left).toHaveLength(1);
    expect(loaded()).toEqual(["local.dodopoam.app", "local.dodopoam.backup"]);
  });

  it("Ctrl+C/TERM durante a troca: desfaz e o antigo volta", async () => {
    const r = await runWithSignal("SIGTERM", { FAKE_NEW_UNHEALTHY: "1", DAM_HEALTH_TIMEOUT: "20" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("interrompido");
    expectOldIntact();
  });

  it("queda da conexão (HUP) durante a troca não interrompe: termina a migração", async () => {
    const r = await runWithSignal("SIGHUP", { FAKE_NEW_HEALTHY_AFTER: "3", DAM_HEALTH_TIMEOUT: "20" });
    expect(r.code, r.out).toBe(0);
    expect(loaded()).toEqual(["local.dodopoam.app", "local.dodopoam.backup"]);
    expect(read("usr/local/share/dodopoam-migration/migrate.log")).toContain("OK: v0.12.0 no ar");
  });

  it("se o serviço novo não para no desfazer, avisa e não finge sucesso", () => {
    const r = run(["v0.12.0"], { FAKE_NEW_UNHEALTHY: "1", FAKE_BOOTOUT_FAIL: "local.dodopoam.app" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("não consegui parar local.dodopoam.app");
    expect(r.out).not.toContain("de volta no ar");
    // old services are back on disk (a reboot recovers) and the parked state is kept for --rollback
    expect(exists("Library/LaunchDaemons/local.nysetracker.app.plist")).toBe(true);
    expect(exists("usr/local/share/dodopoam-migration/state")).toBe(true);
  });
});
