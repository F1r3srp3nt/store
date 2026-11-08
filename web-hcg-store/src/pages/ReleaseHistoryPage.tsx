import { Link, useParams } from "react-router-dom";
import { CatalogueGate } from "../app/catalogue-context";
import { IconArrowLeft } from "../components/Icons";
import { PageMeta } from "../components/PageMeta";
import { ReleaseHistoryItem } from "../components/Release";
import { findProductBySlug, releaseHistory } from "../domain/model";
import { NotFoundContent } from "./NotFoundPage";

export function ReleaseHistoryPage() {
  const { slug = "" } = useParams();
  return (
    <CatalogueGate>
      {(c) => {
        const product = findProductBySlug(c, slug);
        if (!product) return <NotFoundContent what="product" />;
        const history = releaseHistory(c, product);
        return (
          <>
            <PageMeta title={`${product.name} release history`} description={`Versioned release information for ${product.name}.`} />
            <div className="page-width page-pad page-narrow">
              <nav aria-label="Breadcrumb" className="breadcrumb">
                <ol>
                  <li>
                    <Link to={`/apps/${product.slug}`}>
                      <IconArrowLeft /> {product.name}
                    </Link>
                  </li>
                  <li aria-current="page">Release history</li>
                </ol>
              </nav>
              <header className="page-head">
                <p className="eyebrow eyebrow--accent">Release history</p>
                <h1>{product.name}</h1>
                <p className="page-head__lead">
                  Releases are listed newest first by Semantic Versioning order. The current release is set explicitly by HCG. It is never
                  inferred from version numbers or dates.
                </p>
              </header>
              {history.length ? (
                <ol className="history">
                  {history.map((r) => (
                    <ReleaseHistoryItem key={r.id} catalogue={c} product={product} release={r} />
                  ))}
                </ol>
              ) : (
                <div className="empty">
                  <h2>No public release supplied</h2>
                  <p>HCG has not published any release of {product.name} to HCG Store yet.</p>
                  <Link className="button button--ghost" to={`/apps/${product.slug}`}>
                    Back to {product.name}
                  </Link>
                </div>
              )}
            </div>
          </>
        );
      }}
    </CatalogueGate>
  );
}
