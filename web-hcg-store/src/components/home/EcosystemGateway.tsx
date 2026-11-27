import { useState } from "react";
import { Link } from "react-router-dom";
import { useStoreHealth } from "../../account/useStoreHealth";
import { accessLanes } from "../../domain/access-model";
import type { Catalogue } from "../../domain/catalogue";
import { availability, currentRelease, listedProducts, newReleases } from "../../domain/model";
import type { Product } from "../../domain/schema";
import { PLATFORMS } from "../../domain/taxonomy";
import { assetUrl } from "../../lib/format";
import { useThemeId } from "../../theme/ThemeContext";
import { storefrontStatus } from "../Badges";
import { IconArrowRight } from "../Icons";
import { ProductMark } from "../ProductArt";

/**
 * The bottom of the homepage: the HCG ecosystem as a constellation around the official HCG STORE wordmark (every
 * public product, linked to its page, with its real status), the latest approved releases, and how access really
 * works (from what HCG Store's server reports as switched on). Decorative motion is CSS only and stops for reduced
 * motion or when effects are off.
 */
export function EcosystemGateway({ catalogue }: { catalogue: Catalogue }) {
  const health = useStoreHealth();
  const h = health.status === "ready" ? health.health : null;
  const lanes = accessLanes(catalogue, h);
  const anonymous = new Set(h && h.protectedDownloads !== "disabled" ? (h.anonymousFreeProducts ?? []) : []);
  return (
    <section className="gateway" aria-labelledby="gateway-title" data-reveal>
      <div className="gateway__circuit" aria-hidden="true" />
      <div className="page-width gateway__inner">
        <header className="gateway__head">
          <p className="eyebrow eyebrow--accent">The HCG ecosystem</p>
          <h2 id="gateway-title" className="gateway__title">
            One store. Every HCG application.
          </h2>
          <p className="gateway__lead">
            Each product below is a real HCG application with its current status. Select one to open its page.
          </p>
        </header>

        <Constellation catalogue={catalogue} />

        <div className="gateway__grid">
          <LatestReleases catalogue={catalogue} anonymous={anonymous} />
          <section className="gateway-access" aria-labelledby="access-title">
            <h3 id="access-title" className="gateway__subtitle">
              How access works
            </h3>
            <ul className="access-lanes">
              {lanes.map((l) => (
                <li key={l.id} className={`access-lane access-lane--${l.tone}`} data-lane={l.id}>
                  <p className="access-lane__state">
                    <span className="access-lane__dot" aria-hidden="true" />
                    {l.state}
                  </p>
                  <h4 className="access-lane__title">{l.title}</h4>
                  <p className="access-lane__text">{l.text}</p>
                  {l.products.length > 0 && (
                    <p className="access-lane__links">
                      {l.products.map((p) => (
                        <Link key={p.slug} to={`/apps/${p.slug}`} className="text-link">
                          {p.name} <IconArrowRight />
                        </Link>
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <Link to="/getting-started" className="text-link">
              How downloads, verification and accounts work <IconArrowRight />
            </Link>
          </section>
        </div>
      </div>
    </section>
  );
}

/** Released first, then testing, in development, planned; then by name. */
const ORDER = ["Public beta", "Released", "Testing", "In development", "Planned", "Maintained", "Paused", "Status not stated"];

function Constellation({ catalogue }: { catalogue: Catalogue }) {
  const theme = useThemeId();
  const [active, setActive] = useState<string | null>(null);
  const nodes = listedProducts(catalogue)
    .map((p) => ({ p, s: storefrontStatus(p.developmentStatus, availability(catalogue, p), currentRelease(catalogue, p)?.channel) }))
    .sort((a, b) => ORDER.indexOf(a.s.label) - ORDER.indexOf(b.s.label) || a.p.name.localeCompare(b.p.name, "en"));
  const n = nodes.length;
  // Positions on an ellipse around the wordmark (percent of the stage), starting at the top.
  const pos = (i: number) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return { x: 50 + 42 * Math.cos(a), y: 50 + 40 * Math.sin(a) };
  };
  const variant = theme === "frost" ? "light" : "dark";
  return (
    <div className={`constellation${active ? " has-active" : ""}`}>
      <svg className="constellation__lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <ellipse className="constellation__orbit" cx="50" cy="50" rx="42" ry="40" />
        {nodes.map(({ p, s }, i) => {
          const { x, y } = pos(i);
          const live = s.tone === "released";
          return (
            <line
              key={p.id}
              x1="50"
              y1="50"
              x2={x}
              y2={y}
              className={`constellation__line${live ? " is-live" : ""}${active === p.id ? " is-active" : ""}`}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <div className="constellation__core">
        <img
          className="constellation__wordmark"
          src={assetUrl(`brand/hcg-store-wordmark-${variant}-720.webp`)}
          srcSet={`${assetUrl(`brand/hcg-store-wordmark-${variant}-720.webp`)} 720w, ${assetUrl(`brand/hcg-store-wordmark-${variant}-1440.webp`)} 1440w`}
          sizes="(max-width: 760px) 70vw, 300px"
          width={1440}
          height={variant === "light" ? 276 : 282}
          alt="HCG Store"
          loading="lazy"
          decoding="async"
        />
        <p className="constellation__count">
          {n} HCG {n === 1 ? "application" : "applications"}
        </p>
      </div>
      <ul className="constellation__nodes">
        {nodes.map(({ p, s }, i) => {
          const { x, y } = pos(i);
          return (
            <li
              key={p.id}
              className={`constellation-node constellation-node--${s.tone}${active === p.id ? " is-active" : ""}`}
              style={{ ["--x" as string]: `${x}%`, ["--y" as string]: `${y}%`, ["--i" as string]: i }}
            >
              <Link
                to={`/apps/${p.slug}`}
                className="constellation-node__link"
                onMouseEnter={() => setActive(p.id)}
                onMouseLeave={() => setActive((a) => (a === p.id ? null : a))}
                onFocus={() => setActive(p.id)}
                onBlur={() => setActive((a) => (a === p.id ? null : a))}
              >
                <span className="constellation-node__icon">
                  <ProductMark product={p} size="md" />
                </span>
                <span className="constellation-node__name">{p.name}</span>
                <span className="constellation-node__status">
                  <span className="constellation-node__dot" aria-hidden="true" />
                  {s.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Platforms a product is confirmed on (catalogue, updated by HCG Store's live publications), e.g. "Windows x64". */
function confirmedPlatforms(p: Product): string[] {
  return p.platforms
    .filter((x) => x.support === "confirmed")
    .map((x) => `${PLATFORMS[x.platform].label}${x.architectures.length ? ` ${x.architectures.join("/")}` : ""}`);
}

function LatestReleases({ catalogue, anonymous }: { catalogue: Catalogue; anonymous: Set<string> }) {
  const items = newReleases(catalogue).slice(0, 3);
  return (
    <section className="gateway-latest" aria-labelledby="latest-title">
      <h3 id="latest-title" className="gateway__subtitle">
        Latest releases
      </h3>
      {items.length === 0 ? (
        <p className="muted">No release has been approved in HCG Store yet.</p>
      ) : (
        <ul className="latest-list">
          {items.map(({ product, release }) => {
            const s = storefrontStatus(product.developmentStatus, "released", release.channel);
            const free = product.editions.some((e) => e.pricingModel === "free");
            const platforms = confirmedPlatforms(product);
            return (
              <li key={product.id} className="latest-card" data-product={product.id}>
                <Link to={`/apps/${product.slug}`} className="latest-card__link">
                  <ProductMark product={product} size="lg" />
                  <span className="latest-card__body">
                    <span className="latest-card__name">{product.name}</span>
                    <span className="latest-card__version">
                      {release.version} · {s.label}
                    </span>
                    <span className="latest-card__facts">
                      {platforms.length > 0 && <span>{platforms.join(" · ")}</span>}
                      <span>{free ? (anonymous.has(product.id) ? "Free · no account needed" : "Free") : "Price on product page"}</span>
                      {release.releaseDate && <span>Released {release.releaseDate}</span>}
                    </span>
                  </span>
                  <span className="latest-card__cta" aria-hidden="true">
                    <IconArrowRight />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Link to="/apps?availability=released" className="text-link">
        All released products <IconArrowRight />
      </Link>
    </section>
  );
}
