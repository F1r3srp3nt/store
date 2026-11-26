import { Link } from "react-router-dom";
import { hcgRepoProductUrl } from "../config/runtime";
import type { Catalogue } from "../domain/catalogue";
import { availability, currentRelease } from "../domain/model";
import type { Product } from "../domain/schema";
import { CATEGORIES, EDITION_TIERS, PLATFORMS } from "../domain/taxonomy";
import { StatusPill } from "./Badges";
import { IconArrowRight, IconExternal } from "./Icons";
import { ACCENT_RGB, hasVisualArt, ProductCover, ProductMark } from "./ProductArt";

function platformLine(product: Product): string {
  return product.platforms.length ? product.platforms.map((p) => PLATFORMS[p.platform].label).join(" · ") : "Platforms not announced";
}

/** Edition indicators from the catalogue: the stated tier, else the edition name, once each. */
export function editionLabels(product: Product): string[] {
  return [...new Set(product.editions.map((e) => (e.tier ? EDITION_TIERS[e.tier].label : e.name)))];
}

/**
 * Product listing card (v3). Variants:
 *   "feature" — expanded editorial card for curated selections
 *   "card"    — banner, identity, indicators and actions (grids and carousels)
 *   "compact" — icon, name, one line and status; dense lists on phones
 *   "row"     — scan-friendly row for the full catalogue
 * Everything shown comes from the catalogue: status is the real development status and release availability, a
 * version appears only for an approved current release, and no price is shown unless the server offers one.
 */
export function ProductCard({
  catalogue,
  product,
  headingLevel = 3,
  variant = "card",
}: {
  catalogue: Catalogue;
  product: Product;
  headingLevel?: 2 | 3;
  variant?: "card" | "feature" | "row" | "compact";
}) {
  const avail = availability(catalogue, product);
  const cur = currentRelease(catalogue, product);
  const H = `h${headingLevel}` as const;
  const style = { ["--card-accent-rgb" as string]: ACCENT_RGB[product.artwork.accent] };
  const title = (
    <H className="product-card__title">
      <Link to={`/apps/${product.slug}`} className="product-card__link">
        {product.name}
      </Link>
    </H>
  );

  if (variant === "row") {
    return (
      <article className="product-row" data-product-id={product.id} style={style}>
        <ProductMark product={product} size="sm" />
        <div className="product-row__main">
          {title}
          <p className="product-row__summary">{product.summary}</p>
        </div>
        <p className="product-row__platforms">{platformLine(product)}</p>
        <StatusPill status={product.developmentStatus} availability={avail} channel={cur?.channel} />
      </article>
    );
  }

  if (variant === "compact") {
    return (
      <article className="product-compact holo-border" data-product-id={product.id} style={style}>
        <ProductMark product={product} size="sm" />
        <div className="product-compact__main">
          {title}
          <p className="product-compact__summary">{product.summary}</p>
        </div>
        <StatusPill status={product.developmentStatus} availability={avail} channel={cur?.channel} />
      </article>
    );
  }

  const editions = editionLabels(product);
  const repo = product.hcgRepo[0];
  return (
    <article
      className={`product-card product-card--${variant} holo-border${hasVisualArt(product) ? "" : " product-card--no-art"}`}
      data-product-id={product.id}
      data-atmosphere={product.artwork.atmosphere}
      style={style}
    >
      {hasVisualArt(product) && (
        <div className="product-card__art">
          <ProductCover product={product} sizes={variant === "feature" ? "(max-width: 860px) 92vw, 640px" : "(max-width: 700px) 86vw, 380px"} />
        </div>
      )}
      <div className="product-card__body">
        <div className="product-card__head">
          <ProductMark product={product} size="sm" />
          <div className="product-card__identity">
            <p className="product-card__category">{CATEGORIES[product.category].label}</p>
            {title}
          </div>
        </div>
        <p className="product-card__summary">{product.summary}</p>
        <ul className="product-card__indicators" aria-label="Details">
          {product.platforms.length ? (
            product.platforms.map((p) => (
              <li key={p.platform} className="indicator indicator--platform">
                {PLATFORMS[p.platform].label}
              </li>
            ))
          ) : (
            <li className="indicator indicator--muted">Platforms not announced</li>
          )}
          {editions.length > 1 && editions.map((e) => (
            <li key={e} className="indicator indicator--edition">
              {e}
            </li>
          ))}
        </ul>
        <div className="product-card__meta">
          <StatusPill status={product.developmentStatus} availability={avail} channel={cur?.channel} />
          {cur && (
            <span className="product-card__release mono">
              v{cur.version} · {cur.channel}
              {cur.releaseDate ? ` · ${cur.releaseDate}` : ""}
            </span>
          )}
        </div>
        <div className="product-card__actions">
          <Link to={`/apps/${product.slug}`} className="product-card__cta" tabIndex={-1} aria-hidden="true">
            View <IconArrowRight />
          </Link>
          {repo && variant === "feature" && (
            <a href={hcgRepoProductUrl(repo.key)} className="product-card__cta product-card__cta--ghost">
              HCG Repo <IconExternal />
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
