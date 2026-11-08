import { Link, useParams } from "react-router-dom";
import { CatalogueGate } from "../app/catalogue-context";
import { AvailabilityBadge, PlatformChips, StatusBadge } from "../components/Badges";
import { IconArrowLeft, IconInfo } from "../components/Icons";
import { MediaImage } from "../components/MediaImage";
import { PageMeta } from "../components/PageMeta";
import { ProductTile } from "../components/ProductTile";
import { ReleasePanel } from "../components/Release";
import type { Catalogue } from "../domain/catalogue";
import { availability, findProductBySlug } from "../domain/model";
import type { Product } from "../domain/schema";
import { CATEGORIES, DEVELOPMENT_STATUS, PLATFORMS, PLATFORM_SUPPORT } from "../domain/taxonomy";
import { NotFoundContent } from "./NotFoundPage";

export function ProductPage() {
  const { slug = "" } = useParams();
  return (
    <CatalogueGate>
      {(c) => {
        const product = findProductBySlug(c, slug);
        return product ? <ProductDetail catalogue={c} product={product} /> : <NotFoundContent what="product" />;
      }}
    </CatalogueGate>
  );
}

function ProductDetail({ catalogue, product }: { catalogue: Catalogue; product: Product }) {
  const avail = availability(catalogue, product);
  return (
    <>
      <PageMeta title={product.name} description={product.summary} />
      <div className="page-width page-pad">
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <ol>
            <li>
              <Link to="/apps">
                <IconArrowLeft /> Browse apps
              </Link>
            </li>
            <li>
              <Link to={`/apps?category=${product.category}`}>{CATEGORIES[product.category].label}</Link>
            </li>
            <li aria-current="page">{product.name}</li>
          </ol>
        </nav>

        <header className="product-hero">
          <div className="product-hero__art">
            <ProductTile product={product} size="hero" />
            <span className="art-label">Generated tile</span>
          </div>
          <div className="product-hero__copy">
            <p className="eyebrow eyebrow--accent">{CATEGORIES[product.category].label}</p>
            <h1>{product.name}</h1>
            <p className="product-hero__summary">{product.summary}</p>
            <div className="product-hero__badges">
              <StatusBadge status={product.developmentStatus} />
              <AvailabilityBadge availability={avail} />
            </div>
            <PlatformChips platforms={product.platforms} />
          </div>
        </header>

        <div className="product-layout">
          <div className="product-main">
            <section aria-labelledby="about-title" className="panel">
              <h2 id="about-title">About</h2>
              {product.description.map((d, i) => (
                <p key={i}>{d}</p>
              ))}
            </section>

            <section aria-labelledby="dev-title" className="panel">
              <h2 id="dev-title">Development status</h2>
              <p>
                <StatusBadge status={product.developmentStatus} />
              </p>
              {product.developmentNote && <p>{product.developmentNote}</p>}
              <p className="fine">
                Development status describes the product's progress. It is separate from release availability, which is shown in the release panel.
              </p>
            </section>

            <section aria-labelledby="platforms-title" className="panel">
              <h2 id="platforms-title">Platforms</h2>
              {product.platforms.length ? (
                <div className="table-wrap">
                  <table className="table table--stack">
                    <thead>
                      <tr>
                        <th scope="col">Platform</th>
                        <th scope="col">Support</th>
                        <th scope="col">Architectures</th>
                        <th scope="col">Minimum OS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {product.platforms.map((p) => (
                        <tr key={p.platform}>
                          <th scope="row">{PLATFORMS[p.platform].label}</th>
                          <td data-label="Support">
                            {PLATFORM_SUPPORT[p.support].label}
                            {p.note && <span className="table__note">{p.note}</span>}
                          </td>
                          <td data-label="Architectures">{p.architectures.length ? p.architectures.join(", ") : <span className="muted">Not confirmed</span>}</td>
                          <td data-label="Minimum OS">{p.minimumOs ?? <span className="muted">Not verified</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">Supported platforms have not been stated yet.</p>
              )}
            </section>

            <section aria-labelledby="media-title" className="panel">
              <h2 id="media-title">Screenshots</h2>
              {product.media.length ? (
                <div className="gallery">
                  {product.media.map((m) => (
                    <figure key={m.src} className="gallery__item">
                      <div className="gallery__frame">
                        <MediaImage media={m} sizes="(max-width: 1000px) 92vw, 760px" />
                      </div>
                      <figcaption>
                        <span className={`art-tag art-tag--${m.kind}`}>{m.kind === "screenshot" ? "Screenshot" : "Concept artwork — not the working app"}</span> {m.caption}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              ) : (
                <p className="muted">
                  No screenshots have been supplied. The tile shown above is generated artwork, not a screenshot or an official product icon.
                </p>
              )}
            </section>

            {product.catalogueNotes.length > 0 && (
              <section aria-labelledby="notes-title" className="panel panel--note">
                <h2 id="notes-title">
                  <IconInfo className="inline-icon" /> Catalogue notes
                </h2>
                <ul>
                  {product.catalogueNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </section>
            )}

            <section aria-labelledby="record-title" className="panel panel--quiet">
              <h2 id="record-title">Catalogue record</h2>
              <dl className="kv kv--compact">
                <div>
                  <dt>Catalogue ID</dt>
                  <dd className="mono">{product.id}</dd>
                </div>
                <div>
                  <dt>Registry status</dt>
                  <dd>{product.registry.status === "central" ? "Central HCG ERP registry" : "Provisional (awaiting HCG ERP registry)"}</dd>
                </div>
                <div>
                  <dt>Central registry ID</dt>
                  <dd className="mono">{product.registry.centralId ?? <span className="muted">Not assigned</span>}</dd>
                </div>
                <div>
                  <dt>Status label</dt>
                  <dd>{DEVELOPMENT_STATUS[product.developmentStatus].label}</dd>
                </div>
              </dl>
            </section>
          </div>
          <ReleasePanel catalogue={catalogue} product={product} />
        </div>
      </div>
    </>
  );
}
