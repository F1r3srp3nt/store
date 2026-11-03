import { Link } from "react-router-dom";
import type { Catalogue } from "../domain/catalogue";
import { availability, currentRelease } from "../domain/model";
import type { Product } from "../domain/schema";
import { CATEGORIES } from "../domain/taxonomy";
import { AvailabilityBadge, PlatformChips, StatusBadge } from "./Badges";
import { MediaImage } from "./MediaImage";
import { ProductTile } from "./ProductTile";

export function ProductCard({ catalogue, product, headingLevel = 3 }: { catalogue: Catalogue; product: Product; headingLevel?: 2 | 3 }) {
  const avail = availability(catalogue, product);
  const cur = currentRelease(catalogue, product);
  const shot = product.media.find((m) => m.kind === "screenshot");
  const H = `h${headingLevel}` as const;
  return (
    <article className="product-card" data-product-id={product.id}>
      <div className="product-card__art">
        {shot ? (
          <MediaImage media={shot} sizes="(max-width: 700px) 92vw, 380px" fallback={<ProductTile product={product} />} />
        ) : (
          <ProductTile product={product} />
        )}
        <span className="art-label">{shot ? "Screenshot" : "Generated tile"}</span>
      </div>
      <div className="product-card__body">
        <p className="eyebrow">{CATEGORIES[product.category].label}</p>
        <H className="product-card__title">
          <Link to={`/apps/${product.slug}`} className="product-card__link">
            {product.name}
          </Link>
        </H>
        <p className="product-card__summary">{product.summary}</p>
        <div className="product-card__badges">
          <StatusBadge status={product.developmentStatus} />
          <AvailabilityBadge availability={avail} />
        </div>
        {cur && (
          <p className="product-card__release mono">
            v{cur.version} · {cur.channel}
          </p>
        )}
        <PlatformChips platforms={product.platforms} compact />
      </div>
    </article>
  );
}

