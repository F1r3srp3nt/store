import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAccount } from "../account/account-context";
import {
  signInUrl,
  StoreApiError,
  storeApi,
  type ChecksumReport,
  type ManagedRelease,
  type ReleaseComparison,
  type ReleaseStage,
} from "../account/api";
import { IconInfo, IconLock, IconShield } from "../components/Icons";
import { PageMeta } from "../components/PageMeta";

const STAGES: Record<ReleaseStage, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "muted" },
  "validation-pending": { label: "Validation pending", tone: "planned" },
  "validation-failed": { label: "Validation failed", tone: "muted" },
  uploaded: { label: "Artifacts uploaded", tone: "planned" },
  "awaiting-approval": { label: "Awaiting approval", tone: "active" },
  approved: { label: "Approved, not published", tone: "active" },
  published: { label: "Published", tone: "stable" },
  superseded: { label: "Superseded", tone: "muted" },
  withdrawn: { label: "Withdrawn", tone: "muted" },
};

const date = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");

type Load =
  | { status: "loading" }
  | { status: "ok"; releases: ManagedRelease[]; auditIntact: boolean }
  | { status: "disabled" }
  | { status: "error"; message: string };

/**
 * Release Manager: every release of every product HCG lets this account publish or approve, grouped by product as a
 * version history, with its stage. Approval and publication stay on each release's review page (a person, in the
 * browser, typing the version); this page never approves or publishes anything by itself.
 */
export function ReleaseManagerPage() {
  const { state: account } = useAccount();
  const location = useLocation();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [stage, setStage] = useState<ReleaseStage | "all">("all");

  useEffect(() => {
    if (account.status !== "signed-in") return;
    let live = true;
    storeApi
      .releaseManager()
      .then((r) => live && setLoad({ status: "ok", releases: r.releases, auditIntact: r.auditIntact }))
      .catch((e) => {
        if (!live) return;
        if (e instanceof StoreApiError && e.code === "publishing_disabled") setLoad({ status: "disabled" });
        else setLoad({ status: "error", message: e instanceof StoreApiError ? e.message : "The Release Manager could not be loaded right now." });
      });
    return () => {
      live = false;
    };
  }, [account]);

  const groups = useMemo(() => {
    if (load.status !== "ok") return [];
    const by = new Map<string, ManagedRelease[]>();
    for (const r of load.releases) if (stage === "all" || r.stage === stage) by.set(r.productId, [...(by.get(r.productId) ?? []), r]);
    return [...by.entries()].map(([productId, releases]) => ({ productId, title: releases[0]!.productTitle, releases }));
  }, [load, stage]);

  return (
    <>
      <PageMeta title="Release Manager" description="Releases you may publish or approve in HCG Store." noindex />
      <div className="page-width page-pad">
        <header className="page-head">
          <p className="eyebrow eyebrow--accent">Ship to Store</p>
          <h1>Release Manager</h1>
          <p className="page-head__lead">
            Releases of the products HCG lets your account publish or approve. Approval and publication are separate,
            manual steps on each release's review page; nothing is published automatically.
          </p>
        </header>

        {account.status === "loading" ? (
          <p className="muted">Checking your sign-in…</p>
        ) : account.status !== "signed-in" ? (
          <div className="panel">
            <h2>
              <IconLock className="inline-icon" /> Sign in to manage releases
            </h2>
            {account.status === "no-server" || account.status === "not-configured" ? (
              <p>Sign-in with HCG Connect is not available on this site yet.</p>
            ) : (
              <a className="button button--primary" href={signInUrl(location.pathname)}>
                Sign in with HCG Connect
              </a>
            )}
          </div>
        ) : load.status === "loading" ? (
          <p className="muted">Loading releases…</p>
        ) : load.status === "disabled" ? (
          <p className="notice" role="note">
            <IconInfo className="inline-icon" /> Publishing is not enabled on this Store yet.
          </p>
        ) : load.status === "error" ? (
          <p className="notice" role="alert">
            <IconInfo className="inline-icon" /> {load.message}
          </p>
        ) : (
          <>
            {!load.auditIntact && (
              <p className="notice" role="alert">
                <IconShield className="inline-icon" /> The publishing audit chain does not verify. Do not approve or publish until it is investigated.
              </p>
            )}
            <div className="rm-filter">
              <label>
                Stage{" "}
                <select value={stage} onChange={(e) => setStage(e.target.value as ReleaseStage | "all")}>
                  <option value="all">All stages</option>
                  {(Object.keys(STAGES) as ReleaseStage[]).map((s) => (
                    <option key={s} value={s}>
                      {STAGES[s].label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {load.releases.length === 0 ? (
              <div className="panel">
                <h2>No releases to show</h2>
                <p>
                  Either no release has been shipped yet, or HCG has not granted your account the HCG Store publishing or approval
                  permission for any product. Buying a product never grants either.
                </p>
              </div>
            ) : groups.length === 0 ? (
              <p className="muted">No release is at this stage.</p>
            ) : (
              groups.map((g) => <ProductReleases key={g.productId} title={g.title} releases={g.releases} />)
            )}
          </>
        )}
      </div>
    </>
  );
}

function ProductReleases({ title, releases }: { title: string; releases: ManagedRelease[] }) {
  return (
    <section className="panel rm-product" aria-label={`${title} releases`}>
      <h2>{title}</h2>
      <ol className="rm-list">
        {releases.map((r, i) => (
          <ReleaseRow key={r.id} release={r} previous={releases.slice(i + 1).find((x) => x.editionId === r.editionId) ?? null} />
        ))}
      </ol>
    </section>
  );
}

function ReleaseRow({ release: r, previous }: { release: ManagedRelease; previous: ManagedRelease | null }) {
  const [checks, setChecks] = useState<ChecksumReport | { error: string } | null>(null);
  const [cmp, setCmp] = useState<ReleaseComparison | { error: string } | null>(null);
  const st = STAGES[r.stage] ?? { label: r.stage, tone: "muted" };
  return (
    <li className="rm-release">
      <div className="rm-release__head">
        <h3>
          {r.version} <span className="muted">build {r.build}</span>
          {r.editionId && <span className="muted"> · {r.editionId}</span>}
        </h3>
        <span className={`badge badge--${st.tone}`}>{st.label}</span>
      </div>
      <dl className="kv kv--compact">
        <div>
          <dt>Channel</dt>
          <dd>{r.channel}</dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>{r.files}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>{r.requestedEligibility}</dd>
        </div>
        <div>
          <dt>Approved</dt>
          <dd>{r.approvedAt ? `${date(r.approvedAt)} (${r.approvedEligibility})` : "—"}</dd>
        </div>
        <div>
          <dt>Published</dt>
          <dd>{date(r.publishedAt)}</dd>
        </div>
        {r.withdrawnReason && (
          <div className="kv__wide">
            <dt>Withdrawn</dt>
            <dd>{r.withdrawnReason}</dd>
          </div>
        )}
      </dl>
      <div className="rm-release__actions">
        <a className="button button--ghost button--small" href={r.reviewUrl}>
          {(r.mayApprove || r.mayPublication) && (r.stage === "awaiting-approval" || r.stage === "approved") ? "Review, approve or publish" : "Open review page"}
        </a>
        {r.files > 0 && (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() =>
              storeApi
                .verifyChecksums(r.id)
                .then(setChecks)
                .catch((e) => setChecks({ error: e instanceof Error ? e.message : "Check failed." }))
            }
          >
            Verify checksums
          </button>
        )}
        {previous && (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() =>
              storeApi
                .compareReleases(previous.id, r.id)
                .then(setCmp)
                .catch((e) => setCmp({ error: e instanceof Error ? e.message : "Comparison failed." }))
            }
          >
            Compare with {previous.version} ({previous.build})
          </button>
        )}
      </div>
      {checks && (
        <p className={"error" in checks || !checks.ok ? "notice" : "fine"} role="status">
          {"error" in checks
            ? checks.error
            : checks.ok
              ? `All ${checks.files.length} stored file(s) match their recorded SHA-256.`
              : `Mismatch: ${checks.files.filter((f) => !f.ok).map((f) => f.fileName).join(", ")}. Withdraw this release and investigate.`}
        </p>
      )}
      {cmp &&
        ("error" in cmp ? (
          <p className="notice" role="status">{cmp.error}</p>
        ) : (
          <div className="rm-compare" role="status">
            <p>
              {cmp.from.version} → {cmp.to.version}:{" "}
              {cmp.fields.map((f) => `${f.field} ${String(f.from)} → ${String(f.to)}`).join(" · ") || "same details"}
            </p>
            <ul className="plain-list">
              {cmp.files.map((f, i) => (
                <li key={i}>
                  {f.change}: {f.platform} {f.format}
                  {f.architectures.length ? ` (${f.architectures.join(", ")})` : ""}
                  {typeof f.sizeDelta === "number" ? `, ${f.sizeDelta >= 0 ? "+" : ""}${f.sizeDelta} bytes` : ""}
                </li>
              ))}
              {cmp.releaseNotes.added.map((n) => (
                <li key={`+${n}`}>New note: {n}</li>
              ))}
            </ul>
          </div>
        ))}
    </li>
  );
}
