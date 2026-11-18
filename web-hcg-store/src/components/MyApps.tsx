import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { storeApi, type MyApp, type MyApps as MyAppsData } from "../account/api";
import { useCatalogueState } from "../app/catalogue-context";
import { findProductById } from "../domain/model";
import { IconArrowRight, IconCheck, IconInfo } from "./Icons";
import { ProductMark } from "./ProductArt";

/**
 * "My HCG apps": every HCG product registered for this account, and what HCG's central product-access API reports for
 * it. The Store's server asks HCG with the account's own token; nothing here is decided in the browser. Access is not
 * availability: an app can be owned and still not released, and every download is re-checked with HCG when requested.
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
          <span className="state-pill state-pill--owner">
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
              Confirmed by HCG for your account. Entitlement source: {data.ownerAccess.source}. It covers every registered HCG app, its editions and
              features. It is not a purchase, does not grant administrative roles, and does not make an unreleased app available.
            </p>
          )}
          {data.centralStatus !== "ok" && (
            <p className="notice" role="note">
              <IconInfo className="inline-icon" /> HCG could not confirm your access right now. Nothing has changed; try again shortly.
            </p>
          )}
          <ul className="my-apps__list">
            {data.apps.map((app) => (
              <MyAppRow key={app.centralProductId ?? app.storeProductId ?? app.name} app={app} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const STATUS: Record<MyApp["access"]["state"], string> = {
  owner: "Owner access — All features",
  licensed: "You have access",
  none: "Not owned",
  unknown: "Access unknown",
  "not-registered": "Not yet registered with HCG",
};

const HCG_RELEASE: Record<string, string> = {
  live: "Live",
  released: "Released",
  beta: "Beta",
  testing: "Testing",
  in_development: "In development",
  development: "In development",
  planned: "Planned",
};

function MonogramMark({ name }: { name: string }) {
  const letters = name
    .replace(/^HCG\s+/i, "")
    .split(/[\s:/-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span className="product-mark product-mark--sm" aria-hidden="true">
      <span className="product-mark__monogram">{letters || "HCG"}</span>
    </span>
  );
}

function MyAppRow({ app }: { app: MyApp }) {
  const cat = useCatalogueState();
  const product = app.storeProductId && cat.status === "ready" ? findProductById(cat.catalogue, app.storeProductId) : undefined;
  const entitled = app.access.state === "owner" || app.access.state === "licensed";
  const editions = app.access.editions === "all" ? (product?.editions.length ? product.editions.map((e) => e.name).join(" · ") + " (all)" : "All") : app.access.editions.join(" · ");
  const features =
    app.access.state === "owner"
      ? `All features${app.access.features.available.length ? `: ${app.access.features.available.join(", ")} enabled now` : ""}${app.access.features.notAvailable ? ` · ${app.access.features.notAvailable} not switched on yet` : ""}`
      : app.access.features.available.length
        ? app.access.features.available.join(", ")
        : null;
  return (
    <li className="my-app">
      {product ? <ProductMark product={product} size="sm" /> : <MonogramMark name={app.name} />}
      <div className="my-app__body">
        <div className="my-app__title">
          <h3>{app.name}</h3>
          <span className={`badge ${entitled ? "badge--owned" : "badge--muted"}`}>{STATUS[app.access.state]}</span>
        </div>
        <dl className="kv kv--compact">
          {entitled && (
            <div className="kv__wide">
              <dt>Editions</dt>
              <dd>{editions || "None"}</dd>
            </div>
          )}
          {features && (
            <div className="kv__wide">
              <dt>Features</dt>
              <dd>{features}</dd>
            </div>
          )}
          {app.access.source && (
            <div className="kv__wide">
              <dt>Entitlement source</dt>
              <dd>{app.access.source}</dd>
            </div>
          )}
          <div className="kv__wide">
            <dt>Release</dt>
            <dd>
              {app.hcgReleaseStatus ? `HCG: ${HCG_RELEASE[app.hcgReleaseStatus] ?? app.hcgReleaseStatus.replace(/_/g, " ")}` : "HCG: status not reported"}
              {" · "}
              {app.storeRelease === "released" ? "HCG Store: released" : app.storeRelease === "not-released" ? "HCG Store: not released yet" : "Not in HCG Store"}
            </dd>
          </div>
          <div className="kv__wide">
            <dt>Download</dt>
            <dd>
              {
                {
                  available: "Available",
                  "not-released": "Not released yet",
                  "not-in-store": "Not offered in HCG Store",
                  "not-registered": "Not available until HCG registers this app",
                  "not-available": "Downloads are not available yet",
                  "not-entitled": "Not included in your access",
                }[app.download]
              }
            </dd>
          </div>
        </dl>
        <div className="my-app__actions">
          {app.slug && (
            <Link className="button button--ghost button--small" to={`/apps/${app.slug}`}>
              Open <IconArrowRight />
            </Link>
          )}
          {app.download === "available" && app.slug && (
            <Link className="button button--primary button--small" to={`/apps/${app.slug}#downloads`}>
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
