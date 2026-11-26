import { useEffect, useState } from "react";
import { useAccount } from "../account/account-context";
import { StoreApiError } from "../account/api";
import { adminApi, type Me } from "./admin-api";

export type AdminState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "unavailable"; message: string }
  | { status: "disabled" }
  | { status: "ok"; me: Me };

/**
 * What HCG lets the signed-in person do in HCG Store, as the server reports it (checked with HCG on every call). Only
 * used to show or hide controls: every operation is authorised again by the server.
 */
export function useAdminMe(): AdminState {
  const { state: account } = useAccount();
  const [state, setState] = useState<AdminState>({ status: "loading" });
  useEffect(() => {
    if (account.status === "loading") return;
    if (account.status !== "signed-in") {
      setState(account.status === "signed-out" ? { status: "signed-out" } : { status: "unavailable", message: "Sign-in with HCG Connect is not available on this site." });
      return;
    }
    let live = true;
    adminApi
      .me()
      .then((me) => live && setState(me.publishingMode === "disabled" ? { status: "disabled" } : { status: "ok", me }))
      .catch((e) => {
        if (!live) return;
        if (e instanceof StoreApiError && e.code === "publishing_disabled") setState({ status: "disabled" });
        else setState({ status: "unavailable", message: e instanceof Error ? e.message : "HCG Store could not check your permissions." });
      });
    return () => { live = false; };
  }, [account]);
  return state;
}
