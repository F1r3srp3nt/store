import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { StoreApiError } from "../account/api";
import { adminApi, type AdminProduct, type DraftMetadata, type Me, type ProductDetail } from "./admin-api";
import { PLATFORM_NAMES } from "./formats";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

/**
 * Product Manager. Listed products come from HCG's catalogue (HCG ERP is the source of truth): here they show their
 * platforms, editions and the current release of every distribution target. Store draft products are edited here,
 * with revisions so two clients never overwrite each other.
 */
export function ProductsPanel({ me, productId, onSelect, onUpload, onReleases }: {
  me: Me; productId: string | null; onSelect: (p: string | null) => void; onUpload: (p: string) => void; onReleases: (p: string) => void;
}) {
  const [products, setProducts] = useState<AdminProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => adminApi.products("review").then((r) => setProducts(r.products)).catch((e) => setError(errorText(e))), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="cc-products">
      <aside className="panel cc-products__list" aria-label="Products">
        <h2>Products</h2>
        {error && <p className="notice" role="alert">{error}</p>}
        {products === null ? <p className="muted">Loading…</p> : products.length === 0 ? (
          <p className="muted">No product is listed for this account.</p>
        ) : (
          <ul className="cc-list">{products.map((p) => (
            <li key={p.id}><button type="button" className={`cc-listbtn${p.id === productId ? " is-active" : ""}`} onClick={() => onSelect(p.id)}>
              <span>{p.title}</span><span className={`badge badge--${p.source === "draft" ? "planned" : "muted"}`}>{p.source === "draft" ? "Draft" : "Listed"}</span>
            </button></li>
          ))}</ul>
        )}
      </aside>
      <div className="cc-products__detail">
        {productId ? <ProductDetailView key={productId} me={me} productId={productId} onUpload={onUpload} onReleases={onReleases} onSaved={() => void load()} /> : (
          <div className="panel"><h2>Choose a product</h2><p>Select a product to see its platforms, editions and the current release of each platform. New products are created with <b>Upload application → Add new product</b>.</p></div>
        )}
      </div>
    </div>
  );
}

function ProductDetailView({ me, productId, onUpload, onReleases, onSaved }: { me: Me; productId: string; onUpload: (p: string) => void; onReleases: (p: string) => void; onSaved: () => void }) {
  const [p, setP] = useState<ProductDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { adminApi.product(productId).then(setP).catch((e) => setError(errorText(e))); }, [productId]);
  if (error) return <p className="notice" role="alert">{error}</p>;
  if (!p) return <p className="muted">Loading…</p>;
  return (
    <div className="cc-stack">
      <section className="panel">
        <p className="eyebrow">{p.source === "draft" ? "Store draft product" : "Listed product"}</p>
        <h2>{p.metadata.title}</h2>
        <p className="fine">{p.note}</p>
        <dl className="kv kv--compact">
          <div><dt>Product ID</dt><dd><code>{p.id}</code></dd></div>
          <div><dt>Central product</dt><dd>{p.centralId ? <code>{p.centralId}</code> : "Not registered with HCG"}</dd></div>
          <div><dt>Platforms</dt><dd>{p.metadata.platforms.map((x) => PLATFORM_NAMES[x] ?? x).join(", ") || "—"}</dd></div>
          <div><dt>Editions</dt><dd>{p.metadata.editions.map((e) => e.name).join(", ") || "—"}</dd></div>
          {p.revision !== null && <div><dt>Revision</dt><dd>{p.revision}</dd></div>}
          <div><dt>Releases</dt><dd>{Object.entries(p.releaseCounts).map(([k, v]) => `${v} ${k}`).join(" · ") || "none"}</dd></div>
        </dl>
        <div className="cc-actions">
          {me.permissions.submit && <button type="button" className="button button--primary button--small" onClick={() => onUpload(p.id)}>Add new update</button>}
          <button type="button" className="button button--ghost button--small" onClick={() => onReleases(p.id)}>Manage versions</button>
          {p.slug && <Link className="button button--ghost button--small" to={`/apps/${p.slug}`}>Open product page</Link>}
        </div>
      </section>
      <section className="panel">
        <h2>Current release of each platform</h2>
        {p.current.length === 0 ? <p className="muted">No release is current yet (nothing has been published from HCG Store).</p> : (
          <div className="cc-table-wrap"><table className="cc-table">
            <thead><tr><th>Edition</th><th>Platform</th><th>Architecture</th><th>Channel</th><th>Current release</th><th>Availability</th><th>Selected</th></tr></thead>
            <tbody>{p.current.map((c) => (
              <tr key={`${c.editionId}-${c.platform}-${c.arch}-${c.channel}`}><td>{c.editionId ?? "—"}</td><td>{PLATFORM_NAMES[c.platform] ?? c.platform}</td><td>{c.arch}</td><td>{c.channel}</td><td>{c.version} build {c.build}</td><td>{c.availability}</td><td>{new Date(c.selectedAt).toISOString().slice(0, 10)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {p.editable && me.permissions.submit && <DraftEditor product={p} onSaved={(x) => { setP(x); onSaved(); }} />}
    </div>
  );
}

function DraftEditor({ product, onSaved }: { product: ProductDetail; onSaved: (p: ProductDetail) => void }) {
  const m = product.metadata as DraftMetadata;
  const [f, setF] = useState({
    title: m.title, summary: m.summary, description: m.description.join("\n"), categories: m.categories.join(", "), platforms: m.platforms,
    editions: m.editions.map((e) => `${e.id}: ${e.name}`).join("\n"), documentationUrl: m.documentationUrl ?? "", supportUrl: m.supportUrl ?? "", visibility: m.visibility,
    requirements: m.systemRequirements.map((r) => `${r.platform}: ${r.minimumOs ?? ""}`).join("\n"),
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const saved = await adminApi.updateDraftProduct(product.id, {
        title: f.title, summary: f.summary, description: lines(f.description), categories: f.categories.split(",").map((x) => x.trim()).filter(Boolean),
        platforms: f.platforms, editions: lines(f.editions).map((l) => { const [id, ...n] = l.split(":"); return { id: id!.trim(), name: n.join(":").trim() || id!.trim() }; }),
        documentationUrl: f.documentationUrl.trim() || null, supportUrl: f.supportUrl.trim() || null, visibility: f.visibility,
        systemRequirements: lines(f.requirements).map((l) => { const [platform, ...os] = l.split(":"); return { platform: platform!.trim(), minimumOs: os.join(":").trim() || null, notes: [] }; }),
      }, product.revision!);
      onSaved(saved);
      setMsg("Saved.");
    } catch (e) {
      setMsg(e instanceof StoreApiError && e.code === "revision_conflict" ? "Someone changed this product in another window or app. Reload to see their change; nothing was overwritten." : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel cc-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2>Edit draft product</h2>
      <div className="cc-grid">
        <label className="cc-field"><span>Name</span><input aria-label="Name" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="cc-field"><span>Visibility</span><select aria-label="Visibility" value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}><option value="private">Private</option><option value="internal">Internal</option></select></label>
        <label className="cc-field cc-field--wide"><span>Summary</span><input aria-label="Summary" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></label>
        <label className="cc-field cc-field--wide"><span>Description (one paragraph per line)</span><textarea aria-label="Description (one paragraph per line)" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        <label className="cc-field"><span>Categories (comma separated)</span><input aria-label="Categories (comma separated)" value={f.categories} onChange={(e) => setF({ ...f, categories: e.target.value })} placeholder="developer-tools" /></label>
        <fieldset className="cc-field"><legend>Platforms</legend><div className="cc-checks">{Object.entries(PLATFORM_NAMES).map(([id, name]) => (
          <label key={id}><input type="checkbox" checked={f.platforms.includes(id)} onChange={(e) => setF({ ...f, platforms: e.target.checked ? [...f.platforms, id] : f.platforms.filter((x) => x !== id) })} /> {name}</label>
        ))}</div></fieldset>
        <label className="cc-field"><span>Editions (id: name, one per line)</span><textarea aria-label="Editions (id: name, one per line)" rows={2} value={f.editions} onChange={(e) => setF({ ...f, editions: e.target.value })} /></label>
        <label className="cc-field"><span>System requirements (platform: minimum OS)</span><textarea aria-label="System requirements (platform: minimum OS)" rows={2} value={f.requirements} onChange={(e) => setF({ ...f, requirements: e.target.value })} placeholder="windows: 10" /></label>
        <label className="cc-field"><span>Documentation (https)</span><input aria-label="Documentation (https)" value={f.documentationUrl} onChange={(e) => setF({ ...f, documentationUrl: e.target.value })} /></label>
        <label className="cc-field"><span>Support (https)</span><input aria-label="Support (https)" value={f.supportUrl} onChange={(e) => setF({ ...f, supportUrl: e.target.value })} /></label>
      </div>
      {msg && <p className="notice" role="status">{msg}</p>}
      <div className="cc-actions"><button className="button button--primary" disabled={busy}>{busy ? "Saving…" : "Save draft product"}</button><span className="fine">Revision {product.revision}. Saving checks that nobody changed it meanwhile.</span></div>
    </form>
  );
}
