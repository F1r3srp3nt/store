import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { runtimeConfig } from "../config/runtime";
import { StoreServerUnavailable, storeApi, type SessionInfo } from "./api";

/**
 * Account state for the whole app. Restored from the server on every page load (the session lives
 * in an HttpOnly cookie), and re-read when the tab becomes visible again so sign-out, expiry and
 * central revocation show up without a reload.
 */
export type AccountState =
  | { status: "loading" }
  | { status: "no-server" }
  | { status: "not-configured" }
  | { status: "signed-out"; notice: string | null }
  | { status: "signed-in"; user: NonNullable<SessionInfo["user"]>; centralCheckUnavailable: boolean }
  | { status: "error"; message: string };

interface AccountContextValue {
  state: AccountState;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AccountContext = createContext<AccountContextValue | null>(null);

export interface AccountApi {
  session: typeof storeApi.session;
  logout: typeof storeApi.logout;
}

export function AccountProvider({
  children,
  api = storeApi,
  accountService = runtimeConfig.accountService,
}: {
  children: ReactNode;
  api?: AccountApi;
  /** "none" on static hosts: no account requests are made at all. */
  accountService?: "same-origin-server" | "none";
}) {
  const staticSite = accountService === "none";
  const [state, setState] = useState<AccountState>(staticSite ? { status: "no-server" } : { status: "loading" });

  const refresh = useCallback(async () => {
    if (staticSite) return;
    try {
      const s = await api.session();
      if (!s.configured) setState({ status: "not-configured" });
      else if (s.signedIn && s.user) setState({ status: "signed-in", user: s.user, centralCheckUnavailable: s.centralCheck === "unavailable" });
      else setState({ status: "signed-out", notice: s.endedReason ?? null });
    } catch (e) {
      setState(e instanceof StoreServerUnavailable ? { status: "no-server" } : { status: "error", message: "Your account status could not be loaded." });
    }
  }, [api, staticSite]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      await refresh();
    }
  }, [api, refresh]);

  useEffect(() => {
    void refresh();
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const value = useMemo(() => ({ state, refresh, signOut }), [state, refresh, signOut]);
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountContextValue {
  const v = useContext(AccountContext);
  if (!v) throw new Error("useAccount must be used inside <AccountProvider>.");
  return v;
}
