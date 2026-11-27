import { downloadUrl, type AccessFile, type AccessFileDetails } from "../account/api";
import { formatBytes } from "../lib/format";
import { IconDownload, IconInfo, IconShield } from "./Icons";

/**
 * The download section of a product edition: one card per platform with each file's real version, architecture,
 * size, release status and SHA-256, all from the HCG Store server (the published release record). The button is only
 * a link to HCG Store's own download endpoint, which checks again on every request.
 */

type File = AccessFile & { details: AccessFileDetails };

const PLATFORM_NAMES: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux", ios: "iPhone", ipados: "iPad", android: "Android" };
const PLATFORM_ORDER = ["windows", "macos", "linux", "ios", "ipados", "android"];

export function targetLabel(platform: string, archs: string[]): string {
  const a = archs.join(", ");
  if (platform === "windows") return archs.includes("arm64") && archs.length === 1 ? "Windows on ARM (ARM64)" : `Windows ${a || "x64"}`;
  if (platform === "macos") {
    if (archs.length === 1 && archs[0] === "arm64") return "Apple Silicon (M-series)";
    if (archs.length === 1 && archs[0] === "x64") return "Intel Mac";
    return archs.length ? `macOS ${a}` : "macOS";
  }
  return `${PLATFORM_NAMES[platform] ?? platform}${a ? ` ${a}` : ""}`;
}

export function buttonLabel(platform: string, format: string): string {
  if (format === "exe") return "Download EXE";
  if (format === "msi") return "Download Installer (.msi)";
  if (format === "msix") return "Download Installer (.msix)";
  if (format === "pkg") return "Download Installer (.pkg)";
  if (format === "dmg") return "Download Disk Image (.dmg)";
  if (format === "zip") return platform === "macos" ? "Download Application (.zip)" : "Download Portable App (.zip)";
  return `Download .${format}`;
}

function formatNote(platform: string, format: string): string | null {
  if (platform === "macos" && format === "pkg") return "Installer: puts HCG Mail in your Applications folder.";
  if (platform === "macos" && format === "zip") return "Compressed application bundle: unzip, then move the app to Applications yourself.";
  if (platform === "windows" && format === "exe") return "Single self-contained program: runs without installation.";
  return null;
}

function statusLabel(channel: string): string {
  return channel === "beta" ? "Public Beta" : channel === "stable" ? "Stable" : channel;
}

export function DownloadSection({ files, anonymous }: { files: AccessFile[]; anonymous: boolean }) {
  const ready = files.filter((f): f is File => !!f.details);
  const platforms = [...new Set(ready.map((f) => f.details.platform))].sort((a, b) => PLATFORM_ORDER.indexOf(a) - PLATFORM_ORDER.indexOf(b));
  return (
    <section className="downloads" aria-label="Downloads">
      <p className="downloads__lead">
        <IconDownload className="inline-icon" /> {anonymous ? "Free download: no HCG account, payment or subscription needed." : "Your downloads."}
      </p>
      <div className="downloads__grid">
        {platforms.map((platform) => {
          const group = ready.filter((f) => f.details.platform === platform);
          const unsigned = group.some((f) => ["unsigned", "not-checked", "invalid"].includes(f.details.signing));
          return (
            <article key={platform} className="download-card" aria-labelledby={`dl-${platform}`}>
              <header className="download-card__head">
                <h4 id={`dl-${platform}`} className="download-card__platform">
                  {PLATFORM_NAMES[platform] ?? platform}
                </h4>
                {group.some((f) => f.details.channel === "beta") && <span className="badge badge--beta">Public Beta</span>}
              </header>
              <ul className="download-card__files">
                {group.map((f) => (
                  <li key={f.id} className="download-file">
                    <p className="download-file__target">{targetLabel(platform, f.details.architectures)}</p>
                    <dl className="download-file__facts">
                      <div>
                        <dt>Version</dt>
                        <dd>{f.details.version}</dd>
                      </div>
                      <div>
                        <dt>Architecture</dt>
                        <dd>{f.details.architectures.join(", ") || "Any"}</dd>
                      </div>
                      <div>
                        <dt>Size</dt>
                        <dd>{formatBytes(f.details.sizeBytes)}</dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{statusLabel(f.details.channel)}</dd>
                      </div>
                    </dl>
                    {formatNote(platform, f.details.format) && <p className="download-file__note">{formatNote(platform, f.details.format)}</p>}
                    <a className="button button--primary download-file__button" href={downloadUrl(f.id)} download={f.fileName}>
                      <IconDownload /> {buttonLabel(platform, f.details.format)}
                    </a>
                    <details className="download-file__checksum">
                      <summary>
                        {f.fileName} · SHA-256
                      </summary>
                      <code className="mono break">{f.details.sha256}</code>
                    </details>
                  </li>
                ))}
              </ul>
              <InstallHelp platform={platform} unsigned={unsigned} files={group} />
            </article>
          );
        })}
      </div>
    </section>
  );
}

function InstallHelp({ platform, unsigned, files }: { platform: string; unsigned: boolean; files: File[] }) {
  const exe = files.find((f) => f.details.format === "exe");
  if (platform === "windows") {
    return (
      <div className="download-card__help">
        {unsigned && (
          <p className="download-card__warning" role="note">
            <IconShield className="inline-icon" /> <strong>Not code-signed.</strong> Windows SmartScreen may show "Windows protected your PC". Choose{" "}
            <em>More info</em>, then <em>Run anyway</em>, only if the file's SHA-256 matches the one shown here.
          </p>
        )}
        <h5 className="download-card__help-title">Installation</h5>
        <ol className="plain-list download-card__steps">
          <li>Download {exe ? <code>{exe.fileName}</code> : "the file"}.</li>
          <li>
            Optional: check it in PowerShell with <code>Get-FileHash .\{exe?.fileName ?? "HCGMail.exe"}</code> and compare the SHA-256.
          </li>
          <li>Double-click the file to start HCG Mail. No installation or administrator rights are needed.</li>
          <li>Add your email account with its IMAP and SMTP settings.</li>
        </ol>
      </div>
    );
  }
  if (platform === "macos") {
    return (
      <div className="download-card__help">
        {unsigned && (
          <p className="download-card__warning" role="note">
            <IconShield className="inline-icon" /> <strong>Not notarized by Apple.</strong> macOS blocks the first start. Open System Settings → Privacy &amp; Security and
            choose <em>Open Anyway</em>, only if the file's SHA-256 matches the one shown here.
          </p>
        )}
        <h5 className="download-card__help-title">Installation</h5>
        <ol className="plain-list download-card__steps">
          <li>Installer (.pkg): open it and follow the steps; HCG Mail is placed in Applications.</li>
          <li>Application (.zip): open the ZIP, then drag HCG Mail to Applications.</li>
          <li>Start HCG Mail and add your email account with its IMAP and SMTP settings.</li>
        </ol>
      </div>
    );
  }
  return (
    <p className="download-card__help">
      <IconInfo className="inline-icon" /> Compare the SHA-256 shown here before you open the file.
    </p>
  );
}
