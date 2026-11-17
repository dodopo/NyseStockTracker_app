import React, { useId, useState } from "react";
import { Loader2, TrendingUp } from "lucide-react";
import { authApi } from "../../api/endpoints";
import { errorMessage } from "../../api/client";
import { Card, ErrorMessage, FieldLabel, PasswordInput } from "../../components/ui";
import { cn } from "../../lib/utils";
import { firstIssue, registerSchema } from "../../../shared/schemas";
import { LIMITS } from "../../../shared/validation";
import type { AuthUser } from "../../types";
import { APP_NAME, APP_TAGLINE } from "../../../shared/brand";

export function AuthScreen({
  registrationEnabled,
  onAuthenticated,
}: {
  registrationEnabled: boolean;
  onAuthenticated: (user: AuthUser) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", displayName: "", password: "", confirmPassword: "" });
  const emailId = useId();
  const nameId = useId();

  const isRegister = mode === "register" && registrationEnabled;
  const set = (field: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [field]: value }));

  const switchMode = (next: "login" | "register") => {
    setMode(next);
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isRegister) {
      const check = registerSchema.safeParse(form);
      if (!check.success) {
        setError(firstIssue(check.error));
        return;
      }
    }

    setSubmitting(true);
    try {
      const data = isRegister
        ? await authApi.register(form)
        : await authApi.login(form.email, form.password);
      onAuthenticated(data.user);
    } catch (err) {
      setError(errorMessage(err, isRegister ? "Erro ao criar conta. Tente novamente." : "Erro ao fazer login. Tente novamente."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-tv-bg text-tv-text flex items-center justify-center p-6">
      <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-8 flex flex-col justify-center">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-tv-accent rounded flex items-center justify-center text-white">
              <TrendingUp size={26} />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-none">{APP_NAME}</h1>
              <div className="text-xs uppercase tracking-widest text-tv-text/40 font-bold mt-1">
                {APP_TAGLINE}
              </div>
            </div>
          </div>

          <h2 className="text-3xl font-bold mb-4">Controle sua carteira com acesso por usuário</h2>

          <div className="space-y-3 text-tv-text/70 leading-relaxed">
            <p>Cada usuário tem a sua carteira isolada e a sua própria chave da Finnhub.</p>
            <p>
              O acesso exige senha de pelo menos <strong>{LIMITS.passwordMin} caracteres</strong>. A sessão
              expira automaticamente.
            </p>
            {!registrationEnabled && <p>Novos cadastros estão desativados neste servidor.</p>}
          </div>
        </Card>

        <Card className="p-8">
          {registrationEnabled && (
            <div className="flex gap-2 p-1 bg-white/5 rounded mb-6" role="tablist">
              {(["login", "register"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => switchMode(m)}
                  className={cn(
                    "flex-1 py-2 rounded text-sm font-bold transition-all",
                    mode === m ? "bg-tv-accent text-white" : "text-tv-text/50"
                  )}
                >
                  {m === "login" ? "LOGIN" : "CRIAR CONTA"}
                </button>
              ))}
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            {isRegister && (
              <div className="space-y-1">
                <FieldLabel htmlFor={nameId}>Nome de exibição</FieldLabel>
                <input
                  id={nameId}
                  type="text"
                  className="tv-input w-full"
                  value={form.displayName}
                  onChange={(e) => set("displayName")(e.target.value)}
                  placeholder="Opcional"
                  maxLength={LIMITS.displayNameMax}
                  autoComplete="nickname"
                />
              </div>
            )}

            <div className="space-y-1">
              <FieldLabel htmlFor={emailId}>E-mail</FieldLabel>
              <input
                id={emailId}
                type="email"
                className="tv-input w-full"
                value={form.email}
                onChange={(e) => set("email")(e.target.value)}
                autoComplete={isRegister ? "email" : "username"}
                required
              />
            </div>

            <PasswordInput
              label="Senha"
              value={form.password}
              onChange={set("password")}
              autoComplete={isRegister ? "new-password" : "current-password"}
              minLength={isRegister ? LIMITS.passwordMin : undefined}
              placeholder={isRegister ? `Mínimo de ${LIMITS.passwordMin} caracteres` : undefined}
            />

            {isRegister && (
              <PasswordInput
                label="Confirmar senha"
                value={form.confirmPassword}
                onChange={set("confirmPassword")}
                autoComplete="new-password"
                minLength={LIMITS.passwordMin}
                placeholder="Repita a senha"
              />
            )}

            <button
              type="submit"
              disabled={submitting}
              className="tv-btn w-full flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 size={18} className="animate-spin" />}
              {isRegister ? "Criar conta" : "Entrar"}
            </button>

            <ErrorMessage>{error}</ErrorMessage>
          </form>
        </Card>
      </div>
    </div>
  );
}
