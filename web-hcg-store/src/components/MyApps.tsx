import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { storeApi, type MyApp, type MyApps as MyAppsData } from "../account/api";
import { useCatalogueState } from "../app/catalogue-context";
import { findProductById } from "../domain/model";
import { IconArrowRight, IconCheck, IconInfo } from "./Icons";
import { ProductMark } from "./ProductArt";

/**
 * "My HCG apps": what HCG reports this account holds, per registered product. The Store's server reads it from HCG
 * (/library); nothing here is decided in the browser. Access shown here is not permission to download: every download
 * is re-checked with HCG at the moment it is requested, and unreleased apps have nothing to download.
 */
export function MyApps() {
  const [data, setData] = useState<MyAppsData | "error" | null>(null);
  useEffect(() => {
    storeApi.myApps().then(setData, () => setData("error"));
  }, []);

  return (
    <section className="panel my-apps" aria-labelledby="my-apps-title">
      <div className="my-apps__head">
        <h2 id="my-apps-title">My HCG apps</h2>
        {data && data !== "error" && data.ownerAccess && (
          <span className="state-pill state-pill--owner" title={`Source: ${data.ownerAccess.source}`}>
            <IconCheck /> {data.ownerAccess.label}
          </span>
        )}
      </div>
      {data === null && <p className="muted">Checking with HCG…</p>}
      {data === "error" && <p className="notice">Your apps could not be loaded right now. Try again shortly.</p>}
      {data && data !== "error" && (
        <>
          {data.ownerAccess && (
            <p className="fine">
              Confirmed by HCG. Source: {data.ownerAccess.source}. Owner access covers every HCG product and its customer features; it does not make an
              unreleased app downloadable, and staff permissions such as publishing are granted separately.
            </p>
          )}
          {data.centralStatus !== "ok" && (
            <p className="notice" role="note">
              <IconInfo className="inline-icon" /> HCG could not confirm your access right now. Nothing has changed; try again shortly.
            </p>
          )}
          <ul className="my-apps__list">
            {data.apps.map((app) => (
              <MyAppRow key={app.productId} app={app} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const STATUS: Record<MyApp["access"]["state"], string> = {
  owner: "Owner access",
  licensed: "You have access",
  none: "Not owned",
  unavailable: "Access unknown",
  "not-registered": "Not yet registered with HCG",
};

function MyAppRow({ app }: { app: MyApp }) {
  const cat = useCatalogueState();
  const product = cat.status === "ready" ? findProductById(cat.catalogue, app.productId) : undefined;
  if (!product) return null;
  const entitled = app.access.state === "owner" || app.access.state === "licensed";
  const editions = app.editions.length ? app.editions : [];
  const featureText = app.access.state === "owner" ? "All features" : app.access.allEditions ? "All editions and their features" : null;
  return (
    <li className="my-app">
      <ProductMark product={product} size="sm" />
      <div className="my-app__body">
        <div className="my-app__title">
          <h3>{product.name}</h3>
          <span className={`badge ${entitled ? "badge--owned" : "badge--muted"}`}>{STATUS[app.access.state]}</span>
        </div>
        <dl className="kv kv--compact">
          {editions.length > 0 && (
            <div className="kv__wide">
              <dt>Editions</dt>
              <dd>
                {editions.map((e) => `${e.name}${entitled && (app.access.allEditions || app.access.editionIds.includes(e.id)) ? " ✓" : ""}`).join(" · ")}
              </dd>
            </div>
          )}
          <div className="kv__wide">
            <dt>Features</dt>
            <dd>{featureText ?? (product.currentFeatures.length ? `${product.currentFeatures.length} listed on the product page` : "Not listed yet")}</dd>
          </div>
          {app.access.source && (
            <div className="kv__wide">
              <dt>Entitlement source</dt>
              <dd>{app.access.source}</dd>
            </div>
          )}
          <div className="kv__wide">
            <dt>Download</dt>
            <dd>
              {app.download === "not-released"
                ? "Not released yet"
                : app.download === "not-registered"
                  ? "Not available until HCG registers this app"
                  : app.download === "not-available"
                  ? "Downloads are not available yet"
                  : app.download === "available"
                    ? "Available"
                    : "Not included in your access"}
            </dd>
          </div>
        </dl>
        <div className="my-app__actions">
          <Link className="button button--ghost button--small" to={`/apps/${product.slug}`}>
            Open <IconArrowRight />
          </Link>
          {app.download === "available" && (
            <Link className="button button--primary button--small" to={`/apps/${product.slug}#downloads`}>
              Download
            </Link>
          )}
          {app.manage && (
            <a className="button button--ghost button--small" href={app.manage} rel="noopener">
              Manage in HCG
            </a>
          )}
        </div>
      </div>
    </li>
  );
}
