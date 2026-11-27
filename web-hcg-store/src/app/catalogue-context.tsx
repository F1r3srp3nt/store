import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Catalogue } from "../domain/catalogue";
import type { CatalogueLoadResult, CatalogueProvider, CatalogueSource } from "../providers/types";
import { runtimeConfig } from "../config/runtime";
import { applyLivePublications, type LivePublications } from "../domain/live-publications";

export type CatalogueState =
  | { status: "loading"; source: CatalogueSource }
  | { status: "error"; result: Extract<CatalogueLoadResult, { ok: false }> }
  | { status: "ready"; catalogue: Catalogue; source: CatalogueSource; warnings: string[] };

const Ctx = createContext<CatalogueState | null>(null);

export function CatalogueStateProvider({
  provider,
  children,
  live = runtimeConfig.accountService === "same-origin-server",
}: {
  provider: CatalogueProvider;
  children: ReactNode;
  /** Overlay HCG Store's live publications (same-origin server). Off on static hosts. */
  live?: boolean;
}) {
  const [state, setState] = useState<CatalogueState>({ status: "loading", source: provider.source });
  useEffect(() => {
    const controller = new AbortController();
    provider.load(controller.signal).then((r) => {
      if (controller.signal.aborted) return;
      setState(r.ok ? { status: "ready", catalogue: r.catalogue, source: r.source, warnings: r.warnings } : { status: "error", result: r });
      // Then HCG Store's live publications (same-origin server only): pages follow a publication without a catalogue
      // edit. The catalogue shows at once; the overlay only ever adds what HCG Store has published.
      if (r.ok && live) {
        void fetchLivePublications(controller.signal).then((live) => {
          if (!live || controller.signal.aborted) return;
          setState((s) => (s.status === "ready" ? { ...s, catalogue: applyLivePublications(s.catalogue, live) } : s));
        });
      }
    });
    return () => controller.abort();
  }, [provider, live]);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useCatalogueState(): CatalogueState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCatalogueState must be used inside CatalogueStateProvider");
  return v;
}

/** Renders children only once the catalogue is loaded; otherwise an honest loading or error state. */
export function CatalogueGate({ children }: { children: (catalogue: Catalogue) => ReactNode }) {
  const state = useCatalogueState();
  if (state.status === "loading") {
    return (
      <div className="state-panel" role="status" aria-live="polite">
        <span className="state-panel__pulse" aria-hidden="true" />
        Loading catalogue…
      </div>
    );
  }
  if (state.status === "error") {
    const { result } = state;
    return (
      <div className="state-panel state-panel--error" role="alert">
        <h2>Catalogue unavailable</h2>
        <p>{result.message}</p>
        <p className="state-panel__meta">Source: {result.source.label}</p>
        {result.details.length > 0 && (
          <details>
            <summary>Technical details ({result.details.length})</summary>
            <ul>
              {result.details.slice(0, 50).map((d) => (
                <li key={d}>
                  <code>{d}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  }
  return <>{children(state.catalogue)}</>;
}

/** Fetches the live publications from the same-origin HCG Store server; null when there is none (static hosting). */
export async function fetchLivePublications(signal?: AbortSignal): Promise<LivePublications | null> {
  try {
    const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
    const res = await fetch(`${base}/api/public/v1/published`, { signal, headers: { accept: "application/json" }, credentials: "omit" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return null;
    return (await res.json()) as LivePublications;
  } catch {
    return null;
  }
}
