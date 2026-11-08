import { useState } from "react";
import { Link } from "react-router-dom";
import type { Catalogue } from "../domain/catalogue";
import { installGuidance } from "../domain/install-guidance";
import { resolveDownload, releaseHistory, RELEASE_ROLE_LABELS, releaseRole, currentRelease } from "../domain/model";
import type { Artifact, Product, Release } from "../domain/schema";
import { ARTIFACT_FORMATS, PLATFORMS, SIGNING_STATUS } from "../domain/taxonomy";
import { formatBytes, formatIsoDate } from "../lib/format";
import { ChannelBadge } from "./Badges";
import { IconCheck, IconCopy, IconDownload, IconInfo, IconShield } from "./Icons";

export function ReleaseMeta({ release }: { release: Release }) {
  return (
    <dl className="kv">
      <div>
        <dt>Version</dt>
        <dd className="mono">{release.version}</dd>
      </div>
      <div>
        <dt>Build</dt>
        <dd className="mono">{release.build ?? <span className="muted">Not stated</span>}</dd>
      </div>
      <div>
        <dt>Channel</dt>
        <dd>
          <ChannelBadge channel={release.channel} />
        </dd>
      </div>
      <div>
        <dt>Release date</dt>
        <dd>{release.releaseDate ? <time dateTime={release.releaseDate}>{formatIsoDate(release.releaseDate)}</time> : <span className="muted">Not supplied</span>}</dd>
      </div>
    </dl>
  );
}

export function ReleaseNotes({ release }: { release: Release }) {
  return (
    <div className="release-notes">
      <h4>Release notes</h4>
      {release.releaseNotes.length ? (
        <ul>
          {release.releaseNotes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">No release notes supplied.</p>
      )}
      {release.knownLimitations.length > 0 && (
        <>
          <h4>Known limitations</h4>
          <ul>
            {release.knownLimitations.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function CopyChecksum({ value }: { value: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied("idle"), 2500);
  };
  return (
    <span className="checksum">
      <code className="checksum__value">{value}</code>
      <button type="button" className="icon-button" onClick={copy}>
        {copied === "copied" ? <IconCheck /> : <IconCopy />}
        <span className="visually-hidden">Copy SHA-256 checksum</span>
      </button>
      <span role="status" className="checksum__status">
        {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed — select the text instead" : ""}
      </span>
    </span>
  );
}

export function SigningStatement({ artifact }: { artifact: Artifact }) {
  const { status, evidence } = artifact.signing;
  return (
    <div className="signing">
      <p>
        <IconShield className="inline-icon" /> {SIGNING_STATUS[status]}
      </p>
      {evidence && <p className="signing__evidence">Evidence supplied: {evidence}</p>}
      <p className="fine">HCG Store shows what HCG has stated. It does not verify signatures or file safety.</p>
    </div>
  );
}

/** A normal link navigation to the provider. No `download` attribute, no fetching into memory. */
function DownloadAction({ release, artifact }: { release: Release; artifact: Artifact }) {
  const [requested, setRequested] = useState(false);
  const resolved = resolveDownload(release, artifact);
  if (!resolved) {
    return (
      <p className="unavailable">
        <IconInfo className="inline-icon" />
        {release.status === "withdrawn" ? "Withdrawn — download disabled." : "No download link supplied for this file."}
      </p>
    );
  }
  return (
    <div className="download">
      <a className="button button--primary" href={resolved.href} rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={() => setRequested(true)}>
        <IconDownload /> Download {ARTIFACT_FORMATS[artifact.format].split(" (")[0]}
        <span className="visually-hidden"> {artifact.fileName} from {resolved.providerLabel}</span>
      </a>
      <p className="fine">{resolved.disclosure}</p>
      <p role="status" aria-live="polite" className="download__status">
        {requested
          ? `Download requested from ${resolved.providerLabel}. Your browser handles the transfer; HCG Store cannot confirm it finished or that anything was installed.`
          : ""}
      </p>
    </div>
  );
}

export function ArtifactCard({ release, artifact, showGuidance = true }: { release: Release; artifact: Artifact; showGuidance?: boolean }) {
  const guidance = installGuidance(artifact.format);
  return (
    <section className="artifact" aria-label={`${PLATFORMS[artifact.platform].label} file ${artifact.fileName}`}>
      <header className="artifact__head">
        <h4>
          {PLATFORMS[artifact.platform].label}
          {artifact.architectures.length > 0 && <span className="artifact__arch"> · {artifact.architectures.join(", ")}</span>}
        </h4>
        <span className="artifact__format">{ARTIFACT_FORMATS[artifact.format]}</span>
      </header>
      <dl className="kv kv--compact">
        <div>
          <dt>File</dt>
          <dd className="mono break">{artifact.fileName}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(artifact.sizeBytes) ?? <span className="muted">Not stated</span>}</dd>
        </div>
        <div>
          <dt>Minimum OS</dt>
          <dd>{artifact.minimumOs ?? <span className="muted">Not verified</span>}</dd>
        </div>
        <div className="kv__wide">
          <dt>SHA-256</dt>
          <dd>{artifact.sha256 ? <CopyChecksum value={artifact.sha256} /> : <span className="muted">No checksum published</span>}</dd>
        </div>
      </dl>
      <SigningStatement artifact={artifact} />
      <DownloadAction release={release} artifact={artifact} />
      {showGuidance && (
        <details className="guidance">
          <summary>How to install: {guidance.title}</summary>
          <ol>
            {guidance.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {guidance.cautions.map((c) => (
            <p key={c} className="caution">
              {c}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}

/** Sidebar panel on the product page. */
export function ReleasePanel({ catalogue, product }: { catalogue: Catalogue; product: Product }) {
  const cur = currentRelease(catalogue, product);
  const history = releaseHistory(catalogue, product);
  return (
    <aside className="release-panel" aria-labelledby="release-panel-title">
      <div className="release-panel__head">
        <p className="eyebrow">Release information</p>
        <h2 id="release-panel-title">{cur ? `Version ${cur.version}` : "No public release supplied"}</h2>
        {cur && <p className="release-panel__role">{RELEASE_ROLE_LABELS.current}</p>}
      </div>

      {cur ? (
        <>
          <ReleaseMeta release={cur} />
          {cur.artifacts.length ? (
            <div className="artifact-list">
              {cur.artifacts.map((a) => (
                <ArtifactCard key={a.id} release={cur} artifact={a} />
              ))}
            </div>
          ) : (
            <p className="unavailable">
              <IconInfo className="inline-icon" /> HCG has published release information but no downloadable file for this release.
            </p>
          )}
          <ReleaseNotes release={cur} />
        </>
      ) : (
        <div className="release-panel__empty">
          <p>HCG has not supplied an approved public release of {product.name} to HCG Store.</p>
          <p className="muted">Development activity does not mean a downloadable build exists. Releases appear here only after HCG approves them.</p>
        </div>
      )}

      <Link className="button button--ghost button--block" to={`/apps/${product.slug}/releases`}>
        Release history ({history.length})
      </Link>
    </aside>
  );
}

export function ReleaseHistoryItem({ catalogue, product, release }: { catalogue: Catalogue; product: Product; release: Release }) {
  const role = releaseRole(catalogue, product, release);
  return (
    <li className={`history-item history-item--${role}`} id={`release-${release.id}`}>
      <div className="history-item__rail" aria-hidden="true" />
      <article className="history-item__card">
        <header className="history-item__head">
          <h2>
            <span className="mono">v{release.version}</span>
          </h2>
          <span className={`role-badge role-badge--${role}`}>{RELEASE_ROLE_LABELS[role]}</span>
        </header>
        {release.status === "withdrawn" && release.withdrawnReason && <p className="caution">Withdrawn: {release.withdrawnReason}</p>}
        <ReleaseMeta release={release} />
        <ReleaseNotes release={release} />
        {release.artifacts.length > 0 ? (
          <div className="artifact-list">
            {release.artifacts.map((a) => (
              <ArtifactCard key={a.id} release={release} artifact={a} showGuidance={false} />
            ))}
          </div>
        ) : (
          <p className="muted">No files listed for this release.</p>
        )}
      </article>
    </li>
  );
}
