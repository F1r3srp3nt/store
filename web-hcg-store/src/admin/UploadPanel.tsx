import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { StoreApiError } from "../account/api";
import { adminApi, type AdminProduct, type AdminRelease, type Me, type NewRelease } from "./admin-api";
import { formatBytes, formatDuration, guessFile, PLATFORM_NAMES } from "./formats";
import { cancelUpload, journal, uploadFile, type JournalEntry, type UploadProgress } from "./uploader";

type Operation = "update" | "new-product" | "add-to-listed" | "continue";
const OPERATIONS: { id: Operation; title: string; detail: string }[] = [
  { id: "update", title: "Add new update", detail: "A new version of an existing product and edition." },
  { id: "new-product", title: "Add new product", detail: "A private product draft and its first release." },
  { id: "add-to-listed", title: "Add to listed product", detail: "Another platform, architecture or installer for a released version." },
  { id: "continue", title: "Continue a draft", detail: "Add files to a draft, or resume an interrupted upload." },
];

const errorText = (e: unknown) => (e instanceof StoreApiError || e instanceof Error ? e.message : "Something went wrong.");
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

interface FileRow {
  key: string;
  file: File;
  platform: string;
  platforms: string[];
  format: string | null;
  architectures: string[];
  /** What the uploader checked on their own Mac or PC (codesign/spctl/stapler, signtool); recorded as reported. */
  signing: "not-checked" | "unsigned" | "signed" | "notarized";
  signingEvidence: string;
  note: string | null;
  progress: UploadProgress | null;
  controller: AbortController | null;
  resumeArtifactId?: string;
}

export function UploadPanel({ me, productId, onOpenReleases }: { me: Me; productId: string | null; onOpenReleases: (productId: string | null) => void }) {
  const [products, setProducts] = useState<AdminProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [op, setOp] = useState<Operation>("update");
  const [draft, setDraft] = useState<AdminRelease | null>(null);
  const reloadProducts = useCallback(() => adminApi.products().then((r) => setProducts(r.products)).catch((e) => setError(errorText(e))), []);
  useEffect(() => { void reloadProducts(); }, [reloadProducts]);

  if (!me.permissions.submit) {
    return (
      <div className="panel">
        <h2>Uploads need HCG Store's publishing permission</h2>
        <p>HCG has granted this account review permissions only. Uploading and submitting releases needs <code>store.publish</code> on <code>hcg.store</code>.</p>
      </div>
    );
  }
  return (
    <div className="cc-stack">
      {error && <p className="notice" role="alert">{error}</p>}
      {!draft && (
        <>
          <fieldset className="cc-ops">
            <legend className="visually-hidden">Operation</legend>
            {OPERATIONS.map((o) => (
              <label key={o.id} className={`cc-op${op === o.id ? " is-active" : ""}`}>
                <input type="radio" name="op" value={o.id} checked={op === o.id} onChange={() => setOp(o.id)} />
                <span className="cc-op__title">{o.title}</span>
                <span className="cc-op__detail">{o.detail}</span>
              </label>
            ))}
          </fieldset>
          {products === null ? (
            <p className="muted">Loading the products you may publish…</p>
          ) : op === "continue" ? (
            <ContinueDraft products={products} onOpen={setDraft} />
          ) : (
            <ReleaseForm key={op} op={op} products={products} initialProduct={productId} onCreated={(r) => { setDraft(r); void reloadProducts(); }} />
          )}
        </>
      )}
      {draft && <DraftFiles release={draft} onChange={setDraft} onDone={() => { setDraft(null); onOpenReleases(draft.productId); }} onClose={() => setDraft(null)} />}
    </div>
  );
}

function ReleaseForm({ op, products, initialProduct, onCreated }: { op: Operation; products: AdminProduct[]; initialProduct: string | null; onCreated: (r: AdminRelease) => void }) {
  const [productId, setProductId] = useState(initialProduct && products.some((p) => p.id === initialProduct) ? initialProduct : products[0]?.id ?? "");
  const product = products.find((p) => p.id === productId);
  const [editionId, setEditionId] = useState<string>("");
  const [base, setBase] = useState<AdminRelease[]>([]);
  const [baseId, setBaseId] = useState("");
  const [f, setF] = useState({ version: "", build: "", channel: "stable" as NewRelease["channel"], distribution: "paid" as NewRelease["distribution"], eligibility: "public" as NewRelease["eligibility"], notes: "", limitations: "", supersede: op === "update" });
  const [np, setNp] = useState({ id: "", title: "", summary: "", platforms: ["windows"] as string[], editions: "standard: Standard" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = products.find((x) => x.id === productId);
    setEditionId(p?.editions[0]?.id ?? "");
  }, [productId, products]);
  useEffect(() => {
    if (op !== "add-to-listed" || !productId) return;
    adminApi.manager(productId).then((r) => setBase(r.releases.filter((x) => x.publishedAt || x.status === "approved" || x.status === "submitted"))).catch(() => setBase([]));
  }, [op, productId]);
  useEffect(() => {
    const b = base.find((x) => x.id === baseId);
    if (b) setF((s) => ({ ...s, version: b.version, build: `${b.build}-${Date.now().toString(36).slice(-4)}`, channel: b.channel as NewRelease["channel"], distribution: b.distribution as NewRelease["distribution"], notes: b.releaseNotes.join("\n"), limitations: b.knownLimitations.join("\n"), supersede: false }));
  }, [baseId, base]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let pid = productId;
      let edition: string | null = editionId || null;
      if (op === "new-product") {
        const editions = lines(np.editions).map((l) => { const [id, ...name] = l.split(":"); return { id: id!.trim(), name: (name.join(":").trim() || id!.trim()) }; });
        await adminApi.createDraftProduct(np.id, np.title, { summary: np.summary, platforms: np.platforms, editions, visibility: "private" });
        pid = np.id;
        edition = editions[0]?.id ?? null;
      }
      const r = await adminApi.createRelease({
        productId: pid, editionId: edition, version: f.version.trim(), build: f.build.trim(), channel: f.channel, distribution: f.distribution,
        eligibility: op === "new-product" ? "private" : f.eligibility, releaseNotes: lines(f.notes), knownLimitations: lines(f.limitations), supersedePreviousOnPublish: f.supersede,
      });
      onCreated(r);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel cc-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2>{OPERATIONS.find((o) => o.id === op)!.title}</h2>
      {op === "new-product" ? (
        <div className="cc-grid">
          <label className="cc-field"><span>Product ID</span><input aria-label="Product ID" required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={np.id} onChange={(e) => setNp({ ...np, id: e.target.value })} placeholder="hcg-example" /></label>
          <label className="cc-field"><span>Name</span><input aria-label="Name" required value={np.title} onChange={(e) => setNp({ ...np, title: e.target.value })} placeholder="HCG Example" /></label>
          <label className="cc-field cc-field--wide"><span>Summary</span><input aria-label="Summary" value={np.summary} onChange={(e) => setNp({ ...np, summary: e.target.value })} /></label>
          <fieldset className="cc-field cc-field--wide"><legend>Platforms</legend>
            <div className="cc-checks">{Object.entries(PLATFORM_NAMES).map(([id, name]) => (
              <label key={id}><input type="checkbox" checked={np.platforms.includes(id)} onChange={(e) => setNp({ ...np, platforms: e.target.checked ? [...np.platforms, id] : np.platforms.filter((x) => x !== id) })} /> {name}</label>
            ))}</div>
          </fieldset>
          <label className="cc-field cc-field--wide"><span>Editions (one per line, id: name)</span><textarea aria-label="Editions (one per line, id: name)" rows={2} value={np.editions} onChange={(e) => setNp({ ...np, editions: e.target.value })} /></label>
          <p className="fine cc-field--wide">A draft product exists only in HCG Store. It does not create a central HCG product, entitlement or price; public release needs HCG to register it (HCG ERP) and add it to the catalogue.</p>
        </div>
      ) : (
        <div className="cc-grid">
          <label className="cc-field"><span>Product</span>
            <select aria-label="Product" value={productId} onChange={(e) => setProductId(e.target.value)} required>
              {products.map((p) => <option key={p.id} value={p.id}>{p.title}{p.source === "draft" ? " (draft)" : ""}</option>)}
            </select>
          </label>
          {product && product.editions.length > 0 && (
            <label className="cc-field"><span>Edition</span>
              <select aria-label="Edition" value={editionId} onChange={(e) => setEditionId(e.target.value)}>{product.editions.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
            </label>
          )}
          {op === "add-to-listed" && (
            <label className="cc-field cc-field--wide"><span>Released version to extend</span>
              <select aria-label="Released version to extend" value={baseId} onChange={(e) => setBaseId(e.target.value)} required>
                <option value="">Choose a version…</option>
                {base.map((b) => <option key={b.id} value={b.id}>{b.version} build {b.build} · {b.channel} · {b.lifecycle.label}</option>)}
              </select>
              <span className="fine">Published files never change. The new platform or installer becomes its own release of the same version, with its own review; existing platforms are untouched.</span>
            </label>
          )}
        </div>
      )}
      <div className="cc-grid">
        <label className="cc-field"><span>Version</span><input aria-label="Version" required value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} placeholder="1.2.0" readOnly={op === "add-to-listed" && !!baseId} /></label>
        <label className="cc-field"><span>Build</span><input aria-label="Build" required value={f.build} onChange={(e) => setF({ ...f, build: e.target.value })} placeholder="120" /></label>
        <label className="cc-field"><span>Channel</span>
          <select aria-label="Channel" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value as NewRelease["channel"] })}><option value="stable">Stable</option><option value="beta">Beta</option></select>
        </label>
        <label className="cc-field"><span>Distribution</span>
          <select aria-label="Distribution" value={f.distribution} onChange={(e) => setF({ ...f, distribution: e.target.value as NewRelease["distribution"] })}>
            <option value="paid">Paid (licence)</option><option value="subscription">Subscription</option><option value="entitlement">Entitlement</option><option value="free">Free</option>
          </select>
        </label>
        {op !== "new-product" && (
          <label className="cc-field"><span>Requested eligibility</span>
            <select aria-label="Requested eligibility" value={f.eligibility} onChange={(e) => setF({ ...f, eligibility: e.target.value as NewRelease["eligibility"] })}>
              <option value="public">Public (after approval and publication)</option><option value="internal-testing">Internal testing</option><option value="private">Private</option>
            </select>
          </label>
        )}
        <label className="cc-field cc-field--wide"><span>Release notes (one per line)</span><textarea aria-label="Release notes (one per line)" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        <label className="cc-field cc-field--wide"><span>Known limitations (one per line)</span><textarea aria-label="Known limitations (one per line)" rows={2} value={f.limitations} onChange={(e) => setF({ ...f, limitations: e.target.value })} /></label>
        {op !== "new-product" && (
          <label className="cc-check cc-field--wide">
            <input type="checkbox" checked={f.supersede} onChange={(e) => setF({ ...f, supersede: e.target.checked })} />
            <span><b>Supersede previous compatible release after successful publication.</b> Until this release is published (every check passed), the current release stays available. Only the same platform, architecture and channel are replaced.</span>
          </label>
        )}
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="cc-actions">
        <button className="button button--primary" disabled={busy}>{busy ? "Creating…" : "Create private draft"}</button>
        <span className="fine">Nothing is published: the draft is visible only to people HCG lets publish or approve HCG Store releases.</span>
      </div>
    </form>
  );
}

function ContinueDraft({ products, onOpen }: { products: AdminProduct[]; onOpen: (r: AdminRelease) => void }) {
  const [drafts, setDrafts] = useState<AdminRelease[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const interrupted = journal();
  useEffect(() => {
    adminApi.manager().then((r) => setDrafts(r.releases.filter((x) => x.status === "draft"))).catch((e) => setError(errorText(e)));
  }, []);
  const title = (id: string) => products.find((p) => p.id === id)?.title ?? id;
  return (
    <div className="panel">
      <h2>Continue a draft</h2>
      {error && <p className="notice" role="alert">{error}</p>}
      {interrupted.length > 0 && (
        <p className="notice" role="note">{interrupted.length} interrupted upload(s) in this browser: open the draft and choose the same file again to resume.</p>
      )}
      {drafts === null ? <p className="muted">Loading drafts…</p> : drafts.length === 0 ? <p className="muted">No drafts.</p> : (
        <ul className="cc-list">
          {drafts.map((d) => (
            <li key={d.id}>
              <span><b>{title(d.productId)}</b> {d.version} build {d.build} · {d.channel} · {d.lifecycle.label}{interrupted.some((i) => i.releaseId === d.id) ? " · interrupted upload" : ""}</span>
              <button type="button" className="button button--ghost button--small" onClick={() => adminApi.release(d.id).then(onOpen).catch((e) => setError(errorText(e)))}>Open</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DraftFiles({ release, onChange, onDone, onClose }: { release: AdminRelease; onChange: (r: AdminRelease) => void; onDone: () => void; onClose: () => void }) {
  const [rows, setRows] = useState<FileRow[]>([]);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const refresh = useCallback(() => adminApi.release(release.id).then(onChange).catch((e) => setError(errorText(e))), [release.id, onChange]);
  const interrupted = useMemo(() => journal().filter((j) => j.releaseId === release.id && (release.artifacts ?? []).some((a) => a.id === j.artifactId && ["awaiting-upload", "uploading"].includes(a.status))), [release]);

  const add = (files: FileList | File[], resume?: JournalEntry) => {
    const next: FileRow[] = [];
    for (const file of Array.from(files)) {
      if (resume && (file.name !== resume.fileName || file.size !== resume.size)) { setError(`Choose ${resume.fileName} (${formatBytes(resume.size)}) to resume that upload.`); continue; }
      const g = guessFile(file.name);
      const declared = resume ? release.artifacts?.find((a) => a.id === resume.artifactId) : undefined;
      next.push({ key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file, platform: declared?.platform ?? g.platform ?? "", platforms: declared ? [declared.platform] : g.platforms, format: declared?.format ?? g.format, architectures: declared?.architectures ?? g.architectures, signing: "not-checked", signingEvidence: "", note: g.note, progress: null, controller: null, resumeArtifactId: resume?.artifactId });
    }
    setRows((r) => [...r, ...next]);
  };
  const update = (key: string, patch: Partial<FileRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const start = async (row: FileRow) => {
    if (!row.format || !row.platform) return;
    const controller = new AbortController();
    update(row.key, { controller, progress: null });
    const out = await uploadFile(row.file, release.id, { platform: row.platform, format: row.format, architectures: row.architectures, minimumOs: null, signing: { status: row.signing, evidence: row.signingEvidence.trim() || null } }, (p) => update(row.key, { progress: p }), controller.signal, row.resumeArtifactId ?? (row.progress?.phase === "paused" || row.progress?.phase === "failed" ? row.progress.artifactId ?? undefined : undefined));
    update(row.key, { controller: null, progress: out, resumeArtifactId: out.phase === "paused" || out.phase === "failed" ? out.artifactId ?? undefined : undefined });
    void refresh();
  };
  const cancel = async (row: FileRow) => {
    row.controller?.abort();
    const id = row.progress?.artifactId ?? row.resumeArtifactId;
    if (id) await cancelUpload(id).catch(() => undefined);
    setRows((rs) => rs.filter((r) => r.key !== row.key));
    void refresh();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length) add(e.dataTransfer.files);
  };
  const verified = (release.artifacts ?? []).filter((a) => a.status === "verified");
  const busy = rows.some((r) => r.controller);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      onChange(await adminApi.submit(release.id, release.revision));
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel cc-draft" aria-label="Draft files">
      <div className="cc-draft__head">
        <div>
          <p className="eyebrow">Private draft · {release.lifecycle.label}</p>
          <h2>{release.productTitle} {release.version} <span className="muted">build {release.build} · {release.channel}{release.editionId ? ` · ${release.editionId}` : ""}</span></h2>
          {release.supersedePreviousOnPublish && <p className="fine">Prepared to supersede the previous compatible release once it is published.</p>}
        </div>
        <button type="button" className="button button--ghost button--small" onClick={onClose}>Close draft</button>
      </div>

      <div
        className={`cc-drop${drag ? " is-over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        data-testid="dropzone"
      >
        <p><b>Drop installers and packages here</b> or <button type="button" className="linklike" onClick={() => input.current?.click()}>choose files</button></p>
        <p className="fine">EXE, MSI, MSIX, ZIP, DMG, PKG, IPA, APK, AAB, AppImage, RPM, DEB. Package a macOS .app bundle as ZIP, DMG or PKG. Files are hashed in this browser, sent in resumable chunks and verified again by HCG Store; nothing is ever run.</p>
        <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} data-testid="file-input" />
      </div>

      {interrupted.map((j) => (
        <p key={j.artifactId} className="notice" role="note">
          Interrupted: <b>{j.fileName}</b> ({formatBytes(j.size)}).{" "}
          <label className="linklike">Choose the same file to resume<input type="file" hidden onChange={(e) => { if (e.target.files) add(e.target.files, j); e.target.value = ""; }} /></label>
        </p>
      ))}

      {rows.length > 0 && (
        <ul className="cc-files">
          {rows.map((r) => <FileRowView key={r.key} row={r} onChange={(patch) => update(r.key, patch)} onStart={() => void start(r)} onPause={() => r.controller?.abort()} onCancel={() => void cancel(r)} />)}
        </ul>
      )}
      {rows.some((r) => !r.controller && r.format && r.platform && (!r.progress || ["paused", "failed"].includes(r.progress.phase))) && (
        <button type="button" className="button button--primary" onClick={() => rows.filter((r) => !r.controller && r.format && r.platform && (!r.progress || ["paused", "failed"].includes(r.progress.phase))).forEach((r) => void start(r))}>Upload all</button>
      )}

      <h3>Verified files in this draft</h3>
      {verified.length === 0 ? <p className="muted">None yet.</p> : (
        <div className="cc-table-wrap"><table className="cc-table">
          <thead><tr><th>File</th><th>Platform</th><th>Architectures</th><th>Bytes</th><th>SHA-256 (HCG Store)</th><th>Installation</th></tr></thead>
          <tbody>{verified.map((a) => (
            <tr key={a.id}><td>{a.fileName}</td><td>{PLATFORM_NAMES[a.platform] ?? a.platform} · {a.format}</td><td>{a.architectures.join(", ") || "any"}</td><td>{a.sizeBytes.toLocaleString("en")}</td><td><code className="cc-hash">{a.sha256}</code></td><td>{a.readiness.label}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="cc-actions">
        <button type="button" className="button button--primary" disabled={!verified.length || busy || submitting || release.status !== "draft"} onClick={() => void submit()}>
          {submitting ? "Submitting…" : "Submit for review"}
        </button>
        <span className="fine">Submitting records these exact files for review. It does not approve or publish anything.</span>
      </div>
    </section>
  );
}

function FileRowView({ row, onChange, onStart, onPause, onCancel }: { row: FileRow; onChange: (p: Partial<FileRow>) => void; onStart: () => void; onPause: () => void; onCancel: () => void }) {
  const p = row.progress;
  const pct = p ? (p.phase === "hashing" ? p.hashed / Math.max(1, p.total) : p.sent / Math.max(1, p.total)) * 100 : 0;
  const locked = !!row.controller || !!row.resumeArtifactId || p?.phase === "verified";
  const label: Record<string, string> = { hashing: "Computing SHA-256", declaring: "Preparing", uploading: "Uploading", verifying: "HCG Store is verifying", verified: "Verified", rejected: "Rejected", paused: "Paused", failed: "Interrupted", cancelled: "Cancelled", queued: "Ready" };
  return (
    <li className={`cc-file cc-file--${p?.phase ?? "ready"}`} data-testid="upload-row">
      <div className="cc-file__head">
        <b className="cc-file__name">{row.file.name}</b>
        <span className="muted">{formatBytes(row.file.size)} ({row.file.size.toLocaleString("en")} bytes)</span>
      </div>
      {!row.format ? <p className="notice">{row.note}</p> : (
        <div className="cc-file__decl">
          <label>Platform{" "}
            <select value={row.platform} disabled={locked} onChange={(e) => onChange({ platform: e.target.value })}>
              {row.platforms.map((x) => <option key={x} value={x}>{PLATFORM_NAMES[x] ?? x}</option>)}
            </select>
          </label>
          <fieldset><legend className="visually-hidden">Architectures</legend>
            {["x64", "arm64", "x86"].map((a) => (
              <label key={a}><input type="checkbox" disabled={locked} checked={row.architectures.includes(a)} onChange={(e) => onChange({ architectures: e.target.checked ? [...row.architectures, a] : row.architectures.filter((x) => x !== a) })} /> {a}</label>
            ))}
          </fieldset>
          <span className="muted">{row.format.toUpperCase()}{row.architectures.length === 0 ? " · any architecture" : ""}</span>
          {(row.platform === "macos" || row.platform === "windows") && (
            <label>Signing, as you checked it{" "}
              <select aria-label="Signing, as you checked it" value={row.signing} disabled={locked} onChange={(e) => onChange({ signing: e.target.value as FileRow["signing"] })}>
                <option value="not-checked">Not checked</option>
                <option value="unsigned">Unsigned</option>
                <option value="signed">{row.platform === "macos" ? "Developer ID signed (not notarized)" : "Signed (Authenticode)"}</option>
                {row.platform === "macos" && <option value="notarized">Developer ID signed and notarized</option>}
              </select>
            </label>
          )}
          {(row.signing === "signed" || row.signing === "notarized") && (
            <label className="cc-file__evidence">Evidence (recorded){" "}
              <input aria-label="Signing evidence (recorded)" required disabled={locked} value={row.signingEvidence} placeholder={row.platform === "macos" ? "e.g. spctl: accepted, source=Notarized Developer ID; stapler validate: worked" : "e.g. signtool verify /pa: Successfully verified"} onChange={(e) => onChange({ signingEvidence: e.target.value })} />
            </label>
          )}
        </div>
      )}
      {(row.signing === "signed" || row.signing === "notarized") && <p className="fine">Recorded as reported by you on the website, with your evidence; HCG Store also checks the signature structure in the file.</p>}
      {row.note && row.format && <p className="fine">{row.note}</p>}
      {p && (
        <div className="cc-progress" aria-live="polite">
          <div className="cc-progress__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}><span style={{ width: `${pct}%` }} /></div>
          <p className="fine">
            <b data-testid="upload-phase">{label[p.phase]}</b>
            {p.phase === "uploading" && <> · {formatBytes(p.sent)} of {formatBytes(p.total)} · {p.bytesPerSecond ? `${formatBytes(p.bytesPerSecond)}/s` : "…"} · {formatDuration(p.secondsLeft)} left</>}
            {p.retries > 0 && <> · {p.retries} retr{p.retries === 1 ? "y" : "ies"}</>}
            {p.message && <> · {p.message}</>}
          </p>
          {p.phase === "verified" && p.artifact && (
            <p className="fine cc-ok" data-testid="sha-match">
              SHA-256 <code className="cc-hash">{p.artifact.sha256}</code> {p.artifact.sha256 === p.sha256 ? "— matches the file in this browser." : "— DIFFERS from the file in this browser."}
            </p>
          )}
        </div>
      )}
      <div className="cc-actions">
        {row.format && !row.controller && (!p || ["paused", "failed"].includes(p.phase)) && (
          <button type="button" className="button button--primary button--small" disabled={(row.signing === "signed" || row.signing === "notarized") && !row.signingEvidence.trim()} onClick={onStart}>{p || row.resumeArtifactId ? "Resume" : "Upload"}</button>
        )}
        {row.controller && <button type="button" className="button button--ghost button--small" onClick={onPause}>Pause</button>}
        {p?.phase !== "verified" && <button type="button" className="button button--ghost button--small" onClick={onCancel}>Cancel</button>}
      </div>
    </li>
  );
}
