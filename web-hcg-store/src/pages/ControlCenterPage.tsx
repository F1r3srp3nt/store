import { useLocation, useSearchParams } from "react-router-dom";
import { signInUrl } from "../account/api";
import { DevelopersPanel } from "../admin/DevelopersPanel";
import { PaymentProviderStudio } from "../admin/PaymentProviderStudio";
import { ProductsPanel } from "../admin/ProductsPanel";
import { ReleasesPanel } from "../admin/ReleasesPanel";
import { UploadPanel } from "../admin/UploadPanel";
import { useAdminMe } from "../admin/useAdminMe";
import { IconInfo, IconLock, IconShield } from "../components/Icons";
import { PageMeta } from "../components/PageMeta";

const TABS = [
  { id: "upload", label: "Upload application" },
  { id: "releases", label: "Releases" },
  { id: "products", label: "Products" },
  { id: "payments", label: "Payment provider" },
  { id: "developers", label: "Developers & sales" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/**
 * HCG Store Control Center: uploads, release lifecycle and product drafts, for the people HCG grants HCG Store's
 * publishing, approval or publication permission. The page only shows controls; HCG Store authorises every request
 * on the server with HCG's central permissions (a hidden button or a changed page grants nothing).
 */
export function ControlCenterPage() {
  const admin = useAdminMe();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "upload") as Tab;
  const productId = params.get("product");
  const go = (next: Tab, extra: Record<string, string> = {}) => setParams({ tab: next, ...extra });

  return (
    <>
      <PageMeta title="Control Center" description="HCG Store administration." noindex />
      <div className="page-width page-pad cc">
        <header className="page-head">
          <p className="eyebrow eyebrow--accent">HCG Store administration</p>
          <h1>Control Center</h1>
          <p className="page-head__lead">Upload, validate, synchronize and distribute. One authoritative HCG Store for the website, HCG Executable Maker and HCG Store Manager.</p>
        </header>

        {admin.status === "loading" ? (
          <p className="muted">Checking your HCG permissions…</p>
        ) : admin.status === "signed-out" ? (
          <div className="panel">
            <h2><IconLock className="inline-icon" /> Sign in to administer HCG Store</h2>
            <p>Use the HCG account HCG has granted HCG Store permissions to.</p>
            <a className="button button--primary" href={signInUrl(location.pathname + location.search)}>Sign in with HCG Connect</a>
          </div>
        ) : admin.status === "disabled" ? (
          <p className="notice" role="note"><IconInfo className="inline-icon" /> Publishing is not enabled on this HCG Store.</p>
        ) : admin.status === "unavailable" ? (
          <p className="notice" role="alert"><IconInfo className="inline-icon" /> {admin.message}</p>
        ) : !admin.me.administrator ? (
          <div className="panel" data-testid="not-authorised">
            <h2><IconShield className="inline-icon" /> Not authorised</h2>
            <p>
              HCG has not granted this account an HCG Store permission (<code>store.publish</code>, <code>store.release.approve</code> or{" "}
              <code>store.release.publish</code> on <code>hcg.store</code>). Purchases, product ownership and HCG roles never grant them.
            </p>
          </div>
        ) : (
          <>
            <div className="cc-status" aria-label="Your HCG Store permissions">
              <span className={`cc-chip ${admin.me.publishingMode === "enabled" ? "cc-chip--on" : "cc-chip--warn"}`}>
                {admin.me.publishingMode === "enabled" ? "Publishing enabled" : "Private uploads only"}
              </span>
              <span className={`cc-chip ${admin.me.permissions.submit ? "cc-chip--on" : ""}`}>Upload and submit {admin.me.permissions.submit ? "✓" : "—"}</span>
              <span className={`cc-chip ${admin.me.permissions.approve ? "cc-chip--on" : ""}`}>Approve {admin.me.permissions.approve ? "✓" : "—"}</span>
              <span className={`cc-chip ${admin.me.permissions.publish ? "cc-chip--on" : ""}`}>Publish {admin.me.permissions.publish ? "✓" : "—"}</span>
              <span className="cc-chip" title={admin.me.devicePolicy.note}>Device policy: off</span>
              <span className="cc-chip">{admin.me.email ?? "Signed in"}</span>
            </div>
            {admin.me.publishingMode !== "enabled" && (
              <p className="notice" role="note">
                <IconInfo className="inline-icon" /> This HCG Store accepts private uploads only. Approval, publication, supersede, restore and every customer
                download stay switched off until they are separately approved.
              </p>
            )}
            <nav className="cc-tabs" role="tablist" aria-label="Control Center">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`cc-tab${tab === t.id ? " is-active" : ""}`} onClick={() => go(t.id, productId ? { product: productId } : {})}>
                  {t.label}
                </button>
              ))}
            </nav>
            <div role="tabpanel">
              {tab === "upload" ? (
                <UploadPanel me={admin.me} productId={productId} onOpenReleases={(p) => go("releases", p ? { product: p } : {})} />
              ) : tab === "releases" ? (
                <ReleasesPanel me={admin.me} productId={productId} onProduct={(p) => go("releases", p ? { product: p } : {})} />
              ) : tab === "payments" ? (
                <PaymentProviderStudio />
              ) : tab === "developers" ? (
                <DevelopersPanel />
              ) : (
                <ProductsPanel me={admin.me} productId={productId} onSelect={(p) => go("products", p ? { product: p } : {})} onUpload={(p) => go("upload", { product: p })} onReleases={(p) => go("releases", { product: p })} />
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
