import React, { useId, useState } from "react";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { authApi } from "../../api/endpoints";
import { errorMessage } from "../../api/client";
import { Card, ErrorMessage, FieldLabel } from "../../components/ui";
import { finnhubKeySchema, firstIssue } from "../../../shared/schemas";
import type { AuthUser } from "../../types";

export function FinnhubOnboardingScreen({
  user,
  onSaved,
  onLogout,
}: {
  user: AuthUser;
  onSaved: (user: AuthUser) => void;
  onLogout: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyId = useId();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const check = finnhubKeySchema.safeParse({ apiKey });
    if (!check.success) {
      setError(firstIssue(check.error));
      return;
    }

    setSaving(true);
    try {
      const data = await authApi.saveFinnhubKey(check.data.apiKey);
      onSaved(data.user);
    } catch (err) {
      setError(errorMessage(err, "Erro ao salvar API key. Tente novamente."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-tv-bg text-tv-text flex items-center justify-center p-6">
      <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-8 flex flex-col justify-center">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-tv-accent rounded flex items-center justify-center text-white">
              <KeyRound size={26} />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-none">Configuração Inicial</h1>
              <div className="text-xs uppercase tracking-widest text-tv-text/40 font-bold mt-1">
                Finnhub API Key
              </div>
            </div>
          </div>

          <h2 className="text-3xl font-bold mb-4">
            Antes de começar, você precisa configurar sua chave da Finnhub
          </h2>

          <div className="space-y-4 text-tv-text/70 leading-relaxed">
            <p>
              A Finnhub fornece os dados de mercado usados pelo app para buscar ativos e atualizar preços
              em tempo real.
            </p>

            <div className="space-y-2">
              <div className="font-semibold text-tv-text">Passo a passo:</div>
              <ol className="list-decimal pl-5 space-y-2">
                <li>Acesse o site da Finnhub</li>
                <li>Crie uma conta gratuita</li>
                <li>Gere sua API key no dashboard</li>
                <li>Cole a chave no campo ao lado</li>
              </ol>
            </div>

            <a
              href="https://finnhub.io/register"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 text-tv-accent hover:underline"
            >
              Ir para Finnhub <ExternalLink size={16} />
            </a>

            <div className="text-xs text-tv-text/50">
              A chave fica guardada no servidor, vinculada só à sua conta, e não entra nos backups por padrão.
            </div>
          </div>
        </Card>

        <Card className="p-8">
          <form onSubmit={save} className="space-y-4">
            <div>
              <h3 className="text-xl font-bold mb-2">Olá, {user.displayName || user.email}</h3>
              <p className="text-sm text-tv-text/60">Cole sua Finnhub API key para liberar o uso do app.</p>
            </div>

            <div className="space-y-1">
              <FieldLabel htmlFor={keyId}>Finnhub API Key</FieldLabel>
              <input
                id={keyId}
                type="text"
                className="tv-input w-full"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Cole sua chave aqui"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>

            <button type="submit" disabled={saving} className="tv-btn w-full flex items-center justify-center gap-2">
              {saving ? <Loader2 size={18} className="animate-spin" /> : <KeyRound size={18} />}
              Salvar e continuar
            </button>

            <button
              type="button"
              onClick={onLogout}
              className="w-full py-3 rounded border border-white/10 text-tv-text/60 hover:bg-white/5 transition-all"
            >
              Sair
            </button>

            <ErrorMessage>{error}</ErrorMessage>
          </form>
        </Card>
      </div>
    </div>
  );
}
