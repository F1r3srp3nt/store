import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAccount } from "../account/account-context";
import { DOWNLOADS_NOT_AVAILABLE, formatPrice, signInUrl, StoreApiError, storeApi, type Library } from "../account/api";
import { IconCheck, IconExternal, IconInfo, IconLock } from "../components/Icons";
import { hcgRepoProductUrl } from "../config/runtime";
import { EDITION_TIERS, type EditionTier } from "../domain/taxonomy";
import { PageMeta } from "../components/PageMeta";
import { ProductMark } from "../components/ProductArt";
import { useCatalogueState } from "../app/catalogue-context";
import { findProductById } from "../domain/model";

const PURCHASE_STATUS: Record<string, string> = {
  paid: "Paid",
  active: "Active subscription",
  canceled: "Cancelled — access until the end of the paid period",
  expired: "Expired",
  refunded: "Refunded — access removed",
  disputed: "Disputed — access suspended",
};

/** Owned products and purchase history. Requires sign-in; the server decides what is owned. */
export function LibraryPage() {
  const { state: account } = useAccount();
  const location = useLocation();
  const [lib, setLib] = useState<{ status: "loading" } | { status: "ok"; data: Library } | { status: "error"; message: string }>({ status: "loading" });

  useEffect(() => {
    if (account.status !== "signed-in") return;
    let live = true;
    storeApi
      .library()
      .then((data) => live && setLib({ status: "ok", data }))
      .catch((e) => live && setLib({ status: "error", message: e instanceof StoreApiError ? e.message : "Your library could not be loaded right now." }));
    return () => {
      live = false;
    };
  }, [account]);

  return (
    <>
      <PageMeta title="Your library" description="Products your HCG account owns, and your HCG Store purchases." />
      <div className="page-width page-pad">
        <header className="page-head">
          <p className="eyebrow eyebrow--accent">HCG account</p>
          <h1>Your library</h1>
          <p className="page-head__lead">Products your HCG account owns and your HCG Store purchase history, the same on every device you sign in on.</p>
        </header>

        {account.status === "loading" ? (
          <p className="muted">Checking your sign-in…</p>
        ) : account.status !== "signed-in" ? (
          <div className="panel">
            <h2>
              <IconLock className="inline-icon" /> Sign in to see your library
            </h2>
            {account.status === "no-server" || account.status === "not-configured" ? (
              <p>Sign-in with HCG Connect is not available on this site yet.</p>
            ) : (
              <>
                {account.status === "signed-out" && account.notice && <p className="notice">{account.notice}</p>}
                <p>Your library is private to your HCG account.</p>
                <a className="button button--primary" href={signInUrl(location.pathname)}>
                  Sign in with HCG Connect
                </a>
              </>
            )}
          </div>
        ) : lib.status === "loading" ? (
          <p className="muted">Loading your library…</p>
        ) : lib.status === "error" ? (
          <p className="notice" role="alert">
            {lib.message}
          </p>
        ) : (
          <LibraryContent data={lib.data} />
        )}
      </div>
    </>
  );
}

/** The owned product's icon, from the catalogue (the one place product artwork is defined). */
function OwnedProductMark({ productId }: { productId: string }) {
  const state = useCatalogueState();
  const product = state.status === "ready" ? findProductById(state.catalogue, productId) : undefined;
  return product ? <ProductMark product={product} size="sm" /> : null;
}

function LibraryContent({ data }: { data: Library }) {
  return (
    <>
      {data.ownershipUnavailable && (
        <p className="notice" role="note">
          <IconInfo className="inline-icon" /> HCG could not confirm everything you own right now. Nothing has changed; try again shortly.
        </p>
      )}
      <section className="panel" aria-labelledby="owned-title">
        <h2 id="owned-title">Your products</h2>
        {data.owned.length ? (
          <ul className="library-list">
            {data.owned.map((o) => (
              <li key={`${o.productId}:${o.editionId ?? ""}`} className="library-item">
                <OwnedProductMark productId={o.productId} />
                <span className="badge badge--owned">
                  <IconCheck /> {o.acquisition === "free" ? "Free" : "Owned"}
                </span>
                <Link to={`/apps/${o.slug}${o.editionId ? `?edition=${encodeURIComponent(o.editionId)}` : ""}`} className="library-item__name">
                  {o.editionName ?? o.name}
                </Link>
                <span className="library-item__state">{o.state === "downloads-available" ? "Downloads available on the product page" : DOWNLOADS_NOT_AVAILABLE}</span>
                <dl className="kv kv--compact library-item__facts">
                  {o.licence && (
                    <div>
                      <dt>Licence</dt>
                      <dd>{o.licence}</dd>
                    </div>
                  )}
                  {o.tier && o.tier in EDITION_TIERS && (
                    <div>
                      <dt>Edition</dt>
                      <dd>{EDITION_TIERS[o.tier as EditionTier].label}</dd>
                    </div>
                  )}
                  {o.currentRelease !== undefined && (
                    <div>
                      <dt>Current release</dt>
                      <dd>{o.currentRelease ? `${o.currentRelease.version} (${o.currentRelease.channel})` : "Not released yet"}</dd>
                    </div>
                  )}
                </dl>
                {o.hcgRepoKey && (
                  <a className="text-link library-item__repo" href={hcgRepoProductUrl(o.hcgRepoKey)}>
                    Install with Sileo via HCG Repo <IconExternal />
                  </a>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Your HCG account does not own any products yet.</p>
        )}
      </section>

      {data.subscriptions && (
        <section className="panel" aria-labelledby="subs-title">
          <h2 id="subs-title">Subscriptions</h2>
          {data.subscriptions.length ? (
            <ul className="plain-list">
              {data.subscriptions.map((p) => (
                <li key={p.id}>
                  {p.title}: {PURCHASE_STATUS[p.status] ?? p.status}
                  {p.currentPeriodEnd ? ` · current period ends ${new Date(p.currentPeriodEnd).toLocaleDateString("en-GB", { dateStyle: "medium" })}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No active subscriptions.</p>
          )}
        </section>
      )}

      <section className="panel" aria-labelledby="purchases-title">
        <h2 id="purchases-title">Purchase history</h2>
        {data.purchases.length ? (
          <div className="table-wrap">
            <table className="table table--stack">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col">Price</th>
                  <th scope="col">Status</th>
                  <th scope="col">Date</th>
                </tr>
              </thead>
              <tbody>
                {data.purchases.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">
                      {p.title} {p.testOnly && <span className="badge badge--test">Test mode</span>}
                    </th>
                    <td data-label="Price">{formatPrice({ unitAmount: p.amount, currency: p.currency, kind: p.kind as "one-time", interval: null })}</td>
                    <td data-label="Status">{PURCHASE_STATUS[p.status] ?? p.status}</td>
                    <td data-label="Date">
                      <time dateTime={new Date(p.createdAt).toISOString()}>{new Date(p.createdAt).toLocaleDateString("en-GB", { dateStyle: "medium" })}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No purchases yet.</p>
        )}
      </section>

      {data.invoices && (
        <section className="panel panel--quiet" aria-labelledby="invoices-title">
          <h2 id="invoices-title">Invoices</h2>
          <p className="muted">{data.invoices.available ? "" : data.invoices.message}</p>
        </section>
      )}

      {data.devices && (
        <section className="panel panel--quiet" aria-labelledby="devices-title">
          <h2 id="devices-title">Connected devices</h2>
          {data.devices.length ? (
            <ul className="plain-list">
              {data.devices.map((d, i) => (
                <li key={i}>
                  {d.label}, connected {new Date(d.connectedAt).toLocaleDateString("en-GB", { dateStyle: "medium" })}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No package manager is connected to your HCG account.</p>
          )}
          {data.devicesNote && <p className="fine">{data.devicesNote}</p>}
        </section>
      )}
    </>
  );
}
