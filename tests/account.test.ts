import { describe, expect, it } from "vitest";
import request from "supertest";
import { loadConfig } from "../server/config";
import { openDatabase } from "../server/db";
import { createApp, type FinnhubFetch } from "../server/app";

const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "another-long-password";
const GOOD_KEY = "goodkey1234567890";

/** Fake Finnhub: only GOOD_KEY works. */
const fakeFinnhub: FinnhubFetch = async (url) => {
  if (!url.includes(`token=${GOOD_KEY}`)) throw new Error("Finnhub HTTP 401");
  return { c: 100, d: 1, dp: 1, h: 101, l: 99, o: 99, pc: 99 };
};

function setup() {
  const db = openDatabase(":memory:");
  const app = createApp(db, loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
    finnhubFetch: fakeFinnhub,
  });
  return { db, app };
}

/** Registers and returns the session cookie (to simulate several devices). */
async function registerCookie(app: ReturnType<typeof createApp>, email = "ana@example.com") {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email, password: PASSWORD, confirmPassword: PASSWORD });
  expect(res.status).toBe(201);
  return String(res.headers["set-cookie"]).split(";")[0];
}

async function loginCookie(app: ReturnType<typeof createApp>, email: string, password: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  return { status: res.status, cookie: String(res.headers["set-cookie"] ?? "").split(";")[0] };
}

describe("trocar senha", () => {
  it("exige a senha atual, troca e derruba os outros aparelhos (mantém o atual)", async () => {
    const { app } = setup();
    const laptop = await registerCookie(app);
    const phone = (await loginCookie(app, "ana@example.com", PASSWORD)).cookie;

    const wrong = await request(app)
      .post("/api/account/password")
      .set("Cookie", laptop)
      .send({ currentPassword: "not-my-password", newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(wrong.status).toBe(401);

    const ok = await request(app)
      .post("/api/account/password")
      .set("Cookie", laptop)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(ok.status).toBe(200);

    expect((await request(app).get("/api/stocks").set("Cookie", laptop)).status).toBe(200);
    expect((await request(app).get("/api/stocks").set("Cookie", phone)).status).toBe(401);

    expect((await loginCookie(app, "ana@example.com", PASSWORD)).status).toBe(401);
    expect((await loginCookie(app, "ana@example.com", NEW_PASSWORD)).status).toBe(200);
  });

  it("recusa senha curta, confirmação diferente e senha igual à atual", async () => {
    const { app } = setup();
    const cookie = await registerCookie(app);
    const post = (body: object) => request(app).post("/api/account/password").set("Cookie", cookie).send(body);

    expect((await post({ currentPassword: PASSWORD, newPassword: "short", confirmPassword: "short" })).status).toBe(400);
    expect((await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: "different-password!" })).status).toBe(400);
    expect((await post({ currentPassword: PASSWORD, newPassword: PASSWORD, confirmPassword: PASSWORD })).status).toBe(400);
  });
});

describe("trocar e-mail", () => {
  it("exige a senha atual e passa a logar com o e-mail novo", async () => {
    const { app } = setup();
    const cookie = await registerCookie(app);

    const wrong = await request(app)
      .post("/api/account/email")
      .set("Cookie", cookie)
      .send({ currentPassword: "not-my-password", newEmail: "nova@example.com" });
    expect(wrong.status).toBe(401);

    const ok = await request(app)
      .post("/api/account/email")
      .set("Cookie", cookie)
      .send({ currentPassword: PASSWORD, newEmail: " Nova@Example.com " });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe("nova@example.com");

    expect((await loginCookie(app, "ana@example.com", PASSWORD)).status).toBe(401);
    expect((await loginCookie(app, "nova@example.com", PASSWORD)).status).toBe(200);
  });

  it("recusa e-mail já usado por outra conta e e-mail inválido", async () => {
    const { app } = setup();
    await registerCookie(app, "bob@example.com");
    const cookie = await registerCookie(app, "ana@example.com");
    const post = (newEmail: string) =>
      request(app).post("/api/account/email").set("Cookie", cookie).send({ currentPassword: PASSWORD, newEmail });

    expect((await post("bob@example.com")).status).toBe(400);
    expect((await post("not-an-email")).status).toBe(400);
  });
});

describe("restaurar backup depois de trocar o e-mail", () => {
  it("pede a senha (409); senha errada 401; senha certa restaura", async () => {
    const { app } = setup();
    const cookie = await registerCookie(app);
    const backup = {
      user: { email: "antigo@example.com" },
      stocks: [{ ticker: "AAPL", name: "Apple" }],
      transactions: [{ ticker: "AAPL", type: "BUY", shares: "1", price: "100", date: "2026-01-02" }],
    };
    const post = (body: object) => request(app).post("/api/import").set("Cookie", cookie).send(body);

    const ask = await post(backup);
    expect(ask.status).toBe(409);
    expect(ask.body.code).toBe("BACKUP_EMAIL_MISMATCH");

    expect((await post({ ...backup, confirmPassword: "not-my-password" })).status).toBe(401);

    const ok = await post({ ...backup, confirmPassword: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.stocks.map((s: { ticker: string }) => s.ticker)).toEqual(["AAPL"]);
  });
});

describe("trocar a chave da Finnhub", () => {
  it("testa a chave antes de salvar: chave recusada não substitui a que funciona", async () => {
    const { app } = setup();
    const cookie = await registerCookie(app);
    const save = (apiKey: string) =>
      request(app).post("/api/auth/finnhub-key").set("Cookie", cookie).send({ apiKey });

    expect((await save(GOOD_KEY)).status).toBe(200);
    const bad = await save("badkey1234567890");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/recusou/);

    const account = await request(app).get("/api/account").set("Cookie", cookie);
    expect(account.body.finnhubKeyHint).toBe("••••7890");
    expect(JSON.stringify(account.body)).not.toContain(GOOD_KEY);
  });
});

describe("sair de todos os aparelhos e informações da conta", () => {
  it("encerra todas as sessões, inclusive a atual", async () => {
    const { app } = setup();
    const laptop = await registerCookie(app);
    const phone = (await loginCookie(app, "ana@example.com", PASSWORD)).cookie;

    const info = await request(app).get("/api/account").set("Cookie", laptop);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ email: "ana@example.com", activeSessions: 2, finnhubKeyHint: null });
    expect(info.body.appVersion).toMatch(/^\d+\.\d+\.\d+$/);

    expect((await request(app).post("/api/account/logout-all").set("Cookie", laptop)).status).toBe(200);
    expect((await request(app).get("/api/stocks").set("Cookie", laptop)).status).toBe(401);
    expect((await request(app).get("/api/stocks").set("Cookie", phone)).status).toBe(401);
  });

  it("sem sessão, nenhuma rota de conta responde", async () => {
    const { app } = setup();
    expect((await request(app).get("/api/account")).status).toBe(401);
    expect((await request(app).post("/api/account/password").send({})).status).toBe(401);
    expect((await request(app).post("/api/account/email").send({})).status).toBe(401);
    expect((await request(app).post("/api/account/logout-all")).status).toBe(401);
  });
});
