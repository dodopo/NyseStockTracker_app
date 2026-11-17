import { useCallback, useEffect, useState } from "react";
import { LayoutDashboard, LogOut, Plus, RefreshCw, Settings, TrendingUp } from "lucide-react";
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
import { APP_NAME, APP_SHORT_NAME, APP_TAGLINE } from "../shared/brand";

declare const __APP_VERSION__: string;
const APP_VERSION = __APP_VERSION__;

export default function App() {
  const auth = useAuth();
  const user = auth.user;
  const portfolio = usePortfolio(user?.hasFinnhubKey ? user.id : null);
  const { route, navigate } = useHashRoute();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<ConsolidationMode>("SEPARATED");

  const { stocks, tabs, ready: portfolioReady } = portfolio;
  const activeTab = route.tab === "aba" ? tabs.find((t) => t.id === route.tabId) ?? null : null;
  const selectedTicker = route.tab === "aba" ? route.ticker : null;

  // On a tab, always show a valid tab and asset: the ones in the URL, or sensible defaults.
  // Also resolves legacy links (#/acoes/AAPL) to the asset's tab.
  useEffect(() => {
    if (route.tab !== "aba" || !portfolioReady || tabs.length === 0) return;
    const fromTicker = route.ticker ? stocks.find((s) => s.ticker === route.ticker) : undefined;
    const tab =
      tabs.find((t) => t.id === route.tabId) ??
      tabs.find((t) => t.id === fromTicker?.tab_id) ??
      tabs[0];
    const inTab = stocks.filter((s) => s.tab_id === tab.id);
    const ticker = inTab.some((s) => s.ticker === route.ticker) ? route.ticker : inTab[0]?.ticker ?? null;
    if (tab.id !== route.tabId || ticker !== route.ticker) {
      navigate({ tab: "aba", tabId: tab.id, ticker }, { replace: true });
    }
  }, [route, tabs, stocks, portfolioReady, navigate]);

  const openTab = useCallback((tabId: number) => navigate({ tab: "aba", tabId, ticker: null }), [navigate]);

  const openAsset = useCallback(
    (ticker: string | null, tabId?: number | null) =>
      navigate({ tab: "aba", tabId: tabId ?? (route.tab === "aba" ? route.tabId : null), ticker }),
    [navigate, route]
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
        portfolio={portfolio}
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
            <h1 className="text-lg font-bold leading-none">
              <span className="sm:hidden">{APP_SHORT_NAME}</span>
              <span className="hidden sm:inline">{APP_NAME}</span>
            </h1>
            <span className="text-[10px] uppercase tracking-widest text-tv-text/40 font-bold whitespace-nowrap">
              {APP_TAGLINE}
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

      <nav className="px-2 sm:px-6 border-b border-tv-border flex overflow-x-auto no-scrollbar" aria-label="Seções">
        <TabButton
          active={route.tab === "consolidado"}
          onClick={() => navigate({ tab: "consolidado" })}
          icon={LayoutDashboard}
          label="CONSOLIDADO"
        />
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            active={route.tab === "aba" && activeTab?.id === tab.id}
            onClick={() => openTab(tab.id)}
            color={tab.color}
            label={tab.name.toUpperCase()}
          />
        ))}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex items-center gap-1 px-3 py-3 text-tv-text/40 hover:text-tv-text hover:bg-white/5 transition-all"
          title="Nova aba (Configurações → Abas)"
          aria-label="Nova aba"
        >
          <Plus size={16} />
        </button>
      </nav>

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        <AnimatePresence mode="wait">
          <motion.div
            key={route.tab === "aba" ? `aba-${route.tabId}` : route.tab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            {route.tab === "aba" ? (
              activeTab ? (
              <ActionsDashboard
                key={activeTab.id}
                tab={activeTab}
                portfolio={portfolio}
                selectedTicker={selectedTicker}
                onSelect={openAsset}
                onOpenSettings={() => setSettingsOpen(true)}
              />
              ) : null
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
        {APP_NAME} &copy; {new Date().getFullYear()} · v{APP_VERSION}
      </footer>
    </div>
  );
}
