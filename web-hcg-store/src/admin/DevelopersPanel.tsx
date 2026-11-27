import { useCallback, useEffect, useState } from "react";
import { commerceApi, money, type Developer, type Overview, type SalesRow } from "./commerce-api";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const STEPS = ["not-started", "in-progress", "complete"] as const;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Third-party developers: who owns which product, commission agreements, and sales computed from HCG Store's purchase
 * records (never a second ledger). Automated payouts are not activated; payout eligibility says why.
 */
export function DevelopersPanel() {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => commerceApi.overview().then(setO).catch((e) => setError(errorText(e))), []);
  useEffect(() => { void load(); }, [load]);
  const act = async (f: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await f();
      setMsg({ ok: true, text: ok });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };
  if (error) return <div className="panel"><h2>Developers and sales</h2><p className="notice" role="alert">{error}</p></div>;
  if (!o) return <p className="muted">Loading…</p>;
  const manage = o.rights.manage;
  return (
    <div className="cc-stack" data-testid="developers-panel">
      <section className="panel">
        <p className="eyebrow">Third-party marketplace (prepared, payouts off)</p>
        <h2>Developers</h2>
        <p className="fine">Products without an owner are first-party Hakmi Capital Group products. Payout accounts, tax and identity checks are completed in HCG Payments; HCG Store only records their status.</p>
        {o.developers.length === 0 ? <p className="muted">No third-party developer yet.</p> : (
          <div className="cc-table-wrap"><table className="cc-table"><thead><tr><th>Developer</th><th>Status</th><th>Payout account</th><th>Tax</th><th>Identity</th><th>Products</th></tr></thead>
            <tbody>{o.developers.map((d) => (
              <tr key={d.id}><td>{d.displayName} <code>{d.id}</code></td><td>{d.status}</td><td>{d.onboarding.payoutAccount}</td><td>{d.onboarding.tax}</td><td>{d.onboarding.identity}</td>
                <td>{o.ownership.filter((x) => x.developerId === d.id).map((x) => x.productId).join(", ") || "—"}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        {manage && <DeveloperForm onSave={(id, d) => act(() => commerceApi.saveDeveloper(id, d), `Saved developer ${id}.`)} />}
      </section>

      <section className="panel">
        <h2>Product ownership</h2>
        <div className="cc-table-wrap"><table className="cc-table"><thead><tr><th>Product</th><th>Owner</th></tr></thead>
          <tbody>{o.products.map((p) => {
            const owner = o.ownership.find((x) => x.productId === p.id)?.developerId ?? "";
            return (
              <tr key={p.id}><td>{p.name}</td><td>
                <select value={owner} disabled={!manage} aria-label={`Owner of ${p.name}`} onChange={(e) => void act(() => commerceApi.setOwnership(p.id, e.target.value || null), `Owner of ${p.name} updated.`)}>
                  <option value="">Hakmi Capital Group (first party)</option>
                  {o.developers.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
                </select>
              </td></tr>
            );
          })}</tbody>
        </table></div>
      </section>

      <section className="panel">
        <h2>Commission agreements</h2>
        <p className="fine">HCG's commission on net sales (after refunds and disputes). Agreements are never edited: add a new one and end the old one.</p>
        {o.agreements.length === 0 ? <p className="muted">No agreement yet.</p> : (
          <div className="cc-table-wrap"><table className="cc-table"><thead><tr><th>Developer</th><th>Commission</th><th>From</th><th>To</th><th>Status</th><th /></tr></thead>
            <tbody>{o.agreements.map((a) => (
              <tr key={a.id}><td>{a.developerId}</td><td>{(a.commissionBps / 100).toFixed(2)} %</td><td>{day(a.effectiveFrom)}</td><td>{a.effectiveTo ? day(a.effectiveTo) : "open"}</td><td>{a.status}</td>
                <td>{manage && a.status === "active" && <button type="button" className="button button--ghost button--small" onClick={() => void act(() => commerceApi.endAgreement(a.id), "Agreement ended.")}>End</button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        {manage && o.developers.length > 0 && <AgreementForm developers={o.developers} onSave={(a) => act(() => commerceApi.addAgreement(a), "Agreement added.")} />}
      </section>

      <SalesReport />
      {msg && <p className={`notice${msg.ok ? " notice--ok" : ""}`} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
    </div>
  );
}

function DeveloperForm({ onSave }: { onSave: (id: string, d: { displayName: string; status: string; onboarding: Developer["onboarding"] }) => Promise<void> }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState("draft");
  const [ob, setOb] = useState<Developer["onboarding"]>({ payoutAccount: "not-started", tax: "not-started", identity: "not-started" });
  return (
    <details className="cc-form">
      <summary>Add or update a developer</summary>
      <div className="cc-grid">
        <label className="cc-field"><span>Developer ID</span><input value={id} placeholder="e.g. nova-labs" onChange={(e) => setId(e.target.value.trim())} /></label>
        <label className="cc-field"><span>Display name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="cc-field"><span>Status</span><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="draft">Draft</option><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
        {(["payoutAccount", "tax", "identity"] as const).map((k) => (
          <label key={k} className="cc-field"><span>{k === "payoutAccount" ? "Payout account (HCG Payments)" : k === "tax" ? "Tax details" : "Identity verification"}</span>
            <select value={ob[k]} onChange={(e) => setOb({ ...ob, [k]: e.target.value })}>{STEPS.map((s) => <option key={s} value={s}>{s.replace("-", " ")}</option>)}</select>
          </label>
        ))}
      </div>
      <button type="button" className="button button--primary button--small" disabled={!id || name.length < 2} onClick={() => void onSave(id, { displayName: name, status, onboarding: ob })}>Save developer</button>
    </details>
  );
}

function AgreementForm({ developers, onSave }: { developers: Developer[]; onSave: (a: { developerId: string; commissionBps: number; effectiveFrom: number; effectiveTo: number | null; note: string | null }) => Promise<void> }) {
  const [dev, setDev] = useState(developers[0]!.id);
  const [pct, setPct] = useState("20");
  const [from, setFrom] = useState(day(Date.now()));
  const [note, setNote] = useState("");
  return (
    <details className="cc-form">
      <summary>Add a commission agreement</summary>
      <div className="cc-grid">
        <label className="cc-field"><span>Developer</span><select value={dev} onChange={(e) => setDev(e.target.value)}>{developers.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}</select></label>
        <label className="cc-field"><span>HCG commission (%)</span><input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} /></label>
        <label className="cc-field"><span>Effective from</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="cc-field cc-field--wide"><span>Note (reference to the signed agreement)</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <button type="button" className="button button--primary button--small" onClick={() => void onSave({ developerId: dev, commissionBps: Math.round(Number(pct) * 100), effectiveFrom: Date.parse(`${from}T00:00:00Z`), effectiveTo: null, note: note || null })}>Add agreement</button>
    </details>
  );
}

function SalesReport() {
  const [rows, setRows] = useState<SalesRow[] | null>(null);
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const to = Date.now() + 1;
    commerceApi.sales(to - 90 * 86400_000, to).then((r) => { setRows(r.rows); setSource(r.source); }).catch((e) => setError(errorText(e)));
  }, []);
  return (
    <section className="panel" aria-labelledby="sales-title">
      <h2 id="sales-title">Sales, refunds and payout eligibility (last 90 days)</h2>
      {error && <p className="notice" role="alert">{error}</p>}
      <p className="fine">{source}</p>
      {rows === null ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted">No purchases in this period.</p> : (
        <div className="cc-table-wrap"><table className="cc-table" data-testid="sales-table">
          <thead><tr><th>Seller</th><th>Mode</th><th>Purchases</th><th>Gross</th><th>Refunded</th><th>Disputed</th><th>Net</th><th>HCG commission</th><th>Developer share</th><th>Payout</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={`${r.developerId}-${r.currency}-${r.test}`}>
              <td>{r.developerName}</td><td>{r.test ? "TEST" : "Live"}</td>
              <td>{r.purchases} ({Object.entries(r.byChannel).map(([k, v]) => `${v} ${k === "package-manager" ? "Sileo/Zebra" : "website"}`).join(", ")})</td>
              <td>{money(r.gross, r.currency)}</td><td>{money(r.refunded, r.currency)}</td><td>{money(r.disputed, r.currency)}</td><td>{money(r.net, r.currency)}</td>
              <td>{money(r.commission, r.currency)}</td><td>{r.developerId ? money(r.developerShare, r.currency) : "—"}</td>
              <td><b>Not eligible</b><ul className="fine">{r.payout.reasons.map((x) => <li key={x}>{x}</li>)}</ul></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}
