/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPreference, DEFAULT_THEME, isThemeId, localPreferenceStore, STORAGE_KEYS, THEME_IDS, THEMES } from "./theme";

// Vitest runs from the web-hcg-store folder.
const css = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

/** Reads a theme's custom properties (default theme = :root in tokens.css, others = html[data-theme] in themes.css). */
function themeVars(id: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const take = (block: string) => {
    for (const m of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim();
  };
  take(/:root \{([\s\S]*?)\n\}/.exec(css("src/styles/tokens.css"))![1]!);
  if (id !== "sovereign") take(new RegExp(`html\\[data-theme="${id}"\\] \\{([\\s\\S]*?)\\n\\}`).exec(css("src/styles/themes.css"))![1]!);
  return vars;
}
const rgbOf = (v: string): [number, number, number] => {
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as [number, number, number];
  const ch = /^(\d+) (\d+) (\d+)$/.exec(v);
  if (ch) return [Number(ch[1]), Number(ch[2]), Number(ch[3])];
  throw new Error(`Not a plain colour: ${v}`);
};
const lum = ([r, g, b]: [number, number, number]) => {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(rgbOf(a)), lum(rgbOf(b))].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.effects;
});

describe("theme engine", () => {
  it("has exactly the six themes, every one defined in themes.css (default in tokens.css)", () => {
    expect(THEME_IDS).toEqual(["sovereign", "cyberpunk", "crimson", "founder", "frost", "horizon"]);
    for (const id of THEME_IDS.filter((t) => t !== DEFAULT_THEME)) expect(css("src/styles/themes.css")).toContain(`html[data-theme="${id}"]`);
    expect(THEMES.map((t) => t.label)).toContain("HCG Sovereign");
  });

  it("keeps the pre-paint boot script in step with the module (IDs and storage keys)", () => {
    const boot = css("public/theme-boot.js");
    for (const id of THEME_IDS) expect(boot).toContain(`"${id}"`);
    expect(boot).toContain(STORAGE_KEYS.theme);
    expect(boot).toContain(STORAGE_KEYS.effects);
    expect(css("index.html")).toMatch(/<script src="%BASE_URL%theme-boot\.js"><\/script>/);
  });

  it("keeps body text ≥ 7:1 and links/accent ≥ 4.5:1 on the page and panel colours of every theme", () => {
    for (const id of THEME_IDS) {
      const v = themeVars(id);
      const accent = v["--accent-rgb"]!;
      for (const bg of [v["--obsidian"]!, v["--surface-1"]!]) {
        expect(contrast(v["--text"]!, bg), `${id} text on ${bg}`).toBeGreaterThanOrEqual(7);
        expect(contrast(v["--text-muted"]!, bg), `${id} muted on ${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v["--text-faint"]!, bg), `${id} faint on ${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(accent, bg), `${id} accent on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("saves and restores the choice locally, and falls back to the default when storage is unavailable or tampered with", () => {
    localPreferenceStore.save({ theme: "frost", effects: "off" });
    expect(localPreferenceStore.load()).toEqual({ theme: "frost", effects: "off" });
    window.localStorage.setItem(STORAGE_KEYS.theme, "<script>");
    expect(localPreferenceStore.load().theme).toBe(DEFAULT_THEME);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(localPreferenceStore.load()).toEqual({ theme: DEFAULT_THEME, effects: "on" });
    expect(() => localPreferenceStore.save({ theme: "crimson", effects: "on" })).not.toThrow();
    expect(isThemeId("crimson")).toBe(true);
    expect(isThemeId("cyberpunk-2077")).toBe(false);
  });

  it("applies the theme and effects to the document", () => {
    applyPreference({ theme: "horizon", effects: "off" });
    expect(document.documentElement.dataset.theme).toBe("horizon");
    expect(document.documentElement.dataset.effects).toBe("off");
  });

  it("stops every decorative animation when effects are off or the system asks for reduced motion", () => {
    const fx = css("src/styles/effects.css");
    expect(fx).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.ambient \*[\s\S]*animation: none !important/);
    expect(fx).toMatch(/html\[data-effects="off"\] \.ambient \*/);
    expect(css("src/styles/v3.css")).toMatch(/html\[data-effects="off"\] \.hero3__sheen/);
    // Only transform/opacity are animated in the background engine (no filters, no layout properties).
    for (const kf of fx.matchAll(/@keyframes [a-z-]+ \{([\s\S]*?)\n\}/g)) expect(kf[1]).not.toMatch(/\b(width|height|top|left|filter|background-position)\s*:/);
  });
});
