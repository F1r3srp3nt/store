import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Catalogue } from "../domain/catalogue";
import type { CatalogueLoadResult, CatalogueProvider, CatalogueSource } from "../providers/types";

export type CatalogueState =
  | { status: "loading"; source: CatalogueSource }
  | { status: "error"; result: Extract<CatalogueLoadResult, { ok: false }> }
  | { status: "ready"; catalogue: Catalogue; source: CatalogueSource; warnings: string[] };

const Ctx = createContext<CatalogueState | null>(null);

export function CatalogueStateProvider({ provider, children }: { provider: CatalogueProvider; children: ReactNode }) {
  const [state, setState] = useState<CatalogueState>({ status: "loading", source: provider.source });
  useEffect(() => {
    const controller = new AbortController();
    provider.load(controller.signal).then((r) => {
      if (controller.signal.aborted) return;
      setState(r.ok ? { status: "ready", catalogue: r.catalogue, source: r.source, warnings: r.warnings } : { status: "error", result: r });
    });
    return () => controller.abort();
  }, [provider]);
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
