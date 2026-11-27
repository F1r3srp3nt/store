import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { applyPreference, localPreferenceStore, type Effects, type ThemeId, type ThemePreference, type ThemePreferenceStore } from "./theme";

interface ThemeApi extends ThemePreference {
  setTheme: (t: ThemeId) => void;
  setEffects: (e: Effects) => void;
  /** True when the visitor's system asks for reduced motion (effects then stay still regardless of the toggle). */
  reducedMotion: boolean;
}

const Ctx = createContext<ThemeApi | null>(null);

export function ThemeProvider({ children, store = localPreferenceStore }: { children: ReactNode; store?: ThemePreferenceStore }) {
  const [pref, setPref] = useState<ThemePreference>(() => store.load());
  const [reducedMotion, setReduced] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  useEffect(() => applyPreference(pref, { animate: true }), [pref]);

  const update = useCallback(
    (next: ThemePreference) => {
      setPref(next);
      store.save(next);
    },
    [store],
  );

  const api = useMemo<ThemeApi>(
    () => ({ ...pref, reducedMotion, setTheme: (theme) => update({ ...pref, theme }), setEffects: (effects) => update({ ...pref, effects }) }),
    [pref, reducedMotion, update],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme outside ThemeProvider");
  return v;
}

/** The current theme, or null outside a ThemeProvider (for components that only adapt to it). */
export function useThemeId(): ThemeId | null {
  return useContext(Ctx)?.theme ?? null;
}

/** True when decorative motion should run: effects on and no reduced-motion request. */
export function useMotionAllowed(): boolean {
  const t = useContext(Ctx);
  return !!t && t.effects === "on" && !t.reducedMotion;
}
