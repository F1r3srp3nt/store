/**
 * Theme engine (v3). Six visual themes over one set of design tokens (styles/tokens.css + styles/themes.css), chosen
 * by any visitor without signing in and stored only in this browser. A theme never changes content, prices, access
 * or any control's behaviour.
 *
 * `public/theme-boot.js` applies the stored choice before the first paint (the CSP allows only same-origin scripts).
 * Keep STORAGE_KEYS and THEME_IDS in sync with it (theme.test.ts checks).
 */
export const THEMES = [
  { id: "sovereign", label: "HCG Sovereign", note: "Obsidian, titanium, electric cyan and sapphire. The HCG default.", swatch: ["#05070a", "#c9d2dd", "#45e1f5", "#4d8dff"] },
  { id: "cyberpunk", label: "Cyberpunk", note: "Neon violet, magenta and electric blue city light.", swatch: ["#07040f", "#965cff", "#ff4df0", "#2fb8ff"] },
  { id: "crimson", label: "Crimson Frontier", note: "Black, crimson and industrial steel.", swatch: ["#070304", "#c8d2de", "#ff4858", "#ff8c5a"] },
  { id: "founder", label: "Founder Edition", note: "Obsidian, polished gold and titanium.", swatch: ["#060606", "#c9d1dc", "#e6c278", "#fff0c8"] },
  { id: "frost", label: "Quantum Frost", note: "White, silver, ice blue and glass. Light theme.", swatch: ["#eef3f8", "#ffffff", "#0070b0", "#78beeb"] },
  { id: "horizon", label: "Event Horizon", note: "Deep navy, cosmic violet and orbital light.", swatch: ["#030614", "#4fd1ff", "#9684ff", "#ff96dc"] },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export const THEME_IDS = THEMES.map((t) => t.id) as ThemeId[];
export const DEFAULT_THEME: ThemeId = "sovereign";
export type Effects = "on" | "off";

export const STORAGE_KEYS = { theme: "hcg-store.theme", effects: "hcg-store.effects" } as const;

export interface ThemePreference {
  theme: ThemeId;
  effects: Effects;
}

export const isThemeId = (x: unknown): x is ThemeId => typeof x === "string" && (THEME_IDS as string[]).includes(x);

/** Where preferences live. Today only this browser; an HCG Connect-backed store can implement the same contract. */
export interface ThemePreferenceStore {
  load(): ThemePreference;
  save(p: ThemePreference): void;
}

/** localStorage, guarded: private windows, blocked storage or quota errors fall back to the default silently. */
export const localPreferenceStore: ThemePreferenceStore = {
  load() {
    let theme: ThemeId = DEFAULT_THEME;
    let effects: Effects = "on";
    try {
      const t = window.localStorage.getItem(STORAGE_KEYS.theme);
      if (isThemeId(t)) theme = t;
      if (window.localStorage.getItem(STORAGE_KEYS.effects) === "off") effects = "off";
    } catch {
      /* storage unavailable: defaults */
    }
    return { theme, effects };
  },
  save(p) {
    try {
      window.localStorage.setItem(STORAGE_KEYS.theme, p.theme);
      window.localStorage.setItem(STORAGE_KEYS.effects, p.effects);
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  },
};

/**
 * Future synchronisation through HCG Connect (not active). A signed-in visitor's preference would be read from and
 * written to the Store server (`GET/PUT /api/v1/preferences`, a session-bound, non-sensitive record), which would keep
 * it with the account. Until that endpoint exists, the Store uses only `localPreferenceStore`, and signing in changes
 * nothing about the theme. A remote store must never block rendering: it reconciles after the local choice is shown.
 */
export interface RemotePreferenceSync {
  pull(): Promise<ThemePreference | null>;
  push(p: ThemePreference): Promise<void>;
}

const themeColorOf = (root: HTMLElement) => getComputedStyle(root).getPropertyValue("--theme-color").trim();

/** Applies a preference to the document: data attributes, the browser UI colour, and a short cross-fade. */
export function applyPreference(p: ThemePreference, opts: { animate?: boolean } = {}) {
  const root = document.documentElement;
  const changed = root.dataset.theme !== p.theme;
  if (opts.animate && changed && p.effects === "on" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    root.classList.add("theme-switching");
    window.setTimeout(() => root.classList.remove("theme-switching"), 420);
  }
  root.dataset.theme = p.theme;
  root.dataset.effects = p.effects;
  const meta = document.querySelector('meta[name="theme-color"]');
  const color = themeColorOf(root);
  if (meta && color) meta.setAttribute("content", color);
  const scheme = document.querySelector('meta[name="color-scheme"]');
  if (scheme) scheme.setAttribute("content", p.theme === "frost" ? "light" : "dark");
}
