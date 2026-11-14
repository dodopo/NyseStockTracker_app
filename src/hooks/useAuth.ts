import { useCallback, useEffect, useState } from "react";
import { authApi } from "../api/endpoints";
import type { AuthUser } from "../types";

/** Current session: who is logged in and whether sign-up is open on this server. */
export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await authApi.me();
      setRegistrationEnabled(data.registrationEnabled !== false);
      setUser(data.authenticated ? data.user : null);
    } catch (error) {
      console.error("auth bootstrap error:", error);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch (error) {
      console.error("logout error:", error);
    } finally {
      setUser(null);
    }
  }, []);

  return { user, setUser, registrationEnabled, loading, logout };
}
