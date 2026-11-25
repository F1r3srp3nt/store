import { useEffect, useId, useRef, useState } from "react";
import { IconPalette } from "../components/Icons";
import { useTheme } from "./ThemeContext";
import { THEMES } from "./theme";

/** The six themes as a radio group, plus the decorative-effects switch. Shared by the header popover and the mobile sheet. */
export function ThemeChoices({ compact = false }: { compact?: boolean }) {
  const t = useTheme();
  const name = useId();
  return (
    <div className={`theme-choices${compact ? " theme-choices--compact" : ""}`}>
      <fieldset className="theme-choices__set">
        <legend className="theme-choices__legend">Theme</legend>
        {THEMES.map((th) => (
          <label key={th.id} className="theme-choice" data-theme-option={th.id}>
            <input type="radio" name={name} value={th.id} checked={t.theme === th.id} onChange={() => t.setTheme(th.id)} />
            <span className="theme-choice__swatch" aria-hidden="true">
              {th.swatch.map((c) => (
                <span key={c} style={{ background: c }} />
              ))}
            </span>
            <span className="theme-choice__text">
              <span className="theme-choice__label">{th.label}</span>
              {!compact && <span className="theme-choice__note">{th.note}</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <label className="effects-switch">
        <input type="checkbox" role="switch" checked={t.effects === "on"} onChange={(e) => t.setEffects(e.target.checked ? "on" : "off")} />
        <span>
          Decorative effects
          <span className="effects-switch__note">
            {t.reducedMotion ? "Your device asks for reduced motion, so effects stay still." : "Animated background, borders and entrances."}
          </span>
        </span>
      </label>
      <p className="theme-choices__fine">Saved in this browser only. A theme never changes prices, access or downloads.</p>
    </div>
  );
}

/** Header button opening the theme popover. Escape and outside clicks close it; focus returns to the button. */
export function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  return (
    <div className="theme-menu">
      <button ref={btn} type="button" className="tool-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <IconPalette />
        <span className="visually-hidden">Theme</span>
      </button>
      <div id={id} ref={panel} className="theme-menu__panel" hidden={!open}>
        <ThemeChoices />
      </div>
    </div>
  );
}
