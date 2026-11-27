import { useCallback, useEffect, useMemo, useState } from "react";
import { commerceApi, money, type Channel, type Health, type Overview, type Preview, type ProviderProfile } from "./commerce-api";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const ARCHES = ["iphoneos-arm64", "iphoneos-arm", "iphoneos-arm64e"] as const;
const AVAILABILITY: Record<ProviderProfile["availability"], string> = {
  disabled: "Disabled: no package manager can use HCG Store",
  internal: "Internal testing: the Founder and HCG Store staff only",
  public: "Public: every HCG account (needs the server's founder approval)",
};

/**
 * Payment Provider Studio: HCG Store as HCG Repo's payment provider for Sileo and Zebra. Branding, sign-in text,
 * availability, repositories, protocol and payment mode; a live health inspector; the exact responses Sileo receives;
 * and each repository package's distribution channel. Live payments and public availability stay gated by the server.
 */
export function PaymentProviderStudio() {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => commerceApi.overview().then((x) => { setO(x); setError(null); }).catch((e) => setError(errorText(e))), []);
  useEffect(() => { void load(); }, [load]);
  if (error && !o) return <div className="panel" data-testid="studio-error"><h2>Payment Provider Studio</h2><p className="notice" role="alert">{error}</p></div>;
  if (!o) return <p className="muted">Loading the payment provider…</p>;
  const eff = o.effective;
  return (
    <div className="cc-stack" data-testid="payment-provider-studio">
      <section className="panel">
        <p className="eyebrow">Sileo and Zebra payment provider</p>
        <h2>Payment Provider Studio</h2>
        <div className="cc-status" aria-label="What is in force">
          <span className={`cc-chip ${eff.availability === "disabled" ? "" : eff.availability === "internal" ? "cc-chip--warn" : "cc-chip--on"}`} data-testid="studio-availability">
            {eff.availability === "disabled" ? "Disabled" : eff.availability === "internal" ? "Internal testing" : "Public"}
          </span>
          <span className={`cc-chip ${eff.paymentMode === "test" ? "cc-chip--warn" : ""}`}>Payments: {eff.paymentMode === "test" ? "TEST (no money moves)" : "off"}</span>
          <span className="cc-chip">Live payments: not available</span>
          <span className={`cc-chip ${o.gates.protectedDownloads ? "cc-chip--on" : ""}`}>Protected downloads {o.gates.protectedDownloads ? "on" : "off"}</span>
          <span className={`cc-chip ${o.gates.publicApproved ? "cc-chip--on" : ""}`}>Public launch {o.gates.publicApproved ? "approved on the server" : "not approved"}</span>
        </div>
        {eff.notes.map((n) => <p key={n} className="notice" role="note">{n}</p>)}
        <dl className="kv kv--compact">
          <div><dt>Provider endpoint</dt><dd><code data-testid="studio-endpoint">{o.gates.endpoint}</code></dd></div>
          <div><dt>Internal test source</dt><dd>{eff.availability === "internal" ? <code>{o.gates.internalSource}</code> : "Only during internal testing"}</dd></div>
          <div><dt>HCG Repo advertises it</dt><dd>Only when HCG Repo sets <code>[access] payment_endpoint</code> to the endpoint (after public launch approval).</dd></div>
          <div><dt>Protocol</dt><dd>{eff.protocols.join(", ")}</dd></div>
        </dl>
        {!o.rights.manage && <p className="notice" role="note">You can view these settings. Changing them needs HCG Store's Pricing and Offers permission or HCG's Founder policy.</p>}
      </section>
      <ProfileEditor o={o} onSaved={load} />
      <PreviewAndHealth o={o} />
      <ChannelEditor o={o} onSaved={load} />
      <AuditTrail version={`${o.profile.revision}:${o.channels.map((c) => c.revision).join(",")}`} />
    </div>
  );
}

function ProfileEditor({ o, onSaved }: { o: Overview; onSaved: () => void }) {
  const [p, setP] = useState<ProviderProfile>(o.profile.value);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setP(o.profile.value), [o.profile]);
  const set = <K extends keyof ProviderProfile>(k: K, v: ProviderProfile[K]) => setP((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await commerceApi.saveProfile(o.profile.revision, p);
      setMsg({ ok: true, text: "Saved. The provider answers with the new profile now." });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const disabled = !o.rights.manage || busy;
  return (
    <section className="panel" aria-labelledby="studio-profile">
      <h2 id="studio-profile">Provider profile</h2>
      <p className="fine">What Sileo and Zebra show in their payment-provider list and sign-in banner. Revision {o.profile.revision}{o.profile.updatedAt ? `, saved ${new Date(o.profile.updatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : " (official defaults)"}.</p>
      <div className="cc-grid">
        <label className="cc-field"><span>Provider name</span><input value={p.name} disabled={disabled} onChange={(e) => set("name", e.target.value)} data-testid="studio-name" /></label>
        <label className="cc-field"><span>Icon (official artwork)</span><input value={p.icon} disabled={disabled} onChange={(e) => set("icon", e.target.value)} /></label>
        <label className="cc-field cc-field--wide"><span>Description</span><input value={p.description} disabled={disabled} onChange={(e) => set("description", e.target.value)} /></label>
        <label className="cc-field cc-field--wide"><span>Sign-in banner</span><input value={p.bannerMessage} disabled={disabled} onChange={(e) => set("bannerMessage", e.target.value)} /></label>
        <label className="cc-field"><span>Sign-in button</span><input value={p.bannerButton} disabled={disabled} onChange={(e) => set("bannerButton", e.target.value)} /></label>
        <label className="cc-field"><span>Availability</span>
          <select value={p.availability} disabled={disabled} onChange={(e) => set("availability", e.target.value as ProviderProfile["availability"])} data-testid="studio-availability-select">
            {Object.entries(AVAILABILITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="cc-field"><span>Payment mode</span>
          <select value={p.paymentMode} disabled={disabled} onChange={(e) => set("paymentMode", e.target.value as ProviderProfile["paymentMode"])}>
            <option value="off">Off: purchases are refused</option>
            <option value="test">TEST: the simulated provider (test servers only)</option>
          </select>
        </label>
        <label className="cc-field cc-field--wide"><span>Associated repositories (APT source URLs, one per line)</span>
          <textarea rows={2} value={p.repositories.join("\n")} disabled={disabled} onChange={(e) => set("repositories", e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))} />
        </label>
      </div>
      <p className="fine">Live payments are not offered here: HCG Store has no approved live payment integration. Public availability also needs <code>HCG_STORE_SILEO_PUBLIC_APPROVED=founder-approved</code> on the server.</p>
      <div className="cc-actions">
        <button type="button" className="button button--primary button--small" disabled={disabled} onClick={() => void save()} data-testid="studio-save">{busy ? "Saving…" : "Save profile"}</button>
        {!o.rights.manage && <span className="fine">Needs the Pricing and Offers permission or HCG's Founder policy.</span>}
      </div>
      {msg && <p className={`notice${msg.ok ? " notice--ok" : ""}`} role={msg.ok ? "status" : "alert"} data-testid="studio-message">{msg.text}</p>}
    </section>
  );
}

function PreviewAndHealth({ o }: { o: Overview }) {
  const packages = useMemo(() => o.channels.map((c) => c.packageId), [o.channels]);
  const [pkg, setPkg] = useState<string | null>(packages[0] ?? null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(() => {
    setError(null);
    commerceApi.health().then(setHealth).catch((e) => setError(errorText(e)));
    commerceApi.preview(pkg).then(setPreview).catch((e) => setError(errorText(e)));
  }, [pkg]);
  useEffect(() => { run(); }, [run, o]);
  const info = preview?.info.body as { name: string; description: string; icon: string; authentication_banner: { message: string; button: string } } | undefined;
  return (
    <section className="panel" aria-labelledby="studio-health">
      <h2 id="studio-health">Health inspector and Sileo preview</h2>
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="studio-split">
        <div>
          <h3>How Sileo shows HCG Store</h3>
          {info && (
            <div className="sileo-card" data-testid="sileo-preview">
              <div className="sileo-card__row">
                <img src={info.icon} alt="" width={48} height={48} />
                <div><p className="sileo-card__name">{info.name}</p><p className="sileo-card__desc">{info.description}</p></div>
              </div>
              <div className="sileo-card__banner">
                <p>{info.authentication_banner.message}</p>
                <span className="sileo-card__button">{info.authentication_banner.button}</span>
              </div>
            </div>
          )}
          <label className="cc-field"><span>Package for the response preview</span>
            <select value={pkg ?? ""} onChange={(e) => setPkg(e.target.value || null)}>
              <option value="">None</option>
              {packages.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          {preview && (
            <pre className="cc-pre" data-testid="sileo-json">{JSON.stringify({ "GET info": preview.info.body, ...(preview.packageInfo ? { [`POST package/${pkg}/info (signed out)`]: preview.packageInfo.body } : {}), "sign-in callback": preview.authenticationCallback, "payment callback": preview.paymentCallback }, null, 2)}</pre>
          )}
        </div>
        <div>
          <h3>Provider health {health && <span className={`cc-chip ${health.ok ? "cc-chip--on" : "cc-chip--warn"}`}>{health.ok ? "All checks pass" : "Needs attention"}</span>}</h3>
          {health ? (
            <ul className="studio-checks" data-testid="studio-health-checks">
              {health.checks.map((c) => (
                <li key={c.id} className={c.ok ? "is-ok" : "is-bad"}><span aria-hidden="true">{c.ok ? "✓" : "✕"}</span> <b>{c.label}</b><br /><span className="fine">{c.detail}</span></li>
              ))}
            </ul>
          ) : <p className="muted">Checking…</p>}
          <button type="button" className="button button--ghost button--small" onClick={run}>Run checks again</button>
        </div>
      </div>
    </section>
  );
}

type Draft = { packageId: string; productId: string; editionId: string | null; status: Channel["status"]; access: Channel["access"]; architectures: string[]; minIos: string; maxIos: string; updatePolicy: Channel["updatePolicy"]; repository: string; revision?: number };

function ChannelEditor({ o, onSaved }: { o: Overview; onSaved: () => void }) {
  const choices = useMemo(() => o.products.flatMap((p) => p.editions.flatMap((e) => e.packages.map((pkg) => ({ pkg, productId: p.id, editionId: e.id, label: `${p.name} ${e.name} (${pkg})` })))), [o.products]);
  const blank = (pkg?: string): Draft => {
    const c = choices.find((x) => x.pkg === pkg) ?? choices[0];
    return { packageId: c?.pkg ?? "", productId: c?.productId ?? "", editionId: c?.editionId ?? null, status: "draft", access: "paid", architectures: ["iphoneos-arm64"], minIos: "", maxIos: "", updatePolicy: "all-updates", repository: o.effective.repositories[0] ?? "" };
  };
  const [d, setD] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const edit = (c: Channel) => setD({ ...c, minIos: c.minIos ?? "", maxIos: c.maxIos ?? "" });
  const save = async () => {
    if (!d) return;
    setMsg(null);
    try {
      await commerceApi.saveChannel(d.packageId, { productId: d.productId, editionId: d.editionId, status: d.status, access: d.access, architectures: d.architectures, minIos: d.minIos || null, maxIos: d.maxIos || null, updatePolicy: d.updatePolicy, repository: d.repository, ...(d.revision ? { revision: d.revision } : {}) });
      setMsg({ ok: true, text: `Saved ${d.packageId}.` });
      setD(null);
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };
  return (
    <section className="panel" aria-labelledby="studio-channels">
      <h2 id="studio-channels">Repository packages (distribution channel)</h2>
      <p className="fine">Connects HCG Repo package identifiers to HCG Store products. Prices come only from HCG Store's offers; HCG Repo keeps no prices or purchase history.</p>
      {o.channels.length === 0 ? <p className="muted">No package is distributed through HCG Store yet.</p> : (
        <div className="cc-table-wrap"><table className="cc-table" data-testid="studio-channel-table">
          <thead><tr><th>Package</th><th>Product</th><th>Status</th><th>Access</th><th>Price</th><th>Architectures</th><th>iOS</th><th>Updates</th><th>Approved files</th><th /></tr></thead>
          <tbody>{o.channels.map((c) => (
            <tr key={c.packageId}>
              <td><code>{c.packageId}</code>{c.warnings.map((w) => <p key={w} className="fine cc-warn">{w}</p>)}</td>
              <td>{c.productName ?? c.productId}{c.editionId ? ` · ${c.editionId}` : ""}</td>
              <td>{c.status}</td><td>{c.access}</td>
              <td>{c.access === "paid" ? c.offers.map((x) => `${money(x.unitAmount, x.currency)}${x.testOnly ? " (TEST)" : ""}`).join(", ") || "No offer" : "Free"}</td>
              <td>{c.architectures.join(", ")}</td>
              <td>{c.minIos ? `${c.minIos}+` : "any"}{c.maxIos ? ` to ${c.maxIos}` : ""}</td>
              <td>{c.updatePolicy === "all-updates" ? "All updates" : "Same major"}</td>
              <td>{c.files.map((f) => `${f.version ?? "?"} (${f.architectures.join("/")})`).join(", ") || "none"}</td>
              <td>{o.rights.manage && <button type="button" className="button button--ghost button--small" onClick={() => edit(c)}>Edit</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {o.rights.manage && !d && <div className="cc-actions"><button type="button" className="button button--ghost button--small" disabled={!choices.length} onClick={() => setD(blank())}>Add a repository package</button>{!choices.length && <span className="fine">No catalogue edition declares a Debian package identifier.</span>}</div>}
      {d && (
        <div className="cc-form" data-testid="channel-form">
          <div className="cc-grid">
            <label className="cc-field"><span>Package</span>
              <select value={d.packageId} disabled={!!d.revision} onChange={(e) => setD({ ...blank(e.target.value), ...{ status: d.status, access: d.access } })}>
                {choices.map((c) => <option key={c.pkg} value={c.pkg}>{c.label}</option>)}
              </select>
            </label>
            <label className="cc-field"><span>Status</span><select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as Draft["status"] })}><option value="draft">Draft</option><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
            <label className="cc-field"><span>Access</span><select value={d.access} onChange={(e) => setD({ ...d, access: e.target.value as Draft["access"] })}><option value="paid">Paid (an entitlement)</option><option value="account">Free with an HCG account</option><option value="free">Free, public in HCG Repo</option></select></label>
            <label className="cc-field"><span>Updates</span><select value={d.updatePolicy} onChange={(e) => setD({ ...d, updatePolicy: e.target.value as Draft["updatePolicy"] })}><option value="all-updates">Every later version</option><option value="same-major">Same major version as bought</option></select></label>
            <fieldset className="cc-field"><legend>Architectures</legend><div className="cc-checks">{ARCHES.map((a) => (
              <label key={a}><input type="checkbox" checked={d.architectures.includes(a)} onChange={(e) => setD({ ...d, architectures: e.target.checked ? [...d.architectures, a] : d.architectures.filter((x) => x !== a) })} /> {a}</label>
            ))}</div></fieldset>
            <label className="cc-field"><span>Minimum iOS</span><input value={d.minIos} placeholder="e.g. 15.0" onChange={(e) => setD({ ...d, minIos: e.target.value })} /></label>
            <label className="cc-field"><span>Maximum iOS</span><input value={d.maxIos} placeholder="none" onChange={(e) => setD({ ...d, maxIos: e.target.value })} /></label>
            <label className="cc-field cc-field--wide"><span>Repository (APT source)</span><input value={d.repository} onChange={(e) => setD({ ...d, repository: e.target.value })} /></label>
          </div>
          <p className="fine">iOS versions are also enforced by the package's own <code>Depends: firmware</code> field; Sileo does not send the iOS version to the provider.</p>
          <div className="cc-actions">
            <button type="button" className="button button--primary button--small" onClick={() => void save()}>Save channel</button>
            <button type="button" className="button button--ghost button--small" onClick={() => setD(null)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <p className={`notice${msg.ok ? " notice--ok" : ""}`} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
    </section>
  );
}

function AuditTrail({ version }: { version: string }) {
  const [rows, setRows] = useState<{ seq: number; at: number; actor: string; action: string; target: string | null }[] | null>(null);
  useEffect(() => { commerceApi.audit().then((r) => setRows(r.entries.slice(0, 25))).catch(() => setRows([])); }, [version]);
  return (
    <section className="panel" aria-labelledby="studio-audit">
      <h2 id="studio-audit">Commerce audit</h2>
      {rows === null ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted">No changes recorded yet.</p> : (
        <div className="cc-table-wrap"><table className="cc-table"><thead><tr><th>When (UTC)</th><th>Action</th><th>Target</th><th>By (HCG account)</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.seq}><td>{new Date(r.at).toISOString().slice(0, 16).replace("T", " ")}</td><td>{r.action}</td><td>{r.target ?? "—"}</td><td><code>{r.actor.slice(0, 12)}</code></td></tr>)}</tbody>
        </table></div>
      )}
    </section>
  );
}
