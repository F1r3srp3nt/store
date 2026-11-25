import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useAccount } from "../account/account-context";
import { DOWNLOADS_NOT_AVAILABLE, downloadUrl, formatPrice, signInUrl, StoreApiError, storeApi, type EditionAccess } from "../account/api";
import { hcgRepoProductUrl } from "../config/runtime";
import type { Catalogue } from "../domain/catalogue";
import { currentRelease } from "../domain/model";
import type { Edition, Product } from "../domain/schema";
import { ACCESS_REQUIREMENTS, EDITION_CHANNELS, EDITION_TIERS, IDENTIFIER_KINDS, PLATFORMS, PRICING_MODELS } from "../domain/taxonomy";
import { IconArrowRight, IconCheck, IconDownload, IconInfo, IconLock, IconShield } from "./Icons";

type Loaded = { status: "loading" } | { status: "ok"; editions: EditionAccess[] } | { status: "unavailable"; message: string };

/**
 * Editions, price, ownership and availability for a product. Every value comes from the HCG Store
 * server; hiding or showing a button here is presentation only. The server checks again on every
 * checkout and download.
 */
export function AccessPanel({ catalogue, product }: { catalogue: Catalogue; product: Product }) {
  const { state: account } = useAccount();
  const [params] = useSearchParams();
  const location = useLocation();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const selected = params.get("edition");
  const released = !!currentRelease(catalogue, product);

  useEffect(() => {
    if (account.status === "loading") return;
    if (account.status === "no-server") {
      setLoaded({ status: "unavailable", message: "Sign-in and purchases are not available on this site." });
      return;
    }
    let live = true;
    storeApi
      .access(product.slug)
      .then((r) => live && setLoaded({ status: "ok", editions: r.editions }))
      .catch(() => live && setLoaded({ status: "unavailable", message: "Access could not be checked right now." }));
    return () => {
      live = false;
    };
  }, [product.slug, account]);

  const editions: (Edition | null)[] = product.editions.length ? product.editions : [null];
  const returnTo = location.pathname + location.search;

  return (
    <section className="panel access" aria-labelledby="access-title">
      <h2 id="access-title">{product.editions.length > 1 ? "Editions, price and availability" : "Price and availability"}</h2>
      <p className="access__summary">
        {released ? (
          <>
            <IconShield className="inline-icon" /> HCG has approved a release. Files are delivered only to signed-in HCG accounts that hold access.
          </>
        ) : (
          <>
            <IconInfo className="inline-icon" /> <strong>Coming soon.</strong> This page is product information only; nothing can be bought or downloaded yet.
          </>
        )}
      </p>
      {loaded.status === "unavailable" && (
        <p className="notice" role="note">
          <IconInfo className="inline-icon" /> {loaded.message} {DOWNLOADS_NOT_AVAILABLE}
        </p>
      )}
      <ul className="edition-list">
        {editions.map((e) => {
          const access = loaded.status === "ok" ? loaded.editions.find((a) => a.editionId === (e?.id ?? null)) : undefined;
          return (
            <EditionCard
              key={e?.id ?? "default"}
              product={product}
              edition={e}
              access={access}
              loading={loaded.status === "loading"}
              selected={!!e && e.id === selected}
              returnTo={returnTo}
              signInAvailable={account.status !== "no-server" && account.status !== "not-configured"}
              released={released}
            />
          );
        })}
      </ul>
      <p className="fine">
        Prices and ownership come from HCG Store's server. A purchase counts only after the payment provider confirms it to HCG Store; returning
        from checkout does not grant access by itself.
      </p>
    </section>
  );
}

function EditionCard({
  product,
  edition,
  access,
  loading,
  selected,
  returnTo,
  signInAvailable,
  released,
}: {
  product: Product;
  edition: Edition | null;
  access: EditionAccess | undefined;
  loading: boolean;
  selected: boolean;
  returnTo: string;
  signInAvailable: boolean;
  released: boolean;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "center" });
  }, [selected]);
  const repo = product.hcgRepo.find((l) => l.editionId === (edition?.id ?? null) || (l.editionId === null && product.editions.length <= 1));
  const offer = access?.offers[0];
  const state = access?.state;

  return (
    <li ref={ref} id={edition ? `edition-${edition.id}` : undefined} className={`edition${selected ? " edition--selected" : ""}${access?.owned ? " edition--owned" : ""}`}>
      <header className="edition__head">
        <div>
          <h3>{edition?.name ?? product.name}</h3>
          {edition && <p className="edition__channel">{EDITION_CHANNELS[edition.channel].label}</p>}
        </div>
        <OwnershipBadge access={access} loading={loading} signInAvailable={signInAvailable} />
      </header>
      {edition && (
        <>
          <p>{edition.summary}</p>
          <dl className="kv kv--compact">
            <div>
              <dt>Platforms</dt>
              <dd>{edition.platforms.map((p) => PLATFORMS[p].label).join(", ")}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{edition.status}</dd>
            </div>
            {edition.tier && (
              <div>
                <dt>Edition</dt>
                <dd>{EDITION_TIERS[edition.tier].label}</dd>
              </div>
            )}
            {edition.pricingModel !== "not-set" && (
              <div>
                <dt>Pricing model</dt>
                <dd>{PRICING_MODELS[edition.pricingModel].label}</dd>
              </div>
            )}
            {edition.access !== "unknown" && (
              <div>
                <dt>Access</dt>
                <dd>{ACCESS_REQUIREMENTS[edition.access].label}</dd>
              </div>
            )}
            {edition.identifiers.map((i) => (
              <div key={`${i.kind}:${i.value}`} className="kv__wide">
                <dt>{IDENTIFIER_KINDS[i.kind]}</dt>
                <dd className="mono break">{i.value}</dd>
              </div>
            ))}
            {edition.layouts.length > 0 && (
              <div className="kv__wide">
                <dt>Package layouts (declared, not published)</dt>
                <dd>
                  <ul className="plain-list">
                    {edition.layouts.map((l) => (
                      <li key={l.architecture}>
                        {l.label} <code>{l.architecture}</code>
                        {l.note && <span className="table__note">{l.note}</span>}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
          {edition.note && <p className="fine">{edition.note}</p>}
        </>
      )}

      <div className="edition__commerce">
        <p className="edition__price">
          <span className="visually-hidden">Price: </span>
          {offer ? (
            <>
              <strong>{formatPrice(offer)}</strong>
              {offer.testOnly && <span className="badge badge--test">Test mode</span>}
            </>
          ) : (
            <span className="muted">{access?.checkoutUnavailableReason ?? "Price not set"}</span>
          )}
        </p>
        <div className="edition__actions">
          {loading ? null : state === "owned" || state === "free" ? (
            <>
              {repo && edition?.channel === "jailbreak-package" ? (
                <a className="button button--primary" href={hcgRepoProductUrl(repo.key)}>
                  Get from HCG Repo <IconArrowRight />
                </a>
              ) : null}
            </>
          ) : state === "signed-out" || (!access && !loading && signInAvailable) ? (
            signInAvailable && (
              <a className="button button--ghost" href={signInUrl(returnTo)}>
                <IconLock /> Sign in to check access
              </a>
            )
          ) : access && access.offers.length > 0 ? (
            <BuyButton access={access} offerId={offer?.id ?? null} />
          ) : (
            <span className="status-note">{released ? "Not for sale yet" : "In development: not for sale"}</span>
          )}
          {repo && state !== "owned" && state !== "free" && (
            <a className="button button--ghost" href={hcgRepoProductUrl(repo.key)}>
              View on HCG Repo <IconArrowRight />
            </a>
          )}
        </div>
        {access?.message && state !== "signed-out" && <p className="edition__message">{access.message}</p>}
      </div>

      <Downloads access={access} />
    </li>
  );
}

function OwnershipBadge({ access, loading, signInAvailable }: { access: EditionAccess | undefined; loading: boolean; signInAvailable: boolean }) {
  if (loading) return <span className="badge badge--muted">Checking…</span>;
  switch (access?.state) {
    case "owned":
      return (
        <span className="badge badge--owned">
          <IconCheck /> Owned
        </span>
      );
    case "free":
      return <span className="badge badge--muted">Free with your HCG account</span>;
    case "not-owned":
      return <span className="badge badge--muted">Not owned</span>;
    case "not-for-sale":
      return <span className="badge badge--muted">Not for sale</span>;
    case "unavailable":
      return <span className="badge badge--muted">Access unknown</span>;
    default:
      return signInAvailable ? <span className="badge badge--muted">Sign in to check</span> : null;
  }
}

function BuyButton({ access, offerId }: { access: EditionAccess | undefined; offerId: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!access?.checkoutReady && !!offerId;
  const buy = async () => {
    if (!offerId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await storeApi.checkout(offerId);
      window.location.assign(r.redirectUrl);
    } catch (e) {
      setError(e instanceof StoreApiError ? e.message : "Checkout could not be started. Nothing was charged.");
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="button button--primary" disabled={!ready || busy} aria-describedby={ready ? undefined : `buy-reason-${offerId ?? "none"}`} onClick={buy}>
        {busy ? "Opening checkout…" : "Buy Product"}
      </button>
      {!ready && (
        <span id={`buy-reason-${offerId ?? "none"}`} className="edition__reason">
          {access?.checkoutUnavailableReason ?? "Checkout is not available yet."}
        </span>
      )}
      {error && (
        <span role="alert" className="edition__error">
          {error}
        </span>
      )}
    </>
  );
}

function Downloads({ access }: { access: EditionAccess | undefined }) {
  if (access?.downloadsAvailable && access.artifacts.length) {
    return (
      <ul className="edition__downloads" aria-label="Your downloads">
        {access.artifacts.map((a) => (
          <li key={a.id}>
            <a className="button button--ghost" href={downloadUrl(a.id)}>
              <IconDownload /> {a.fileName}
            </a>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p className="edition__downloads-unavailable">
      <IconInfo className="inline-icon" /> {DOWNLOADS_NOT_AVAILABLE}
    </p>
  );
}
