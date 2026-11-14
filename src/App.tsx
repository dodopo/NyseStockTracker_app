import { useCallback, useEffect, useState } from "react";
import { History, LayoutDashboard, LogOut, RefreshCw, Settings, TrendingUp } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { FullScreenSpinner, TabButton } from "./components/ui";
import { AuthScreen } from "./features/auth/AuthScreen";
import { FinnhubOnboardingScreen } from "./features/onboarding/FinnhubOnboardingScreen";
import { SettingsModal } from "./features/settings/SettingsModal";
import { ActionsDashboard } from "./features/actions/ActionsDashboard";
import { ConsolidatedDashboard } from "./features/consolidated/ConsolidatedDashboard";
import { useAuth } from "./hooks/useAuth";
import { useHashRoute } from "./hooks/useHashRoute";
import { usePortfolio } from "./hooks/usePortfolio";
import { cn } from "./lib/utils";
import type { AuthUser, ConsolidationMode } from "./types";

declare const __APP_VERSION__: string;
const APP_VERSION = __APP_VERSION__;

export default function App() {
  const auth = useAuth();
  const user = auth.user;
  const portfolio = usePortfolio(user?.hasFinnhubKey ? user.id : null);
  const { route, navigate } = useHashRoute();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<ConsolidationMode>("SEPARATED");

  const { stocks, ready: portfolioReady } = portfolio;
  const selectedTicker = route.tab === "acoes" ? route.ticker : null;

  // On the assets tab, always show a valid asset: the one in the URL, or the first one.
  useEffect(() => {
    if (route.tab !== "acoes" || !portfolioReady) return;
    const exists = stocks.some((s) => s.ticker === route.ticker);
    if (!exists) {
      navigate({ tab: "acoes", ticker: stocks[0]?.ticker ?? null }, { replace: true });
    }
  }, [route, stocks, portfolioReady, navigate]);

  const openAsset = useCallback(
    (ticker: string | null) => navigate({ tab: "acoes", ticker }),
    [navigate]
  );

  const logout = useCallback(async () => {
    setSettingsOpen(false);
    await auth.logout();
    navigate({ tab: "consolidado" }, { replace: true });
  }, [auth, navigate]);

  const onRestored = useCallback(
    async (restoredUser: AuthUser) => {
      auth.setUser(restoredUser);
      await portfolio.reload();
    },
    [auth, portfolio]
  );

  const onSignedOut = useCallback(() => {
    setSettingsOpen(false);
    auth.setUser(null);
    navigate({ tab: "consolidado" }, { replace: true });
  }, [auth, navigate]);

  if (auth.loading) return <FullScreenSpinner />;

  if (!user) {
    return <AuthScreen registrationEnabled={auth.registrationEnabled} onAuthenticated={auth.setUser} />;
  }

  if (!user.hasFinnhubKey) {
    return <FinnhubOnboardingScreen user={user} onSaved={auth.setUser} onLogout={logout} />;
  }

  if (!portfolioReady) return <FullScreenSpinner />;

  return (
    <div className="min-h-screen bg-tv-bg text-tv-text flex flex-col">
      <SettingsModal
        open={settingsOpen}
        user={user}
        onClose={() => setSettingsOpen(false)}
        onRestored={onRestored}
        onUserChanged={auth.setUser}
        onSignedOut={onSignedOut}
      />

      <header className="tv-card border-x-0 border-t-0 rounded-none px-6 py-4 flex justify-between items-center sticky top-0 z-50 backdrop-blur-md bg-tv-bg/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-tv-accent rounded flex items-center justify-center text-white">
            <TrendingUp size={24} />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-none">NYSE Tracker</h1>
            <span className="text-[10px] uppercase tracking-widest text-tv-text/40 font-bold">
              Portfolio + Trades (PM)
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right hidden md:block">
            <div className="text-sm font-semibold">{user.displayName || user.email}</div>
            <div className="text-[10px] uppercase tracking-widest text-tv-text/40 font-bold">Sessão protegida</div>
          </div>

          <button
            type="button"
            onClick={() => void portfolio.refreshPrices()}
            className={cn(
              "p-2 rounded hover:bg-white/5 transition-all text-tv-text/60",
              portfolio.refreshing && "animate-spin text-tv-accent"
            )}
            title="Atualizar preços"
            aria-label="Atualizar preços"
          >
            <RefreshCw size={20} />
          </button>

          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded hover:bg-white/5 transition-all text-tv-text/60 hover:text-tv-accent"
            title="Settings"
            aria-label="Configurações"
          >
            <Settings size={20} />
          </button>

          <button
            type="button"
            onClick={() => void logout()}
            className="p-2 rounded hover:bg-white/5 transition-all text-tv-text/60 hover:text-tv-down"
            title="Sair"
            aria-label="Sair"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <nav className="px-6 border-b border-tv-border flex overflow-x-auto no-scrollbar" aria-label="Seções">
        <TabButton
          active={route.tab === "consolidado"}
          onClick={() => navigate({ tab: "consolidado" })}
          icon={LayoutDashboard}
          label="CONSOLIDADO"
        />
        <TabButton
          active={route.tab === "acoes"}
          onClick={() => openAsset(selectedTicker)}
          icon={History}
          label="AÇÕES"
        />
      </nav>

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        <AnimatePresence mode="wait">
          <motion.div
            key={route.tab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {route.tab === "acoes" ? (
              <ActionsDashboard
                portfolio={portfolio}
                selectedTicker={selectedTicker}
                onSelect={openAsset}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            ) : (
              <ConsolidatedDashboard
                portfolio={portfolio}
                mode={mode}
                onModeChange={setMode}
                onOpenAsset={openAsset}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="p-6 text-center text-[10px] text-tv-text/20 uppercase tracking-widest font-bold">
        NYSE Portfolio Tracker &copy; {new Date().getFullYear()} · v{APP_VERSION}
      </footer>
    </div>
  );
}
