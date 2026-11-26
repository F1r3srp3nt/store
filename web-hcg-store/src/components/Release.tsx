import { useState } from "react";
import { Link } from "react-router-dom";
import type { Catalogue } from "../domain/catalogue";
import { installGuidance } from "../domain/install-guidance";
import { releaseHistory, RELEASE_ROLE_LABELS, releaseRole, currentRelease } from "../domain/model";
import type { Artifact, Product, Release } from "../domain/schema";
import { ARTIFACT_FORMATS, PLATFORMS, SIGNING_STATUS } from "../domain/taxonomy";
import { formatBytes, formatIsoDate } from "../lib/format";
import { ChannelBadge } from "./Badges";
import { IconCheck, IconCopy, IconInfo, IconLock, IconShield } from "./Icons";

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

/** Files are never linked publicly. Owners download them from the access panel after sign-in. */
function DeliveryNote({ release }: { release: Release }) {
  return (
    <p className="unavailable">
      {release.status === "withdrawn" ? (
        <>
          <IconInfo className="inline-icon" /> Withdrawn — not delivered.
        </>
      ) : (
        <>
          <IconLock className="inline-icon" /> Delivered only to signed-in HCG accounts with access. {DOWNLOADS_NOT_AVAILABLE_HINT}
        </>
      )}
    </p>
  );
}

const DOWNLOADS_NOT_AVAILABLE_HINT = "Accounts with access download it under Editions, price and availability when downloads are available.";

/** Plain file-type label: Windows installers and portable ZIPs are named as such. */
function fileTypeLabel(artifact: Artifact): string {
  if (artifact.platform === "windows" && artifact.format === "exe") return "Installer (.exe)";
  if (artifact.platform === "windows" && artifact.format === "msi") return "Installer (.msi)";
  if (artifact.platform === "windows" && artifact.format === "zip") return "Portable ZIP (no installation)";
  return ARTIFACT_FORMATS[artifact.format];
}
const ARCH_LABELS: Record<string, string> = { x64: "x64", arm64: "ARM64", x86: "x86" };

export function ArtifactCard({ release, artifact, showGuidance = true }: { release: Release; artifact: Artifact; showGuidance?: boolean }) {
  const guidance = installGuidance(artifact.format, artifact.platform);
  return (
    <section className="artifact" aria-label={`${PLATFORMS[artifact.platform].label} file ${artifact.fileName}`}>
      <header className="artifact__head">
        <h4>
          {PLATFORMS[artifact.platform].label}
          {artifact.architectures.length > 0 && <span className="artifact__arch"> · {artifact.architectures.map((a) => ARCH_LABELS[a] ?? a).join(", ")}</span>}
        </h4>
        <span className="artifact__format">{fileTypeLabel(artifact)}</span>
      </header>
      <dl className="kv kv--compact">
        <div>
          <dt>File</dt>
          <dd className="mono break">{artifact.fileName}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>
            {artifact.sizeBytes === null ? (
              <span className="muted">Not stated</span>
            ) : (
              <>
                {formatBytes(artifact.sizeBytes)} <span className="muted">({artifact.sizeBytes.toLocaleString("en-US")} bytes)</span>
              </>
            )}
          </dd>
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
      <DeliveryNote release={release} />
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
        <h2 id="release-panel-title">{cur ? `Version ${cur.version}` : "Coming soon"}</h2>
        {cur && <p className="release-panel__role">{RELEASE_ROLE_LABELS.current}</p>}
      </div>

      {cur ? (
        <>
          <ReleaseMeta release={cur} />
          {cur.artifacts.some((a) => a.signing.status === "unsigned") && (
            <p className="caution caution--strong" role="note">
              <IconShield className="inline-icon" /> <strong>Not code-signed.</strong> Windows SmartScreen shows "Windows protected your PC". Run a file
              only if its SHA-256 matches the checksum shown here (PowerShell: <code>Get-FileHash .\&lt;file&gt;</code>).
            </p>
          )}
          {cur.artifacts.length ? (
            <div className="artifact-list">
              {cur.artifacts.map((a) => (
                <ArtifactCard key={a.id} release={cur} artifact={a} />
              ))}
            </div>
          ) : (
            <p className="unavailable">
              <IconInfo className="inline-icon" /> HCG has published release information but no file for this release.
            </p>
          )}
          <ReleaseNotes release={cur} />
        </>
      ) : (
        <div className="release-panel__empty">
          <p>HCG has not approved a release of {product.name} for HCG Store yet.</p>
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
