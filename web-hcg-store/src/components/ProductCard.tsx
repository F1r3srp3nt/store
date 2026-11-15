import { Link } from "react-router-dom";
import type { Catalogue } from "../domain/catalogue";
import { availability, currentRelease } from "../domain/model";
import type { Product } from "../domain/schema";
import { CATEGORIES, PLATFORMS } from "../domain/taxonomy";
import { StatusPill } from "./Badges";
import { hasVisualArt, ProductCover, ProductMark } from "./ProductArt";

function platformLine(product: Product): string {
  return product.platforms.length ? product.platforms.map((p) => PLATFORMS[p.platform].label).join(" · ") : "Platforms not announced";
}

/**
 * Product listing card. Variants:
 *   "card"    — cover art, name, benefit line, platforms and status (grids)
 *   "feature" — large editorial card for curated selections
 *   "row"     — compact, scan-friendly row (full catalogue lists)
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
  variant?: "card" | "feature" | "row";
}) {
  const avail = availability(catalogue, product);
  const cur = currentRelease(catalogue, product);
  const H = `h${headingLevel}` as const;
  const title = (
    <H className="product-card__title">
      <Link to={`/apps/${product.slug}`} className="product-card__link">
        {product.name}
      </Link>
    </H>
  );

  if (variant === "row") {
    return (
      <article className="product-row" data-product-id={product.id}>
        <ProductMark product={product} size="sm" />
        <div className="product-row__main">
          {title}
          <p className="product-row__summary">{product.summary}</p>
        </div>
        <p className="product-row__platforms">{platformLine(product)}</p>
        <StatusPill status={product.developmentStatus} availability={avail} />
      </article>
    );
  }

  return (
    <article className={`product-card product-card--${variant}${hasVisualArt(product) ? "" : " product-card--no-art"}`} data-product-id={product.id}>
      {hasVisualArt(product) && (
        <div className="product-card__art">
          <ProductCover product={product} sizes={variant === "feature" ? "(max-width: 860px) 92vw, 640px" : "(max-width: 700px) 92vw, 380px"} />
        </div>
      )}
      <div className="product-card__body">
        <div className="product-card__head">
          <ProductMark product={product} size="sm" />
          <div>
            <p className="product-card__category">{CATEGORIES[product.category].label}</p>
            {title}
          </div>
        </div>
        <p className="product-card__summary">{product.summary}</p>
        <div className="product-card__meta">
          <span className="product-card__platforms">{platformLine(product)}</span>
          <StatusPill status={product.developmentStatus} availability={avail} />
        </div>
        {cur && (
          <p className="product-card__release mono">
            v{cur.version} · {cur.channel}
          </p>
        )}
      </div>
    </article>
  );
}
