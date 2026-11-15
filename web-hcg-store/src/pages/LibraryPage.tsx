import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAccount } from "../account/account-context";
import { DOWNLOADS_NOT_AVAILABLE, formatPrice, signInUrl, StoreApiError, storeApi, type Library } from "../account/api";
import { IconCheck, IconInfo, IconLock } from "../components/Icons";
import { PageMeta } from "../components/PageMeta";

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

function LibraryContent({ data }: { data: Library }) {
  return (
    <>
      {data.ownershipUnavailable && (
        <p className="notice" role="note">
          <IconInfo className="inline-icon" /> HCG could not confirm everything you own right now. Nothing has changed; try again shortly.
        </p>
      )}
      <section className="panel" aria-labelledby="owned-title">
        <h2 id="owned-title">Owned products</h2>
        {data.owned.length ? (
          <ul className="library-list">
            {data.owned.map((o) => (
              <li key={`${o.productId}:${o.editionId ?? ""}`} className="library-item">
                <span className="badge badge--owned">
                  <IconCheck /> Owned
                </span>
                <Link to={`/apps/${o.slug}${o.editionId ? `?edition=${encodeURIComponent(o.editionId)}` : ""}`} className="library-item__name">
                  {o.editionName ?? o.name}
                </Link>
                <span className="library-item__state">{o.state === "downloads-available" ? "Downloads available on the product page" : DOWNLOADS_NOT_AVAILABLE}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Your HCG account does not own any products yet.</p>
        )}
      </section>

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
    </>
  );
}
