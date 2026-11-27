import { useEffect, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import { runtimeConfig } from "../../config/runtime";
import type { Catalogue } from "../../domain/catalogue";
import { availability } from "../../domain/model";
import type { Product } from "../../domain/schema";
import { CATEGORIES } from "../../domain/taxonomy";
import { useMotionAllowed } from "../../theme/ThemeContext";
import { StatusPill } from "../Badges";
import { HeroBanner } from "../HeroBanner";
import { IconArrowRight, IconExternal } from "../Icons";
import { ACCENT_RGB, ProductMark } from "../ProductArt";
import { HeroWordmark } from "./HeroWordmark";

/**
 * Pointer and scroll parallax for the hero: writes --px/--py (−1…1) and --sy (pixels scrolled) on the section, at
 * most once per frame, only while motion is allowed and only on devices with a fine pointer for --px/--py.
 */
function useParallax(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let frame = 0;
    let px = 0, py = 0;
    const write = () => {
      frame = 0;
      el.style.setProperty("--px", px.toFixed(3));
      el.style.setProperty("--py", py.toFixed(3));
      el.style.setProperty("--sy", `${Math.min(window.scrollY, 900).toFixed(0)}`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(write);
    };
    const fine = window.matchMedia?.("(pointer: fine)").matches;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      px = ((e.clientX - r.left) / r.width) * 2 - 1;
      py = ((e.clientY - r.top) / r.height) * 2 - 1;
      schedule();
    };
    if (fine) el.addEventListener("pointermove", onMove);
    window.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (fine) el.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
      el.style.removeProperty("--px");
      el.style.removeProperty("--py");
      el.style.removeProperty("--sy");
    };
  }, [ref, enabled]);
}

export function CinematicHero({ catalogue, spotlight, rotateSeconds }: { catalogue: Catalogue; spotlight: Product[]; rotateSeconds: number }) {
  const ref = useRef<HTMLElement>(null);
  const motion = useMotionAllowed();
  useParallax(ref, motion);
  const symbols = spotlight.filter((p) => p.artwork.icon).slice(0, 4);
  return (
    <section ref={ref} className="hero3" aria-labelledby="hero-title">
      <div className="hero3__glow" aria-hidden="true" />
      <div className="page-width hero3__stage">
        <div className="hero3__visual">
          <div className="hero3__frame holo-border">
            <HeroBanner />
            <span className="hero3__sheen" aria-hidden="true" />
          </div>
          {symbols.length > 0 && (
            <ul className="hero3__symbols" aria-hidden="true">
              {symbols.map((p, i) => (
                <li key={p.id} className={`hero3__symbol hero3__symbol--${i + 1}`} style={{ ["--card-accent-rgb" as string]: ACCENT_RGB[p.artwork.accent] }}>
                  <ProductMark product={p} size="md" />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="hero3__copy">
          <HeroWordmark />
          <p className="hero3__attribution">A Hakmi Capital Group Platform</p>
          <p className="hero3__tagline">The marketplace of an interconnected future</p>
          <p className="hero3__lead">Apps, infrastructure, security instruments and developer tools from HCG, each shown with its real status.</p>
          <div className="hero3__actions">
            <Link to="/apps" className="button button--primary">
              Browse Products <IconArrowRight />
            </Link>
            <a href="#ecosystem" className="button button--ghost">
              Explore the ecosystem
            </a>
            <a href={runtimeConfig.repoBaseUrl} className="button button--ghost hero3__repo">
              HCG Repo <IconExternal />
            </a>
          </div>
        </div>
      </div>
      {spotlight.length > 0 && <Spotlight catalogue={catalogue} products={spotlight} rotateSeconds={rotateSeconds} motion={motion} />}
    </section>
  );
}

/**
 * Featured product transitions: one product at a time from the storefront configuration. Auto-advances only while
 * motion is allowed, pauses on hover and focus, and always has a pause control and direct buttons (WCAG 2.2.2).
 */
function Spotlight({ catalogue, products, rotateSeconds, motion }: { catalogue: Catalogue; products: Product[]; rotateSeconds: number; motion: boolean }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hold, setHold] = useState(false);
  const running = motion && !paused && !hold && products.length > 1;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setIndex((i) => (i + 1) % products.length), rotateSeconds * 1000);
    return () => window.clearInterval(t);
  }, [running, products.length, rotateSeconds]);
  const p = products[index % products.length]!;
  return (
    <div
      className="page-width spotlight"
      onPointerEnter={() => setHold(true)}
      onPointerLeave={() => setHold(false)}
      onFocusCapture={() => setHold(true)}
      onBlurCapture={() => setHold(false)}
    >
      <section className="spotlight__card holo-border" aria-roledescription="carousel" aria-label="Spotlight" style={{ ["--card-accent-rgb" as string]: ACCENT_RGB[p.artwork.accent] }}>
        <div key={p.id} className="spotlight__slide" aria-live={running ? "off" : "polite"}>
          <ProductMark product={p} size="md" />
          <div className="spotlight__text">
            <p className="spotlight__kicker">Spotlight · {CATEGORIES[p.category].label}</p>
            <h2 className="spotlight__title">
              <Link to={`/apps/${p.slug}`}>{p.name}</Link>
            </h2>
            <p className="spotlight__summary">{p.summary}</p>
          </div>
          <StatusPill status={p.developmentStatus} availability={availability(catalogue, p)} />
        </div>
        {products.length > 1 && (
          <div className="spotlight__controls">
            <ul className="spotlight__dots">
              {products.map((x, i) => (
                <li key={x.id}>
                  <button type="button" className="spotlight__dot" aria-label={`Show ${x.name}`} aria-current={i === index ? "true" : undefined} onClick={() => setIndex(i)} />
                </li>
              ))}
            </ul>
            {motion && (
              <button type="button" className="spotlight__pause" onClick={() => setPaused((v) => !v)}>
                {paused ? "Play" : "Pause"}
                <span className="visually-hidden"> spotlight rotation</span>
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
