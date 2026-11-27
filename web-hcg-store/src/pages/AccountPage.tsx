import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAccount } from "../account/account-context";
import { DOWNLOADS_NOT_AVAILABLE, signInUrl, storeApi, type Health } from "../account/api";
import { useCatalogueState } from "../app/catalogue-context";
import { IconInfo, IconLink, IconLock, IconShield, IconUser } from "../components/Icons";
import { MyApps } from "../components/MyApps";
import { runtimeConfig } from "../config/runtime";
import { listedProducts } from "../domain/model";
import { PageMeta } from "../components/PageMeta";

export function AccountPage() {
  const { state: account, signOut } = useAccount();
  const location = useLocation();
  const cat = useCatalogueState();
  const source = cat.status === "error" ? cat.result.source : cat.source;
  const [health, setHealth] = useState<Health | null | "unavailable">(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (account.status === "no-server") {
      setHealth("unavailable");
      return;
    }
    storeApi
      .health()
      .then(setHealth)
      .catch(() => setHealth("unavailable"));
  }, [account.status]);

  const h = health && health !== "unavailable" ? health : null;
  const anonymousNames = h && h.protectedDownloads !== "disabled" && cat.status === "ready"
    ? (h.anonymousFreeProducts ?? []).map((id) => listedProducts(cat.catalogue).find((p) => p.id === id)?.name).filter((n): n is string => !!n)
    : [];
  const { deployment } = runtimeConfig;
  const accountLabel =
    account.status === "signed-in"
      ? "Signed in"
      : account.status === "signed-out"
        ? "Signed out"
        : account.status === "not-configured"
          ? "HCG Connect not configured"
          : account.status === "no-server"
            ? "Account service not available on this site"
            : account.status === "loading"
              ? "Checking…"
              : "Status unknown";

  return (
    <>
      <PageMeta title="Account & Connections" description="Your HCG account in HCG Store, and the status of sign-in, purchases and protected downloads." />
      <div className="page-width page-pad">
        <header className="page-head">
          <p className="eyebrow eyebrow--accent">HCG account</p>
          <h1>Account &amp; Connections</h1>
          <p className="page-head__lead">
            HCG Store uses your HCG account through HCG Connect. Browsing needs no account, and some free releases download without one (each
            product page says so). Other downloads, your library and purchases use your HCG account.
          </p>
        </header>

        <div className="connections" id="store-status">
          <section className="panel connection" aria-labelledby="connect-title">
            <div className="connection__head">
              <IconUser />
              <div>
                <h2 id="connect-title">Your HCG account</h2>
                <p className="muted">Sign-in with HCG Connect, the central HCG identity service</p>
              </div>
              <span className={`state-pill state-pill--${account.status}`}>{accountLabel}</span>
            </div>

            {account.status === "signed-in" ? (
              <>
                <dl className="kv">
                  <div>
                    <dt>Signed in as</dt>
                    <dd>{account.profile?.displayName ?? account.user.name ?? account.user.email ?? "HCG account"}</dd>
                  </div>
                  {account.profile?.designation && (
                    <div>
                      <dt>Designation</dt>
                      <dd>{account.profile.designation}</dd>
                    </div>
                  )}
                  {account.user.email && (
                    <div>
                      <dt>E-mail</dt>
                      <dd>{account.user.email}</dd>
                    </div>
                  )}
                </dl>
                {account.centralCheckUnavailable && (
                  <p className="notice">
                    <IconInfo className="inline-icon" /> HCG Connect could not be reached to re-confirm your session. Protected actions will wait until it
                    can.
                  </p>
                )}
                <div className="button-row">
                  <Link to="/library" className="button button--primary">
                    Your library
                  </Link>
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={signingOut}
                    onClick={async () => {
                      setSigningOut(true);
                      await signOut();
                      setSigningOut(false);
                    }}
                  >
                    {signingOut ? "Signing out…" : "Sign out of HCG Store"}
                  </button>
                </div>
                <p className="fine">
                  Signing out ends your HCG Store session on this browser and any HCG Repo sign-in made from it. It does not sign you out of other HCG
                  apps: HCG Connect has no central sign-out yet.
                </p>
              </>
            ) : account.status === "signed-out" ? (
              <>
                {account.notice && <p className="notice">{account.notice}</p>}
                <a className="button button--primary" href={signInUrl(location.pathname)}>
                  <IconLock /> Sign in with HCG Connect
                </a>
                <p className="fine">You will be sent to HCG's sign-in page. HCG Store never sees your password.</p>
              </>
            ) : account.status === "not-configured" || account.status === "no-server" ? (
              <>
                <button type="button" className="button button--primary" disabled aria-describedby="signin-why">
                  Sign in with HCG Connect
                </button>
                <p id="signin-why" className="fine">
                  {account.status === "no-server"
                    ? "This site is served without HCG Store's account service yet, so sign-in is not available here."
                    : "HCG has not yet issued HCG Store's HCG Connect client, so sign-in is switched off. HCG Store never simulates accounts or sessions."}
                </p>
              </>
            ) : (
              <p className="muted">Checking your sign-in…</p>
            )}
          </section>

          <section className="panel connection" aria-labelledby="delivery-title">
            <div className="connection__head">
              <IconShield />
              <div>
                <h2 id="delivery-title">Purchases and downloads</h2>
                <p className="muted">Checked by HCG Store's server on every request</p>
              </div>
              <span className={`state-pill state-pill--${h && h.protectedDownloads !== "disabled" ? "signed-in" : "not-configured"}`}>
                {h?.protectedDownloads === "enabled" ? "Downloads enabled" : h?.protectedDownloads === "free-testing-only" ? "Free downloads on" : "Not available yet"}
              </span>
            </div>
            <dl className="kv">
              <div>
                <dt>Checkout</dt>
                <dd>{h ? (h.payments === "disabled" ? "Not available yet" : h.payments === "test-mode" ? "Test mode only: no real payments" : h.payments) : "Not available on this site"}</dd>
              </div>
              <div>
                <dt>Ownership</dt>
                <dd>
                  {h?.entitlementAuthority === "hcg-ecosystem"
                    ? "Checked with HCG"
                    : h?.entitlementAuthority === "test-ledger"
                      ? "Test ledger (test mode only)"
                      : "Not connected to HCG yet"}
                </dd>
              </div>
              <div>
                <dt>Downloads</dt>
                <dd>
                  {h?.protectedDownloads === "enabled"
                    ? "Free releases, and paid releases for their owners"
                    : h?.protectedDownloads === "free-testing-only"
                      ? "Free releases only"
                      : DOWNLOADS_NOT_AVAILABLE}
                </dd>
              </div>
              {anonymousNames.length > 0 && (
                <div>
                  <dt>Without an account</dt>
                  <dd>{anonymousNames.join(", ")}</dd>
                </div>
              )}
            </dl>
            <p className="fine">
              {anonymousNames.length > 0 ? `${anonymousNames.join(", ")}: free, with no HCG account needed. Other downloads need sign-in. ` : "Downloads need sign-in. "}
              Paid and licensed products also require ownership confirmed by HCG. HCG Store checks every download on its server; files are never
              published at public links.
            </p>
          </section>

          <section className="panel connection" aria-labelledby="catalogue-title">
            <div className="connection__head">
              <IconLink />
              <div>
                <h2 id="catalogue-title">Product catalogue</h2>
                <p className="muted">Product registry and approved release metadata</p>
              </div>
              <span className={`state-pill state-pill--${source.authority}`}>{source.authority === "central" ? "HCG ERP" : "Provisional local data"}</span>
            </div>
            <p>
              {source.authority === "central"
                ? "The catalogue is read from the HCG ERP product registry."
                : "The catalogue is a validated local file in this repository. HCG ERP remains the source of truth for products, releases and entitlements."}
            </p>
            <dl className="kv">
              <div>
                <dt>Catalogue source</dt>
                <dd>{source.authority === "central" ? "HCG ERP (central)" : "Provisional local catalogue"}</dd>
              </div>
              <div>
                <dt>Build</dt>
                <dd>
                  {deployment.deployEnv === "production" ? "Production" : deployment.deployEnv === "preview" ? "Preview (not indexed)" : "Local development (not indexed)"}
                </dd>
              </div>
            </dl>
            <p className="fine">Source: {source.label}</p>
            {cat.status === "error" && (
              <p className="callout callout--warn" role="alert">
                {cat.result.message}
              </p>
            )}
          </section>
        </div>
        {account.status === "signed-in" && <MyApps />}
        {account.status === "signed-in" && (
          <p className="fine">
            Publishing for HCG? The <Link to="/control-center">Control Center</Link> uploads and manages releases HCG lets you publish or approve.
          </p>
        )}
      </div>
    </>
  );
}
