import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAccount } from "../account/account-context";
import { DOWNLOADS_NOT_AVAILABLE, formatPrice, signInUrl, StoreApiError, storeApi, type Library, type PackageManager, type Receipt } from "../account/api";
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
                  <th scope="col">Bought in</th>
                  <th scope="col">Date</th>
                  <th scope="col">Receipt</th>
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
                    <td data-label="Bought in">{p.channel === "package-manager" ? "Sileo or Zebra (HCG Repo)" : "HCG Store website"}</td>
                    <td data-label="Date">
                      <time dateTime={new Date(p.createdAt).toISOString()}>{new Date(p.createdAt).toLocaleDateString("en-GB", { dateStyle: "medium" })}</time>
                    </td>
                    <td data-label="Receipt"><ReceiptButton id={p.id} /></td>
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

      {data.packageUpdates && data.packageUpdates.length > 0 && (
        <section className="panel" aria-labelledby="updates-title">
          <h2 id="updates-title">Package versions available to your account</h2>
          <ul className="plain-list" data-testid="package-updates">
            {data.packageUpdates.map((u) => (
              <li key={u.packageId}>
                <b>{u.name}</b> <code>{u.packageId}</code>: version {u.latestVersion}{" "}
                {u.eligible ? <span className="badge badge--released">Included</span> : <span className="badge badge--planned">Needs an upgrade purchase</span>}
              </li>
            ))}
          </ul>
          <p className="fine">Install or update from HCG Repo in Sileo or Zebra. HCG Store does not know which version is installed on your device.</p>
        </section>
      )}

      <PackageManagers initial={data.packageManagers ?? []} note={data.devicesNote} />
    </>
  );
}

const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { dateStyle: "medium" });

function ReceiptButton({ id }: { id: string }) {
  const [r, setR] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const toggle = () => {
    setOpen((x) => !x);
    if (!r) storeApi.receipt(id).then(setR).catch((e) => setError(e instanceof Error ? e.message : "The receipt could not be loaded."));
  };
  return (
    <div className="receipt">
      <button type="button" className="button button--ghost button--small" aria-expanded={open} onClick={toggle}>{open ? "Hide" : "View"}</button>
      {open && (
        <div className="receipt__body" role="region" aria-label={`Receipt ${id}`} data-testid="receipt">
          {error ? <p className="notice" role="alert">{error}</p> : !r ? <p className="muted">Loading…</p> : (
            <dl className="kv kv--compact">
              <div><dt>Receipt</dt><dd><code>{r.receiptNumber}</code></dd></div>
              <div><dt>Issued by</dt><dd>{r.issuedBy}</dd></div>
              <div><dt>Item</dt><dd>{r.item.title}</dd></div>
              <div><dt>Amount</dt><dd>{formatPrice({ unitAmount: r.amount, currency: r.currency, kind: "one-time", interval: null })}</dd></div>
              <div><dt>Purchased</dt><dd>{day(r.purchasedAt)}</dd></div>
              <div><dt>Bought in</dt><dd>{r.channel === "package-manager" ? "Sileo or Zebra (HCG Repo)" : "HCG Store website"}</dd></div>
              <div><dt>Refund</dt><dd>{r.refund === "none" ? "None" : r.refund === "refunded" ? `Refunded (${day(r.updatedAt)})` : "Disputed: access suspended"}</dd></div>
              <div><dt>Payment reference</dt><dd><code>{r.paymentReference}</code></dd></div>
              <div><dt>Note</dt><dd>{r.note}</dd></div>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Sileo and Zebra connections to this HCG account. Each is HCG Store's own credential (never your HCG Connect sign-in);
 * revoking one signs that package manager out at once and stops any download it had started.
 */
function PackageManagers({ initial, note }: { initial: PackageManager[]; note?: string }) {
  const [list, setList] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const active = list.filter((d) => d.status === "active");
  const run = (p: Promise<{ packageManagers: PackageManager[] }>, ok: string) =>
    p.then((r) => { setList(r.packageManagers); setMsg(ok); }).catch((e) => setMsg(e instanceof Error ? e.message : "That did not work. Try again."));
  return (
    <section className="panel panel--quiet" aria-labelledby="devices-title" data-testid="package-managers">
      <h2 id="devices-title">Package managers and devices</h2>
      {active.length ? (
        <div className="table-wrap">
          <table className="table table--stack">
            <thead><tr><th scope="col">App</th><th scope="col">Device</th><th scope="col">Connected</th><th scope="col">Last used</th><th scope="col" /></tr></thead>
            <tbody>
              {active.map((d) => (
                <tr key={d.ref}>
                  <th scope="row">{d.client}</th>
                  <td data-label="Device">{d.deviceModel ?? "Not reported"}</td>
                  <td data-label="Connected">{day(d.connectedAt)}</td>
                  <td data-label="Last used">{d.lastUsedAt ? day(d.lastUsedAt) : "—"}</td>
                  <td><button type="button" className="button button--ghost button--small" onClick={() => void run(storeApi.revokePackageManager(d.ref), `${d.client} on ${d.deviceModel ?? "that device"} is signed out.`)}>Sign out</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No package manager is connected to your HCG account.</p>
      )}
      {active.length > 1 && <button type="button" className="button button--ghost button--small" onClick={() => void run(storeApi.revokeAllPackageManagers(), "Every package manager is signed out.")}>Sign out every package manager</button>}
      {msg && <p className="notice" role="status">{msg}</p>}
      {list.some((d) => d.status !== "active") && (
        <details><summary>Ended connections</summary>
          <ul className="plain-list">{list.filter((d) => d.status !== "active").map((d) => <li key={d.ref}>{d.client}{d.deviceModel ? ` on ${d.deviceModel}` : ""}: {d.status}{d.endedAt ? ` ${day(d.endedAt)}` : ""}</li>)}</ul>
        </details>
      )}
      <p className="fine">Sign-in from Sileo or Zebra uses your HCG account, but the package manager only receives an HCG Store credential for this device. {note}</p>
    </section>
  );
}
