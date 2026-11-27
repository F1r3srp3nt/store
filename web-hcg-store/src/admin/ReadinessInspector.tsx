import { useCallback, useEffect, useState } from "react";
import { StoreApiError } from "../account/api";
import { adminApi, type AdminRelease, type Gate, type Readiness } from "./admin-api";
import { PLATFORM_NAMES } from "./formats";

/**
 * Release Readiness Inspector: what HCG Store says about this release for the signed-in person, from the same rules the
 * server enforces (GET /releases/:id/readiness). Every step is listed; a step that cannot run now shows exactly why and,
 * where there is one, the action that resolves it. Nothing here decides anything: each action is checked again on the
 * server, with HCG's permissions read live.
 */
type StepId = "edit" | "submit" | "founderException" | "approve" | "publish" | "requestChanges" | "reject";
const STEP_TEXT: Record<StepId, { title: string; done?: (r: Readiness) => boolean }> = {
  edit: { title: "Edit release details" },
  submit: { title: "Submit for review", done: (r) => r.status !== "draft" },
  founderException: { title: "Record founder exception", done: (r) => !!r.governance.exception },
  approve: { title: "Approve", done: (r) => r.status === "approved" || r.status === "published" },
  publish: { title: "Publish", done: (r) => r.status === "published" },
  requestChanges: { title: "Request changes" },
  reject: { title: "Reject" },
};
const errorText = (e: unknown) => (e instanceof StoreApiError && e.code === "revision_conflict" ? "Another client changed this release. It has been reloaded; check again." : e instanceof Error ? e.message : "Something went wrong.");
const date = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—");

export function ReadinessInspector({ release, onChanged }: { release: AdminRelease; onChanged: (message: string) => void }) {
  const [rd, setRd] = useState<Readiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<StepId | null>(null);
  const load = useCallback(() => adminApi.readiness(release.id).then((x) => { setRd(x); setError(null); }).catch((e) => setError(errorText(e))), [release.id]);
  useEffect(() => { void load(); }, [load, release.revision]);
  if (error) return <p className="notice" role="alert">Readiness could not be loaded: {error}</p>;
  if (!rd) return <p className="muted">Checking readiness…</p>;

  const done = (m: string) => { setOpen(null); void load(); onChanged(m); };
  const steps: StepId[] = ["edit", "submit", ...(rd.governance.sameParty ? (["founderException"] as StepId[]) : []), "approve", "publish", "requestChanges", "reject"];
  const relevant = (s: StepId) => !(["requestChanges", "reject"] as StepId[]).includes(s) || ["submitted", "approved"].includes(rd.status);
  const P = rd.permissions;
  const perm = (ok: boolean, key: string | null) => <li key={key ?? "x"} className={ok ? "cc-ok" : "cc-no"}>{ok ? "✓" : "✗"} <code>{key ?? "not configured"}</code></li>;

  return (
    <section className="cc-readiness" aria-label={`Release readiness ${rd.version}`} data-testid="readiness">
      <header className="cc-readiness__head">
        <h4>Release readiness</h4>
        <span className={`badge ${rd.outstanding.length ? "badge--warn" : "badge--stable"}`} data-testid="readiness-summary">
          {rd.status === "published" ? "Published" : rd.outstanding.length ? `${rd.outstanding.length} requirement${rd.outstanding.length === 1 ? "" : "s"} outstanding` : "Ready for the next step"}
        </span>
      </header>
      <dl className="cc-readiness__grid">
        <div><dt>Release status</dt><dd>{rd.status} · {rd.stage} · {rd.availability}</dd></div>
        <div><dt>Eligibility</dt><dd>requested {rd.requestedEligibility}{rd.approvedEligibility ? ` · approved ${rd.approvedEligibility}` : ""}</dd></div>
        <div><dt>Artifact verification</dt><dd>{rd.files.verified} verified{rd.files.rejected ? ` · ${rd.files.rejected} refused` : ""}{rd.files.pending ? ` · ${rd.files.pending} uploading` : ""}</dd></div>
        <div><dt>Signing</dt><dd className={rd.signing.publicBlockers.length ? "cc-no" : undefined}>{rd.signing.publicBlockers.length ? `${rd.signing.publicBlockers.length} file(s) do not meet public signing requirements` : "Meets the mandatory requirements for public delivery"}</dd></div>
        <div><dt>Notarization (macOS)</dt><dd>{rd.signing.notarized.length ? rd.signing.notarized.map((n) => `${n.fileName}: ${n.notarized ? "notarized" : "not notarized"}`).join(" · ") : "No macOS files"}</dd></div>
        <div><dt>Your HCG permissions</dt><dd><ul className="cc-perms">{perm(P.submit, P.required.submit)}{perm(P.approve, P.required.approve)}{perm(P.publication, P.required.publish)}</ul></dd></div>
        <div><dt>Separation of duties</dt><dd>
          Created by {rd.governance.createdBy}{rd.governance.submittedBy ? `, submitted by ${rd.governance.submittedBy}` : ""}.{" "}
          {rd.governance.exception ? <>Founder exception <code>{rd.governance.exception.id}</code> recorded {date(rd.governance.exception.createdAt)} (not an independent review).</>
            : rd.governance.sameParty ? "Public approval needs another person or a founder exception." : "Independent review."}
          {rd.governance.founderConfirmedByHcg !== null && <> HCG {rd.governance.founderConfirmedByHcg ? "confirms" : "does not confirm"} the Founder policy for your account.</>}
        </dd></div>
      </dl>

      <ol className="cc-steps">
        {steps.filter(relevant).map((s) => {
          const g: Gate = rd.steps[s];
          const isDone = STEP_TEXT[s].done?.(rd) ?? false;
          return (
            <li key={s} className={`cc-step${g.allowed ? " is-ready" : ""}${isDone ? " is-done" : ""}`} data-step={s}>
              <div className="cc-step__head">
                <b>{STEP_TEXT[s].title}</b>
                <span className={`badge ${isDone ? "badge--stable" : g.allowed ? "badge--active" : "badge--muted"}`}>{isDone ? "Done" : g.allowed ? "Available" : "Not available"}</span>
                {g.allowed && !isDone && (
                  <button type="button" className={`button button--small ${s === "reject" ? "button--danger" : "button--primary"}`} onClick={() => setOpen(open === s ? null : s)} data-testid={`step-${s}`}>{STEP_TEXT[s].title}</button>
                )}
                {!g.allowed && !isDone && (
                  <button type="button" className="button button--small button--ghost" disabled aria-describedby={`why-${rd.releaseId}-${s}`}>{STEP_TEXT[s].title}</button>
                )}
                {!g.allowed && !isDone && g.resolution && rd.steps[g.resolution.action === "founder-exception" ? "founderException" : (g.resolution.action as StepId)]?.allowed && (
                  <button type="button" className="button button--small button--ghost" onClick={() => setOpen(g.resolution!.action === "founder-exception" ? "founderException" : (g.resolution!.action as StepId))} data-testid={`resolve-${s}`}>{g.resolution.label}</button>
                )}
              </div>
              {!g.allowed && !isDone && g.reasons.length > 0 && (
                <ul className="cc-step__why" id={`why-${rd.releaseId}-${s}`} data-testid={`why-${s}`}>{g.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              )}
              {open === s && <StepForm step={s} release={release} rd={rd} onDone={done} onCancel={() => setOpen(null)} />}
            </li>
          );
        })}
      </ol>

      <h5>Files, validation and Release Passports</h5>
      <ul className="cc-files">
        {rd.files.list.map((f) => (
          <li key={f.id} className={f.status === "rejected" ? "cc-no" : undefined}>
            <b>{f.fileName}</b> · {PLATFORM_NAMES[f.platform] ?? f.platform} · {f.status}
            {f.sha256 && <> · <code className="cc-hash">{f.sha256}</code></>}
            <br /><span className="muted">{f.readiness.label} Signing reported: {f.signingReported}. Release Passport: {f.passport ? `matched${f.passport.provider ? ` (${f.passport.provider}${f.passport.runId ? ` run ${f.passport.runId}` : ""}${f.passport.commit ? ` · ${f.passport.commit.slice(0, 12)}` : ""})` : ""}` : f.buildProvider === "manual-upload" ? "none (manual upload, no build evidence claimed)" : "none"}.</span>
            {f.problems.length > 0 && <><br /><span>{f.problems.join(" ")}</span></>}
            {f.status === "rejected" && rd.steps.edit.allowed && (
              <> <button type="button" className="button button--ghost button--small" onClick={() => adminApi.removeArtifact(f.id).then(() => done(`${f.fileName} removed from the draft.`)).catch((e) => setError(errorText(e)))}>Remove from draft</button></>
            )}
          </li>
        ))}
        {rd.files.list.length === 0 && <li className="muted">No files yet. Upload them under Upload application.</li>}
      </ul>
      {rd.reviewNotes.length > 0 && (
        <><h5>Review notes</h5><ul className="cc-files">{rd.reviewNotes.map((n) => <li key={n.at}>{date(n.at)} · <b>{n.action === "release.rejected" ? "Rejected" : "Changes requested"}</b>: {n.reason}</li>)}</ul></>
      )}
    </section>
  );
}

function StepForm({ step, release: r, rd, onDone, onCancel }: { step: StepId; release: AdminRelease; rd: Readiness; onDone: (m: string) => void; onCancel: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [eligibility, setEligibility] = useState(rd.requestedEligibility);
  const [notes, setNotes] = useState(r.releaseNotes.join("\n"));
  const [limits, setLimits] = useState(r.knownLimitations.join("\n"));
  const [acknowledged, setAcknowledged] = useState(false);
  const [supersede, setSupersede] = useState(r.supersedePreviousOnPublish);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const needsVersion = ["submit", "founderException", "approve", "publish"].includes(step) && step !== "submit";
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (step === "edit") { await adminApi.updateRelease(r.id, r.revision, { releaseNotes: lines(notes), knownLimitations: lines(limits), requestedEligibility: eligibility }); onDone("Release details saved."); }
      else if (step === "submit") { await adminApi.submit(r.id, r.revision); onDone("Submitted for review. Nothing is approved or published."); }
      else if (step === "founderException") { const x = await adminApi.founderException(r.id, r.revision, { confirm, reason, filesDigest: rd.governance.filesDigest ?? "" }); onDone(`Founder exception ${x.exception.id} recorded for these exact files. It is not an independent review.`); }
      else if (step === "approve") { await adminApi.approve(r.id, r.revision, { eligibility, confirm, current: false }); onDone(`Approved for ${eligibility}. Nothing is published yet.`); }
      else if (step === "publish") {
        const x = await adminApi.publish(r.id, r.revision, { confirm, supersedePrevious: supersede });
        const s = x.switch;
        onDone(`Published. Now current on: ${s.switched.map((t) => `${PLATFORM_NAMES[t.target.platform] ?? t.target.platform} ${t.target.arch} (${t.target.channel})`).join(", ") || "no new platform"}.${s.kept.length ? ` Kept the existing current release on ${s.kept.length} platform(s).` : ""}${s.superseded.length ? ` Superseded ${s.superseded.length} release(s).` : ""}`);
      }
      else { await adminApi.review(r.id, step === "reject" ? "reject" : "request-changes", r.revision, reason); onDone(step === "reject" ? "Rejected (recorded with your reason)." : "Returned to draft for changes (recorded with your reason)."); }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="cc-opform" onSubmit={(e) => { e.preventDefault(); void run(); }}>
      {step === "edit" && (
        <>
          <p className="fine">Saving changes to a submitted or approved release returns it to draft: its approval was for the record as it was. Files are never changed here.</p>
          <label className="cc-field"><span>Release notes (one per line)</span><textarea aria-label="Release notes (one per line)" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          <label className="cc-field"><span>Known limitations (one per line)</span><textarea aria-label="Known limitations (one per line)" rows={3} value={limits} onChange={(e) => setLimits(e.target.value)} /></label>
          <label className="cc-field"><span>Requested eligibility</span>
            <select aria-label="Requested eligibility" value={eligibility} onChange={(e) => setEligibility(e.target.value)}><option value="private">Private</option><option value="internal-testing">Internal testing</option><option value="public">Public</option></select>
          </label>
        </>
      )}
      {step === "submit" && <p className="fine">Submitting records these exact files for review. It does not approve or publish anything.</p>}
      {step === "founderException" && (
        <>
          <p className="fine" role="note">
            You created or submitted this release. HCG confirms the Founder policy for your account, so you may record a founder-operated exception and then
            approve and publish this release yourself. It is recorded with your identity, this release, every file's SHA-256, your reason and the time,
            and shown everywhere as <b>not an independent review</b>. It applies only to these files, never changes the signing requirements, and each step still needs its HCG permission.
          </p>
          <ul className="cc-files">{rd.files.list.filter((f) => f.status === "verified").map((f) => <li key={f.id}>{f.fileName} · <code className="cc-hash">{f.sha256}</code></li>)}</ul>
          <p className="fine">Files digest: <code className="cc-hash">{rd.governance.filesDigest}</code></p>
          <label className="cc-field"><span>Reason (recorded)</span><input aria-label="Reason (recorded)" required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label className="cc-check"><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} required /> <span>I understand this is not an independent review.</span></label>
        </>
      )}
      {step === "approve" && (
        <label className="cc-field"><span>Approve for</span>
          <select aria-label="Approve for" value={eligibility} onChange={(e) => setEligibility(e.target.value)}><option value="private">Private</option><option value="internal-testing">Internal testing</option><option value="public">Public</option></select>
        </label>
      )}
      {step === "publish" && <label className="cc-check"><input type="checkbox" checked={supersede} onChange={(e) => setSupersede(e.target.checked)} /> <span>Supersede the previous compatible release (same platform, architecture and channel).</span></label>}
      {(step === "reject" || step === "requestChanges") && (
        <label className="cc-field"><span>{step === "reject" ? "Why it is rejected (recorded)" : "What must change (recorded)"}</span><input aria-label="Review reason (recorded)" required value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      )}
      {needsVersion && <label className="cc-field"><span>Type the version ({r.version}) to confirm</span><input aria-label={`Type the version (${r.version}) to confirm`} required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></label>}
      {error && <p className="notice" role="alert">{error}</p>}
      <div className="cc-actions">
        <button className={`button button--small ${step === "reject" ? "button--danger" : "button--primary"}`} disabled={busy || (step === "founderException" && !acknowledged)} data-testid={`confirm-${step}`}>{busy ? "Working…" : STEP_TEXT[step].title}</button>
        <button type="button" className="button button--ghost button--small" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
