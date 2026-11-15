import { Link, useParams } from "react-router-dom";
import { CatalogueGate } from "../app/catalogue-context";
import { AccessPanel } from "../components/AccessPanel";
import { StatusPill } from "../components/Badges";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconExternal,
  IconInfo,
} from "../components/Icons";
import { MediaImage } from "../components/MediaImage";
import { PageMeta } from "../components/PageMeta";
import {
  hasVisualArt,
  ProductCover,
  ProductMark,
} from "../components/ProductArt";
import { ReleasePanel } from "../components/Release";
import { hcgRepoProductUrl } from "../config/runtime";
import type { Catalogue } from "../domain/catalogue";
import { availability, findProductBySlug, successorOf } from "../domain/model";
import type { Product } from "../domain/schema";
import {
  CATEGORIES,
  DEVELOPMENT_STATUS,
  PLATFORMS,
  PLATFORM_SUPPORT,
} from "../domain/taxonomy";
import { NotFoundContent } from "./NotFoundPage";

export function ProductPage() {
  const { slug = "" } = useParams();
  return (
    <CatalogueGate>
      {(c) => {
        const product = findProductBySlug(c, slug);
        return product ? (
          <ProductDetail catalogue={c} product={product} />
        ) : (
          <NotFoundContent what="product" />
        );
      }}
    </CatalogueGate>
  );
}

function ProductDetail({
  catalogue,
  product,
}: {
  catalogue: Catalogue;
  product: Product;
}) {
  const avail = availability(catalogue, product);
  const successor = successorOf(catalogue, product);
  const screenshots = product.media.filter((m) => m.kind === "screenshot");
  const concepts = product.media.filter((m) => m.kind === "concept");

  return (
    <>
      <PageMeta title={product.name} description={product.summary} />
      <div className="page-width page-pad">
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <ol>
            <li>
              <Link to="/apps">
                <IconArrowLeft /> Browse
              </Link>
            </li>
            <li>
              <Link to={`/apps?category=${product.category}`}>
                {CATEGORIES[product.category].label}
              </Link>
            </li>
            <li aria-current="page">{product.name}</li>
          </ol>
        </nav>

        {successor && (
          <div className="callout callout--merged" role="note">
            <p>
              <strong>
                {product.name} is now part of {successor.name}.
              </strong>{" "}
              Its features continue in {successor.name}. This page is kept so
              existing links and identifiers keep working.
            </p>
            <Link
              to={`/apps/${successor.slug}`}
              className="button button--primary button--small"
            >
              Go to {successor.name} <IconArrowRight />
            </Link>
          </div>
        )}

        <header className="product-hero">
          <ProductMark product={product} size="lg" />
          <div className="product-hero__copy">
            <p className="eyebrow eyebrow--accent">
              {CATEGORIES[product.category].label}
            </p>
            <h1>{product.name}</h1>
            {product.formerNames.length > 0 && (
              <p className="product-hero__former">
                Formerly {product.formerNames.join(" and ")}
              </p>
            )}
            <p className="product-hero__summary">{product.summary}</p>
            <div className="product-hero__meta">
              <StatusPill
                status={product.developmentStatus}
                availability={avail}
              />
              <span className="product-hero__platforms">
                {product.platforms.length
                  ? product.platforms
                      .map((p) => PLATFORMS[p.platform].label)
                      .join(" · ")
                  : "Platforms not announced"}
              </span>
            </div>
            {product.hcgRepo.length > 0 && (
              <p className="product-hero__repo">
                {product.hcgRepo.map((l) => (
                  <a
                    key={l.key}
                    href={hcgRepoProductUrl(l.key)}
                    className="text-link"
                  >
                    View on HCG Repo
                    {l.editionId
                      ? ` (${product.editions.find((e) => e.id === l.editionId)?.name ?? l.editionId})`
                      : ""}{" "}
                    <IconExternal />
                  </a>
                ))}
              </p>
            )}
          </div>
        </header>

        <div className="product-layout">
          <div className="product-main">
            {(hasVisualArt(product) || concepts.length > 0) && (
              <section
                aria-labelledby="gallery-title"
                className="product-gallery"
              >
                <h2 id="gallery-title" className="visually-hidden">
                  Gallery
                </h2>
                {hasVisualArt(product) && (
                  <ProductCover
                    product={product}
                    sizes="(max-width: 1000px) 92vw, 760px"
                    eager
                  />
                )}
                {screenshots.length > 1 && (
                  <ul className="gallery-strip">
                    {screenshots.slice(1).map((m) => (
                      <li key={m.src}>
                        <figure className="gallery-strip__item">
                          <div className="screen-frame">
                            <MediaImage
                              media={m}
                              sizes="(max-width: 700px) 92vw, 360px"
                            />
                          </div>
                          <figcaption>{m.caption}</figcaption>
                        </figure>
                      </li>
                    ))}
                  </ul>
                )}
                {screenshots[0] && (
                  <p className="fine">{screenshots[0].caption}</p>
                )}
                {concepts.map((m) => (
                  <figure key={m.src} className="gallery-strip__item">
                    <MediaImage
                      media={m}
                      sizes="(max-width: 1000px) 92vw, 760px"
                    />
                    <figcaption>
                      <span className="art-tag art-tag--concept">
                        Illustration
                      </span>{" "}
                      {m.caption}
                    </figcaption>
                  </figure>
                ))}
              </section>
            )}

            <section aria-labelledby="about-title" className="panel">
              <h2 id="about-title">About</h2>
              {product.description.map((d, i) => (
                <p key={i}>{d}</p>
              ))}
            </section>

            {(product.currentFeatures.length > 0 ||
              product.plannedFeatures.length > 0) && (
              <section aria-labelledby="features-title" className="panel">
                <h2 id="features-title">Features</h2>
                {product.currentFeatures.length > 0 && (
                  <>
                    <h3 className="feature-heading">
                      Available in the current build
                    </h3>
                    <ul className="feature-list">
                      {product.currentFeatures.map((f) => (
                        <li key={f}>
                          <IconCheck className="feature-list__icon" /> {f}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {product.plannedFeatures.length > 0 && (
                  <>
                    <h3 className="feature-heading">
                      Planned (not available yet)
                    </h3>
                    <ul className="feature-list feature-list--planned">
                      {product.plannedFeatures.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  </>
                )}
                <p className="fine">
                  Features are listed as the product's development repository
                  describes them. A build is not a release.
                </p>
              </section>
            )}

            <AccessPanel catalogue={catalogue} product={product} />

            <section aria-labelledby="platforms-title" className="panel">
              <h2 id="platforms-title">Platforms and requirements</h2>
              {product.platforms.length ? (
                <ul className="requirement-list">
                  {product.platforms.map((p) => (
                    <li key={p.platform}>
                      <strong>{PLATFORMS[p.platform].label}</strong> —{" "}
                      {PLATFORM_SUPPORT[p.support].label}
                      {p.note && <span className="table__note">{p.note}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  Supported platforms have not been announced yet.
                </p>
              )}
              {product.requirements.length > 0 && (
                <>
                  <h3 className="feature-heading">Requirements</h3>
                  <ul className="feature-list feature-list--plain">
                    {product.requirements.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section aria-labelledby="dev-title" className="panel panel--quiet">
              <h2 id="dev-title">Development status</h2>
              <p>
                <strong>
                  {DEVELOPMENT_STATUS[product.developmentStatus].label}.
                </strong>{" "}
                {product.developmentNote}
              </p>
              {product.catalogueNotes.map((n) => (
                <p key={n} className="fine">
                  <IconInfo className="inline-icon" /> {n}
                </p>
              ))}
            </section>
          </div>
          <ReleasePanel catalogue={catalogue} product={product} />
        </div>
      </div>
    </>
  );
}
