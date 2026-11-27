import { useEffect, useState } from "react";
import { runtimeConfig } from "../config/runtime";
import { storeApi, type Health } from "./api";

export type StoreHealthState = { status: "loading" } | { status: "ready"; health: Health } | { status: "unavailable" };

let shared: Promise<Health | null> | null = null;

/**
 * HCG Store's public health answer (what is switched on: free downloads, anonymous products, payments), fetched once
 * per page load and shared. On a static host without the Store server it is "unavailable": nothing is assumed.
 */
export function useStoreHealth(): StoreHealthState {
  const [state, setState] = useState<StoreHealthState>(runtimeConfig.accountService === "none" ? { status: "unavailable" } : { status: "loading" });
  useEffect(() => {
    if (runtimeConfig.accountService === "none") return;
    let on = true;
    shared ??= storeApi.health().catch(() => null);
    void shared.then((h) => on && setState(h ? { status: "ready", health: h } : { status: "unavailable" }));
    return () => {
      on = false;
    };
  }, []);
  return state;
}

/** Test helper: forget the shared answer. */
export function resetStoreHealthForTests() {
  shared = null;
}
