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
import { ACCENT_RGB, ProductBanner, ProductMark } from "../components/ProductArt";
import { ReleasePanel } from "../components/Release";
import { hcgRepoProductUrl } from "../config/runtime";
import type { Catalogue } from "../domain/catalogue";
import { availability, currentRelease, findProductBySlug, relatedProductsOf, successorOf } from "../domain/model";
import type { Product } from "../domain/schema";
import {
  CATEGORIES,
  DEVELOPMENT_STATUS,
  PLATFORMS,
  PLATFORM_SUPPORT,
} from "../domain/taxonomy";
import { assetUrl } from "../lib/format";
import { NotFoundContent } from "./NotFoundPage";

export function ProductPage() {
  const { slug = "" } = useParams();
  return (
    <CatalogueGate>
      {(c) => {
        const found = findProductBySlug(c, slug);
        // Draft entries (named by HCG, not yet described) have no page.
        const product = found && found.visibility !== "draft" ? found : undefined;
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
      {/* The product's atmosphere is decoration behind the page; it never changes controls, prices or availability. */}
      <div
        className="page-width page-pad product-atmos"
        data-atmosphere={product.artwork.atmosphere}
        style={{ ["--card-accent-rgb" as string]: ACCENT_RGB[product.artwork.accent] }}
      >
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

        <ProductBanner product={product} />

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
                channel={currentRelease(catalogue, product)?.channel}
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
            {product.trailers.length > 0 && (
              <section aria-labelledby="trailer-title" className="product-gallery">
                <h2 id="trailer-title" className="visually-hidden">
                  Videos
                </h2>
                {product.trailers.map((t) => (
                  <figure key={t.src} className="gallery-strip__item">
                    <video
                      className="product-trailer"
                      src={assetUrl(t.src)}
                      poster={t.poster ? assetUrl(t.poster) : undefined}
                      controls
                      preload="none"
                      playsInline
                    />
                    <figcaption>
                      {t.kind === "concept" && (
                        <span className="art-tag art-tag--concept">
                          Concept video
                        </span>
                      )}{" "}
                      {t.title}
                    </figcaption>
                  </figure>
                ))}
              </section>
            )}

            {(screenshots.length > 0 || concepts.length > 0) && (
              <section
                aria-labelledby="gallery-title"
                className="product-gallery"
              >
                <h2 id="gallery-title" className="visually-hidden">
                  Screenshots
                </h2>
                {screenshots[0] && (
                  <figure className="gallery-lead">
                    <div className="product-cover product-cover--shot">
                      <div className="screen-frame">
                        <MediaImage
                          media={screenshots[0]}
                          sizes="(max-width: 1000px) 92vw, 760px"
                          // The banner is this page's priority image; without one, the lead screenshot is.
                          eager={!product.artwork.cover}
                        />
                      </div>
                      <span className="art-label">Screenshot</span>
                    </div>
                    <figcaption>{screenshots[0].caption}</figcaption>
                  </figure>
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
              {product.hardwareRequirements.length > 0 && (
                <>
                  <h3 className="feature-heading">Hardware</h3>
                  <ul className="feature-list feature-list--plain">
                    {product.hardwareRequirements.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </>
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

            <ProductResources catalogue={catalogue} product={product} />

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

/** Documentation, support and related HCG products, only where the catalogue states them. */
function ProductResources({
  catalogue,
  product,
}: {
  catalogue: Catalogue;
  product: Product;
}) {
  const related = relatedProductsOf(catalogue, product);
  if (!product.documentation.length && !product.support.length && !related.length) return null;
  return (
    <section aria-labelledby="resources-title" className="panel">
      <h2 id="resources-title">Documentation and support</h2>
      {[
        ["Documentation", product.documentation],
        ["Support", product.support],
      ].map(([label, links]) =>
        (links as Product["documentation"]).length ? (
          <div key={label as string}>
            <h3 className="feature-heading">{label as string}</h3>
            <ul className="feature-list feature-list--plain">
              {(links as Product["documentation"]).map((l) => (
                <li key={l.url}>
                  <a className="text-link" href={l.url} rel="noopener">
                    {l.label} <IconExternal />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {related.length > 0 && (
        <>
          <h3 className="feature-heading">Works with</h3>
          <ul className="feature-list feature-list--plain">
            {related.map((r) => (
              <li key={r.id}>
                <Link className="text-link" to={`/apps/${r.slug}`}>
                  {r.name}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
