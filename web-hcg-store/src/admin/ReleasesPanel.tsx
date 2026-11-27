import { useCallback, useEffect, useMemo, useState } from "react";
import { StoreApiError } from "../account/api";
import { adminApi, type AdminRelease, type Me, type SwitchResult } from "./admin-api";
import { PLATFORM_NAMES } from "./formats";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const date = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—");
const LABEL_TONE: Record<string, string> = {
  current: "stable", published: "active", approved: "active", submitted: "planned", "ready-for-review": "planned", uploading: "planned",
  "validation-required": "muted", draft: "muted", superseded: "muted", disabled: "warn", archived: "muted", revoked: "warn", withdrawn: "warn",
};

type Op = "approve" | "publish" | "supersede" | "restore" | "disable" | "enable" | "archive" | "revoke" | "withdraw";
const OP_TEXT: Record<Op, { title: string; needsVersion: boolean; needsReason: boolean; help: string }> = {
  approve: { title: "Approve", needsVersion: true, needsReason: false, help: "Manual approval. It does not publish anything." },
  publish: { title: "Publish", needsVersion: true, needsReason: false, help: "Every stored file is re-hashed first; the current-release switch happens in one step, or not at all." },
  supersede: { title: "Make current (supersede)", needsVersion: true, needsReason: true, help: "Makes this published release current on its platforms; what it replaces becomes superseded." },
  restore: { title: "Restore this version", needsVersion: true, needsReason: true, help: "Rollback: this earlier release becomes current again on every platform it serves." },
  disable: { title: "Disable", needsVersion: false, needsReason: true, help: "Stops every download of this release at once, including links already issued. It can be enabled again." },
  enable: { title: "Enable", needsVersion: false, needsReason: true, help: "Makes a disabled or archived release available again." },
  archive: { title: "Archive", needsVersion: false, needsReason: true, help: "Hides it from ordinary lists. Kept with its files and history." },
  revoke: { title: "Revoke", needsVersion: true, needsReason: true, help: "Final: the release is never delivered or restored again. Use for compromised or harmful builds." },
  withdraw: { title: "Withdraw", needsVersion: false, needsReason: true, help: "Stops delivery and ends the release's review track (kept on record)." },
};

export function ReleasesPanel({ me, productId, onProduct }: { me: Me; productId: string | null; onProduct: (p: string | null) => void }) {
  const [list, setList] = useState<AdminRelease[] | null>(null);
  const [auditIntact, setAuditIntact] = useState(true);
  const [archived, setArchived] = useState(false);
  const [label, setLabel] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => adminApi.manager(productId ?? undefined, archived).then((r) => { setList(r.releases); setAuditIntact(r.auditIntact); }).catch((e) => setError(errorText(e))), [productId, archived]);
  useEffect(() => { void load(); }, [load]);
  // Synchronisation: changes made by another client (Executable Maker, Store Manager, another browser) appear here.
  useEffect(() => {
    let since = -1;
    const t = setInterval(() => {
      adminApi.changes(Math.max(0, since)).then((c) => {
        if (since >= 0 && c.latestSeq > since) void load();
        since = c.latestSeq;
      }).catch(() => undefined);
    }, 15_000);
    return () => clearInterval(t);
  }, [load]);
  const products = useMemo(() => [...new Map((list ?? []).map((r) => [r.productId, r.productTitle])).entries()], [list]);
  const shown = (list ?? []).filter((r) => label === "all" || r.lifecycle.label === label);
  const groups = useMemo(() => {
    const by = new Map<string, AdminRelease[]>();
    for (const r of shown) by.set(r.productId, [...(by.get(r.productId) ?? []), r]);
    return [...by.entries()];
  }, [shown]);

  return (
    <div className="cc-stack">
      {!auditIntact && <p className="notice" role="alert">The publishing audit chain does not verify. Do not approve or publish until it is investigated.</p>}
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="cc-filters">
        <label className="cc-field"><span>Product</span>
          <select aria-label="Product" value={productId ?? ""} onChange={(e) => onProduct(e.target.value || null)}>
            <option value="">All products</option>
            {products.map(([id, t]) => <option key={id} value={id}>{t}</option>)}
            {productId && !products.some(([id]) => id === productId) && <option value={productId}>{productId}</option>}
          </select>
        </label>
        <label className="cc-field"><span>State</span>
          <select aria-label="State" value={label} onChange={(e) => setLabel(e.target.value)}>
            <option value="all">All states</option>
            {Object.keys(LABEL_TONE).map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="cc-check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> <span>Include archived</span></label>
      </div>
      {list === null ? <p className="muted">Loading releases…</p> : groups.length === 0 ? <div className="panel"><p>No releases to show.</p></div> : groups.map(([pid, rs]) => (
        <section key={pid} className="panel" aria-label={`${rs[0]!.productTitle} releases`}>
          <h2>{rs[0]!.productTitle}{rs[0]!.productSource === "draft" ? <span className="badge badge--muted cc-badge-gap">Draft product</span> : null}</h2>
          <ol className="rm-list">{rs.map((r) => <ReleaseCard key={r.id} me={me} release={r} onChanged={() => void load()} />)}</ol>
        </section>
      ))}
    </div>
  );
}

function ReleaseCard({ me, release: summary, onChanged }: { me: Me; release: AdminRelease; onChanged: () => void }) {
  const [r, setR] = useState<AdminRelease>(summary);
  const [open, setOpen] = useState(false);
  const [op, setOp] = useState<Op | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setR(summary), [summary]);
  const details = () => adminApi.release(r.id).then((x) => { setR(x); setOpen(true); }).catch((e) => setMessage(errorText(e)));
  const P = me.permissions;
  const pub = me.capabilities.publication;
  const ops: Op[] = [];
  if (r.status === "submitted" && P.approve && me.capabilities.approval) ops.push("approve");
  if (r.status === "approved" && r.approvedEligibility === "public" && P.publish && pub) ops.push("publish");
  // Make current: a published release that is current nowhere (published without "supersede"). Restore (rollback): an
  // earlier published release that some of its platforms no longer get, whatever replaced it.
  const notCurrentSomewhere = r.targets.some((t) => !t.current);
  if (r.status === "published" && r.lifecycle.currency !== "current" && r.availability === "available" && P.publish && pub) ops.push("supersede");
  else if (r.publishedAt && ["superseded", "published"].includes(r.status) && notCurrentSomewhere && r.availability !== "revoked" && P.publish && pub) ops.push("restore");
  if (r.availability === "available" && (P.submit || P.approve || P.publish)) ops.push("disable");
  if (["disabled", "archived"].includes(r.availability) && (r.publishedAt ? P.publish && pub : P.submit)) ops.push("enable");
  if (r.availability !== "archived" && r.availability !== "revoked" && r.lifecycle.currency !== "current" && (P.submit || P.approve)) ops.push("archive");
  if (r.availability !== "revoked" && (P.approve || P.publish)) ops.push("revoke");
  if (r.status !== "withdrawn" && r.status !== "draft" && (P.submit || P.approve)) ops.push("withdraw");

  return (
    <li className="rm-release cc-release" data-testid={`release-${r.version}-${r.build}`}>
      <div className="rm-release__head">
        <h3>{r.version} <span className="muted">build {r.build}{r.editionId ? ` · ${r.editionId}` : ""}</span></h3>
        <span className="cc-chips">
          <span className={`badge badge--${LABEL_TONE[r.lifecycle.label] ?? "muted"}`} data-testid="lifecycle">{r.lifecycle.label}</span>
          <span className="badge badge--muted">{r.channel}</span>
          {(r.requests?.length ?? 0) > 0 && <span className="badge badge--warn" data-testid="requests-badge">{r.requests!.length} request{r.requests!.length === 1 ? "" : "s"}</span>}
        </span>
      </div>
      <dl className="kv kv--compact">
        <div><dt>Review</dt><dd>{r.lifecycle.review}</dd></div>
        <div><dt>Availability</dt><dd>{r.availability}{r.availabilityReason ? ` (${r.availabilityReason})` : ""}</dd></div>
        <div><dt>Current</dt><dd>{r.lifecycle.currency}</dd></div>
        <div><dt>Eligibility</dt><dd>{r.approvedEligibility ? `approved ${r.approvedEligibility}` : `requested ${r.requestedEligibility}`}</dd></div>
        <div><dt>Distribution</dt><dd>{r.distribution}</dd></div>
        <div><dt>Source</dt><dd>{r.uploadSource?.via === "web" ? "HCG Store website" : r.uploadSource?.via === "desktop" ? "Desktop app" : "—"}</dd></div>
        <div><dt>Published</dt><dd>{date(r.publishedAt)}</dd></div>
        <div><dt>Revision</dt><dd>{r.revision}</dd></div>
      </dl>
      {r.targets.length > 0 && (
        <p className="cc-targets">{r.targets.map((t) => (
          <span key={`${t.platform}-${t.arch}-${t.channel}`} className={`cc-chip${t.current ? " cc-chip--on" : ""}`}>{PLATFORM_NAMES[t.platform] ?? t.platform} {t.arch} · {t.channel}{t.current ? " · current" : ""}</span>
        ))}</p>
      )}
      <div className="rm-release__actions">
        <button type="button" className="button button--ghost button--small" onClick={() => (open ? setOpen(false) : void details())}>{open ? "Hide details" : "Details and history"}</button>
        <button type="button" className="button button--ghost button--small" onClick={() => adminApi.verifyChecksums(r.id).then((c) => setMessage(c.ok ? `All ${c.files.length} stored file(s) match their recorded SHA-256.` : `Mismatch: ${c.files.filter((f) => !f.ok).map((f) => f.fileName).join(", ")}.`)).catch((e) => setMessage(errorText(e)))}>Verify checksums</button>
        {ops.map((o) => (
          <button key={o} type="button" className={`button button--small ${o === "revoke" || o === "disable" ? "button--danger" : "button--ghost"}`} onClick={() => setOp(op === o ? null : o)}>{OP_TEXT[o].title}</button>
        ))}
        <a className="button button--ghost button--small" href={r.reviewUrl}>Review page</a>
      </div>
      {(r.requests?.length ?? 0) > 0 && (
        <ul className="cc-requests" aria-label="Requests for the people who approve and publish">
          {r.requests!.map((q) => (
            <li key={q.seq}><b>{q.action}</b> requested{q.via ? ` from ${q.via === "desktop" ? "a desktop app" : "the website"}` : ""}: {q.reason} <span className="muted">({date(q.at)})</span></li>
          ))}
        </ul>
      )}
      {r.publicationRequest && r.status !== "published" && (
        <p className="fine">At publication the submitter asks: {r.publicationRequest.makeCurrent ? "make it the catalogue's current release" : "do not make it the catalogue's current release"}; {r.publicationRequest.supersedePrevious === "compatible" ? "supersede the previous compatible release" : "supersede nothing"}.</p>
      )}
      {message && <p className="notice" role="status">{message}</p>}
      {op && <OperationForm release={r} op={op} onDone={(m) => { setOp(null); setMessage(m); onChanged(); }} onCancel={() => setOp(null)} />}
      {open && <ReleaseDetails release={r} onMessage={setMessage} />}
    </li>
  );
}

function OperationForm({ release: r, op, onDone, onCancel }: { release: AdminRelease; op: Op; onDone: (message: string) => void; onCancel: () => void }) {
  const t = OP_TEXT[op];
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [eligibility, setEligibility] = useState(r.requestedEligibility);
  const [supersede, setSupersede] = useState(r.supersedePreviousOnPublish);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const summary = (s?: SwitchResult) => !s ? "" : ` Now current on: ${s.switched.map((x) => `${PLATFORM_NAMES[x.target.platform] ?? x.target.platform} ${x.target.arch} (${x.target.channel})`).join(", ") || "no new platform"}.${s.kept.length ? ` Kept the existing current release on ${s.kept.length} platform(s).` : ""}${s.superseded.length ? ` Superseded ${s.superseded.length} release(s).` : ""}`;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (op === "approve") { await adminApi.approve(r.id, r.revision, { eligibility, confirm, current: false }); onDone(`Approved for ${eligibility}.`); }
      else if (op === "publish") { const x = await adminApi.publish(r.id, r.revision, { confirm, supersedePrevious: supersede }); onDone(`Published.${summary(x.switch)}`); }
      else if (op === "supersede" || op === "restore") { const x = await adminApi.switchCurrent(r.id, op, r.revision, confirm, reason); onDone(`${op === "restore" ? "Restored" : "Made current"}.${summary(x.switch)}`); }
      else { await adminApi.lifecycle(r.id, op, r.revision, reason, t.needsVersion ? confirm : undefined); onDone(`${t.title}: done.`); }
    } catch (e) {
      setError(e instanceof StoreApiError && e.code === "revision_conflict" ? "Another client changed this release. Reload the list and check again." : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="cc-opform" onSubmit={(e) => { e.preventDefault(); void run(); }}>
      <p><b>{t.title}</b> — {t.help}</p>
      {op === "approve" && (
        <label className="cc-field"><span>Approve for</span>
          <select aria-label="Approve for" value={eligibility} onChange={(e) => setEligibility(e.target.value)}><option value="private">Private</option><option value="internal-testing">Internal testing</option><option value="public">Public</option></select>
        </label>
      )}
      {op === "publish" && (
        <label className="cc-check"><input type="checkbox" checked={supersede} onChange={(e) => setSupersede(e.target.checked)} /> <span>Supersede the previous compatible release (same platform, architecture and channel).</span></label>
      )}
      {t.needsReason && <label className="cc-field"><span>Reason (recorded)</span><input aria-label="Reason (recorded)" required value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      {t.needsVersion && <label className="cc-field"><span>Type the version ({r.version}) to confirm</span><input aria-label={`Type the version (${r.version}) to confirm`} required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></label>}
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="cc-actions">
        <button className={`button button--small ${op === "revoke" ? "button--danger" : "button--primary"}`} disabled={busy}>{busy ? "Working…" : t.title}</button>
        <button type="button" className="button button--ghost button--small" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ReleaseDetails({ release: r, onMessage }: { release: AdminRelease; onMessage: (m: string) => void }) {
  return (
    <div className="cc-details">
      {r.releaseNotes.length > 0 && <><h4>Release notes</h4><ul>{r.releaseNotes.map((n) => <li key={n}>{n}</li>)}</ul></>}
      {r.knownLimitations.length > 0 && <><h4>Known limitations</h4><ul>{r.knownLimitations.map((n) => <li key={n}>{n}</li>)}</ul></>}
      <h4>Files</h4>
      <div className="cc-table-wrap"><table className="cc-table">
        <thead><tr><th>File</th><th>Platform · format</th><th>Architectures</th><th>Exact size</th><th>SHA-256</th><th>Signing</th><th>Validation evidence</th><th>Release Passport</th><th>Status</th><th /></tr></thead>
        <tbody>{(r.artifacts ?? []).filter((a) => a.status !== "removed").map((a) => (
          <tr key={a.id}>
            <td>{a.fileName}</td>
            <td>{PLATFORM_NAMES[a.platform] ?? a.platform} · {a.format}</td>
            <td>{a.architectures.join(", ") || "any"}</td>
            <td>{a.sizeBytes.toLocaleString("en")} bytes</td>
            <td><code className="cc-hash">{a.sha256 ?? a.declaredSha256}</code></td>
            <td>{a.validation?.signatureStructure ?? "—"} (structure) · {a.signingReported.status} (reported)</td>
            <td>{a.validation ? (a.validation.problems?.length ? a.validation.problems.join(" ") : `HCG Store: hash, format and archive checks passed. ${a.readiness.label}`) : "—"}</td>
            <td>{a.provenance?.passport ? `Matched${a.provenance.passport.provider ? ` (${a.provenance.passport.provider}${a.provenance.passport.runId ? ` run ${a.provenance.passport.runId}` : ""})` : ""}` : a.provenance?.buildProvider === "manual-upload" ? "None (manual upload)" : "—"}</td>
            <td>{a.status}</td>
            <td>{a.status === "verified" && <button type="button" className="button button--ghost button--small" onClick={() => adminApi.downloadUrl(a.id).then((d) => { location.href = d.url; }).catch((e) => onMessage(errorText(e)))}>Download to review</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <h4>Administrative history</h4>
      <ol className="cc-audit">{(r.audit ?? []).map((a) => (
        <li key={a.seq}><time>{date(a.at)}</time> <b>{a.action}</b> <span className="muted">{a.actor.startsWith("import:") ? a.actor : `account …${a.actor.slice(-6)}`}</span>{typeof a.detail.reason === "string" ? ` — ${a.detail.reason}` : ""}</li>
      ))}</ol>
    </div>
  );
}
