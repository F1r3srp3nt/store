import { useMemo } from "react";
import { useCatalogueState } from "../app/catalogue-context";
import { IconInfo, IconLink, IconLock, IconShield } from "../components/Icons";
import { PageMeta } from "../components/PageMeta";
import { runtimeConfig } from "../config/runtime";
import { createHcgConnectAdapter } from "../integrations/hcg-connect/adapter";
import { HCG_CONNECT_FIELDS, parseHcgConnectConfig } from "../integrations/hcg-connect/config";

export function AccountPage() {
  const adapter = useMemo(() => createHcgConnectAdapter(parseHcgConnectConfig(runtimeConfig.env, window.location.origin)), []);
  const cat = useCatalogueState();
  const source = cat.status === "error" ? cat.result.source : cat.source;
  const cfg = adapter.configuration;

  const configLabel = cfg.state === "not-configured" ? "HCG Connect not configured" : cfg.state === "invalid" ? "Configuration invalid" : "Configured — awaiting approved protocol";

  return (
    <>
      <PageMeta title="Account & Connections" description="Status of HCG Connect sign-in, catalogue source and download delivery for HCG Store." />
      <div className="page-width page-pad">
        <header className="page-head">
          <p className="eyebrow eyebrow--accent">Readiness</p>
          <h1>Account &amp; Connections</h1>
          <p className="page-head__lead">
            The real status of each connection behind HCG Store. Browsing the catalogue and using public downloads does not need an account.
          </p>
        </header>

        <div className="connections">
          <section className="panel connection" aria-labelledby="connect-title">
            <div className="connection__head">
              <IconLock />
              <div>
                <h2 id="connect-title">HCG Connect</h2>
                <p className="muted">Central HCG identity service</p>
              </div>
              <span className={`state-pill state-pill--${cfg.state}`}>{configLabel}</span>
            </div>

            <dl className="kv">
              <div>
                <dt>Configuration</dt>
                <dd>{configLabel}</dd>
              </div>
              <div>
                <dt>Authentication</dt>
                <dd>Unavailable: {adapter.authentication.state === "unavailable" ? adapter.authentication.reason : ""}</dd>
              </div>
              <div>
                <dt>App Access</dt>
                <dd>Not checked: {adapter.appAccess.state === "unavailable" ? adapter.appAccess.reason : ""}</dd>
              </div>
            </dl>

            <button type="button" className="button button--primary" disabled aria-describedby="signin-why">
              Sign in with HCG Connect
            </button>
            <p id="signin-why" className="fine">
              Sign-in is disabled. HCG Store does not simulate accounts or sessions. It will offer sign-in only after the founder approves the HCG
              Connect contract and its settings are configured.
            </p>

            {cfg.state === "invalid" && (
              <div className="callout callout--warn" role="alert">
                <p>
                  <strong>Configuration problems</strong>
                </p>
                <ul>
                  {cfg.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}

            <details className="guidance">
              <summary>Settings required before sign-in can be enabled</summary>
              <ul className="settings-list">
                {HCG_CONNECT_FIELDS.map((f) => {
                  const set = Boolean(runtimeConfig.env[f.key]?.trim());
                  return (
                    <li key={f.key}>
                      <span className={set ? "setting setting--set" : "setting setting--missing"}>{set ? "Set" : "Missing"}</span>
                      <span>
                        {f.label} <code className="break">{f.key}</code>
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="fine">These values are public configuration. Client secrets must never be added to this web app.</p>
            </details>
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
                : "The catalogue is a validated local seed file in this repository. HCG ERP remains the source of truth for products, releases, organisations, licences and App Access. This store will read from it once the registry contract exists."}
            </p>
            <p className="fine">Source: {source.label}</p>
            {cat.status === "error" && (
              <p className="callout callout--warn" role="alert">
                {cat.result.message}
              </p>
            )}
          </section>

          <section className="panel connection" aria-labelledby="delivery-title">
            <div className="connection__head">
              <IconShield />
              <div>
                <h2 id="delivery-title">Download delivery</h2>
                <p className="muted">Dropbox shared links</p>
              </div>
              <span className="state-pill state-pill--public">Public links</span>
            </div>
            <p>
              Approved releases are delivered from Dropbox shared-file links. These links are public: anyone who has one can download the file.
              Sign-in to HCG would not make a public file private.
            </p>
            <p className="fine">
              Private delivery for licensed or restricted software needs a backend that checks permissions before issuing a download. That is separate
              future work and is not part of this storefront.
            </p>
          </section>

          <section className="panel connection" aria-labelledby="restricted-title">
            <div className="connection__head">
              <IconInfo />
              <div>
                <h2 id="restricted-title">Restricted operations</h2>
                <p className="muted">Licences, organisations, administration</p>
              </div>
              <span className="state-pill state-pill--not-configured">Not available</span>
            </div>
            <p>
              HCG Store has no administration, licensing or purchase features. When they arrive, the HCG backend will enforce permissions. The browser
              never makes those decisions.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
