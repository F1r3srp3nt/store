import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAccount } from "../account/account-context";
import { downloadUrl, storeApi, type AccessFile, type AccessFileDetails, type EditionAccess } from "../account/api";
import { useAdminMe } from "../admin/useAdminMe";
import { IconArrowRight, IconCheck, IconClose, IconCopy, IconDownload, IconExternal, IconInfo, IconShield } from "../components/Icons";
import { PageMeta } from "../components/PageMeta";
import { ProductMark } from "../components/ProductArt";
import type { Catalogue } from "../domain/catalogue";
import { currentRelease, listedProducts } from "../domain/model";
import type { Media, Product, Release } from "../domain/schema";
import { PLATFORMS } from "../domain/taxonomy";
import { assetUrl, formatBytes } from "../lib/format";
import { useMotionAllowed } from "../theme/ThemeContext";

/**
 * Launch page for a product with a current published release (catalogue `landing` content + HCG Store data).
 *
 * Marketing content (headline, features, screenshots, upcoming platforms) comes from the catalogue. Everything that
 * describes the release (version, files, sizes, architectures, signing, price, availability, release notes) comes from
 * HCG Store: the current release record and the live access decision. Download buttons are links to HCG Store's own
 * download endpoint (`/api/v1/downloads/<file>`), which checks again on every request; no URL is written here.
 */

type File = AccessFile & { details: AccessFileDetails };
type Live = { status: "loading" } | { status: "ready"; editions: EditionAccess[] } | { status: "unavailable" };

const PLATFORM_ORDER = ["windows", "macos", "linux", "ios", "ipados", "android"];

function targetLabel(platform: string, archs: string[]): string {
  if (platform === "windows") return archs.length === 1 && archs[0] === "arm64" ? "Windows on ARM" : `Windows ${archs.join(", ") || "x64"}`;
  if (platform === "macos") return archs.length === 1 && archs[0] === "arm64" ? "Apple Silicon (M-series)" : archs.length === 1 && archs[0] === "x64" ? "Intel Mac" : "macOS";
  return `${PLATFORMS[platform as keyof typeof PLATFORMS]?.label ?? platform}${archs.length ? ` ${archs.join(", ")}` : ""}`;
}
function formatName(platform: string, format: string): string {
  if (format === "exe") return "EXE";
  if (format === "pkg") return "Installer (.pkg)";
  if (format === "zip") return platform === "macos" ? "Application (.zip)" : "Portable (.zip)";
  return `.${format}`;
}
const statusOf = (channel: string) => (channel === "beta" ? "Public Beta" : "Stable");

function useLiveAccess(product: Product): Live {
  const { state: account } = useAccount();
  const [live, setLive] = useState<Live>({ status: "loading" });
  useEffect(() => {
    if (account.status === "loading") return;
    if (account.status === "no-server") return setLive({ status: "unavailable" });
    let on = true;
    storeApi.access(product.slug).then((r) => on && setLive({ status: "ready", editions: r.editions })).catch(() => on && setLive({ status: "unavailable" }));
    return () => {
      on = false;
    };
  }, [account.status, product.slug]);
  return live;
}

export function ProductLaunch({ catalogue, product }: { catalogue: Catalogue; product: Product }) {
  const landing = product.landing!;
  const release = currentRelease(catalogue, product)!;
  const live = useLiveAccess(product);
  const files: File[] = live.status === "ready"
    ? live.editions.filter((e) => e.downloadsAvailable).flatMap((e) => e.artifacts).filter((a): a is File => !!a.details)
    : [];
  const anonymous = live.status === "ready" && live.editions.some((e) => e.anonymous && e.downloadsAvailable);
  const primary = [...files].sort((a, b) => PLATFORM_ORDER.indexOf(a.details.platform) - PLATFORM_ORDER.indexOf(b.details.platform))[0] ?? null;
  const free = product.editions.some((e) => e.pricingModel === "free") || anonymous;
  const screenshots = product.media.filter((m) => m.kind === "screenshot");
  const [viewer, setViewer] = useState<number | null>(null);
  const heroRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLElement>(null);
  const sticky = useStickyVisible(heroRef, bottomRef);
  const motion = useMotionAllowed();

  return (
    <div className={`launch${motion ? " launch--motion" : ""}`} data-product={product.id}>
      <PageMeta
        title={`${product.name}: ${landing.headline.replace(/\.$/, "")}`}
        description={`${landing.tagline} ${statusOf(release.channel)} ${release.version}${primary ? ` for ${targetLabel(primary.details.platform, primary.details.architectures)}` : ""}${free ? ", free" : ""}.`}
      />
      <div className="launch__backdrop" aria-hidden="true" />

      {/* ------------------------------------------------------------------ hero */}
      <section ref={heroRef} className="launch-hero page-width" aria-labelledby="launch-title">
        <div className="launch-hero__copy">
          <nav aria-label="Breadcrumb" className="breadcrumb launch-breadcrumb">
            <ol>
              <li><Link to="/apps">Products</Link></li>
              <li aria-current="page">{product.name}</li>
            </ol>
          </nav>
          <div className="launch-hero__brand">
            <LaunchIcon product={product} />
            <div>
              <h1 id="launch-title" className="launch-hero__name">{product.name}</h1>
              <p className="launch-hero__byline">A Hakmi Capital Group application</p>
            </div>
          </div>
          <p className="launch-hero__status">
            <span className="launch-pulse" aria-hidden="true" />
            {statusOf(release.channel)} — {live.status === "ready" && !primary ? "Published" : "Available now"}
          </p>
          <p className="launch-hero__headline">{landing.headline}</p>
          <p className="launch-hero__tagline">{landing.tagline}</p>
          <dl className="launch-hero__facts">
            <div><dt>Version</dt><dd>{release.version}</dd></div>
            <div><dt>Price</dt><dd>{free ? "Free" : "See editions"}</dd></div>
            {primary && <div><dt>Platform</dt><dd>{targetLabel(primary.details.platform, primary.details.architectures)}</dd></div>}
            {primary && <div><dt>Size</dt><dd>{formatBytes(primary.details.sizeBytes)}</dd></div>}
            {anonymous && <div><dt>Account</dt><dd>None required</dd></div>}
          </dl>
          <DownloadAction live={live} file={primary} big />
          {primary && <UnsignedNote file={primary} />}
          {landing.upcoming.length > 0 && (
            <p className="launch-hero__upcoming">
              {landing.upcoming.map((u) => <span key={u.platform} className="launch-chip">{u.label}: coming soon</span>)}
            </p>
          )}
        </div>
        {screenshots[0] && (
          <figure className="launch-hero__shot">
            <button type="button" className="launch-shot-button" onClick={() => setViewer(0)} aria-label={`View full screen: ${screenshots[0].alt}`}>
              <Shot media={screenshots[0]} eager sizes="(max-width: 980px) 100vw, 720px" />
            </button>
            <figcaption>Genuine HCG Mail interface · {screenshots[0].caption.split(".")[0]}.</figcaption>
          </figure>
        )}
      </section>

      <div className="page-width launch-body">
        <AdminLink productId={product.id} />

        {/* --------------------------------------------------------------- gallery */}
        {screenshots.length > 1 && (
          <section className="launch-section" aria-labelledby="gallery-title">
            <SectionHead eyebrow="See it in action" id="gallery-title" title={`Inside ${product.name}`}>
              Genuine screens of the app, rendered by its own automated UI tests with test accounts and sample messages. Select one to view it full screen.
            </SectionHead>
            <ul className="launch-gallery">
              {screenshots.map((m, i) => (
                <li key={m.src}>
                  <button type="button" className="launch-gallery__item" onClick={() => setViewer(i)} aria-label={`View full screen: ${m.alt}`}>
                    <Shot media={m} sizes="(max-width: 700px) 100vw, 400px" />
                  </button>
                  <p className="launch-gallery__caption">{m.caption}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* -------------------------------------------------------------- features */}
        {landing.features.length > 0 && (
          <section className="launch-section" aria-labelledby="features-title">
            <SectionHead eyebrow="Features" id="features-title" title="Everything your inbox needs. Nothing it doesn't." />
            <ul className="launch-features">
              {landing.features.map((f) => (
                <li key={f.title} className="launch-feature">
                  <span className="launch-feature__icon" aria-hidden="true"><FeatureIcon name={f.icon} /></span>
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ------------------------------------------------------------- platforms */}
        <section className="launch-section" id="download" aria-labelledby="platforms-title">
          <SectionHead eyebrow="Download" id="platforms-title" title="Choose your platform" />
          <div className="launch-platforms">
            {live.status === "loading" && <p className="muted">Checking what is available…</p>}
            {live.status === "unavailable" && <p className="notice" role="note"><IconInfo className="inline-icon" /> Downloads could not be checked right now. Try again shortly.</p>}
            {groupByPlatform(files).map(([platform, group]) => (
              <article key={platform} className="launch-platform launch-platform--available" aria-labelledby={`plat-${platform}`}>
                <header>
                  <h3 id={`plat-${platform}`}>{PLATFORMS[platform as keyof typeof PLATFORMS]?.label ?? platform}</h3>
                  <span className="launch-badge launch-badge--live">Available now</span>
                </header>
                {group.map((f) => (
                  <div key={f.id} className="launch-platform__file">
                    <p className="launch-platform__target">{targetLabel(platform, f.details.architectures)}</p>
                    <dl className="launch-platform__facts">
                      <div><dt>Status</dt><dd>{statusOf(f.details.channel)}</dd></div>
                      <div><dt>Version</dt><dd>{f.details.version}</dd></div>
                      <div><dt>Format</dt><dd>{formatName(platform, f.details.format)}</dd></div>
                      <div><dt>Size</dt><dd>{formatBytes(f.details.sizeBytes)}</dd></div>
                      <div><dt>Price</dt><dd>{free ? "Free" : "—"}</dd></div>
                    </dl>
                    <DownloadAction live={live} file={f} />
                    <UnsignedNote file={f} />
                  </div>
                ))}
              </article>
            ))}
            {landing.upcoming.map((u) => (
              <article key={u.platform} className="launch-platform launch-platform--upcoming" aria-labelledby={`plat-up-${u.platform}`}>
                <header>
                  <h3 id={`plat-up-${u.platform}`}>{PLATFORMS[u.platform].label}</h3>
                  <span className="launch-badge">Coming soon</span>
                </header>
                <p className="launch-platform__target">{u.label}</p>
                <p className="muted">{u.note}</p>
                <p className="launch-platform__none">No download is offered yet.</p>
              </article>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------------- technical */}
        <section className="launch-section" aria-labelledby="details-title">
          <SectionHead eyebrow="Details" id="details-title" title="Technical information" />
          <div className="launch-details">
            <Details title="Known beta limitations" open>
              <ul className="launch-list">{release.knownLimitations.map((l) => <li key={l}>{l}</li>)}</ul>
            </Details>
            <Details title="System requirements">
              <ul className="launch-list">
                {product.requirements.filter((r) => !/^iPhone|^iPad/i.test(r)).map((r) => <li key={r}>{r}</li>)}
                {files.map((f) => f.details.minimumOs && <li key={f.id}>{f.fileName}: {f.details.minimumOs} or later, {f.details.architectures.join(", ")}</li>)}
              </ul>
            </Details>
            <Details title="Installation">
              <InstallSteps files={files} />
            </Details>
            <Details title={`Release notes · ${release.version}`}>
              <ul className="launch-list">{release.releaseNotes.map((n) => <li key={n}>{n}</li>)}</ul>
            </Details>
            <Details title="Signing and verification" id="verify">
              {files.length === 0 && <p className="muted">File details appear when downloads are available.</p>}
              {files.map((f) => (
                <div key={f.id} className="launch-verify">
                  <p>
                    <strong>{f.fileName}</strong> · {f.details.signing === "unsigned" ? "Not code-signed" : f.details.signing === "notarized" ? "Signed and notarised" : f.details.signing === "signed" ? "Signed" : "Signing not stated"} ·{" "}
                    {f.details.sizeBytes.toLocaleString("en")} bytes
                  </p>
                  <Checksum value={f.details.sha256 ?? ""} />
                  {f.details.platform === "windows" && <p className="muted">In PowerShell: <code>Get-FileHash .\{f.fileName}</code> must print the same SHA-256.</p>}
                  {f.details.platform === "macos" && <p className="muted">In Terminal: <code>shasum -a 256 {f.fileName}</code> must print the same SHA-256.</p>}
                </div>
              ))}
            </Details>
            <Details title="Release history">
              <ReleaseHistory catalogue={catalogue} product={product} current={release} />
            </Details>
            <Details title="Support and feedback">
              <ul className="launch-list">
                {product.support.map((s) => <li key={s.url}><a className="text-link" href={s.url} rel="noopener noreferrer">{s.label} <IconExternal /></a></li>)}
                {product.documentation.map((s) => <li key={s.url}><a className="text-link" href={s.url} rel="noopener noreferrer">{s.label} <IconExternal /></a></li>)}
                <li>Tell us what works and what does not: this beta exists to find out.</li>
              </ul>
            </Details>
          </div>
        </section>

        {/* ------------------------------------------------------------ bottom CTA */}
        <section ref={bottomRef} className="launch-cta" aria-labelledby="cta-title">
          <LaunchIcon product={product} />
          <h2 id="cta-title">{landing.headline}</h2>
          <p>{product.name} {release.version} · {statusOf(release.channel)}{free ? " · Free" : ""}{anonymous ? " · No account required" : ""}</p>
          <DownloadAction live={live} file={primary} big />
          {primary && <UnsignedNote file={primary} />}
        </section>

        {/* ------------------------------------------------------------- ecosystem */}
        <Ecosystem catalogue={catalogue} product={product} principle={landing.principle} />
      </div>

      {primary && (
        <div className={`launch-sticky${sticky ? " is-visible" : ""}`} aria-hidden={!sticky}>
          <div className="page-width launch-sticky__inner">
            <span className="launch-sticky__name">
              <LaunchIcon product={product} small /> {product.name} <span className="muted">{release.version} · {free ? "Free" : ""}</span>
            </span>
            <DownloadAction live={live} file={primary} compact tabIndex={sticky ? 0 : -1} />
          </div>
        </div>
      )}

      {viewer !== null && <Lightbox items={screenshots} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------- pieces

function SectionHead({ eyebrow, id, title, children }: { eyebrow: string; id: string; title: string; children?: ReactNode }) {
  return (
    <header className="launch-section__head">
      <p className="eyebrow eyebrow--accent">{eyebrow}</p>
      <h2 id={id}>{title}</h2>
      {children && <p className="launch-section__lead">{children}</p>}
    </header>
  );
}

function LaunchIcon({ product, small }: { product: Product; small?: boolean }) {
  const icon = product.artwork.icon;
  if (!icon) return <ProductMark product={product} size={small ? "sm" : "lg"} />;
  const srcs = [...icon.variants, { src: icon.src, width: icon.width }].sort((a, b) => a.width - b.width);
  const set = (ext: string) => srcs.map((v) => `${assetUrl(ext === "avif" ? v.src.replace(/\.webp$/, ".avif") : v.src)} ${v.width}w`).join(", ");
  const sizes = small ? "28px" : "(max-width: 600px) 72px, 104px";
  return (
    <picture className={`launch-icon${small ? " launch-icon--small" : ""}`}>
      {icon.avif && <source type="image/avif" srcSet={set("avif")} sizes={sizes} />}
      <img src={assetUrl(icon.src)} srcSet={set("webp")} sizes={sizes} width={icon.width} height={icon.height} alt="" decoding="async" />
    </picture>
  );
}

function Shot({ media, eager, sizes }: { media: Media; eager?: boolean; sizes: string }) {
  const set = [...media.variants, { src: media.src, width: media.width }].map((v) => `${assetUrl(v.src)} ${v.width}w`).join(", ");
  return (
    <img
      className="launch-shot"
      src={assetUrl(media.src)}
      srcSet={set}
      sizes={sizes}
      width={media.width}
      height={media.height}
      alt={media.alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
    />
  );
}

function DownloadAction({ live, file, big, compact, tabIndex }: { live: Live; file: File | null; big?: boolean; compact?: boolean; tabIndex?: number }) {
  if (live.status === "loading") return <span className="button button--ghost launch-download is-pending" aria-live="polite">Checking availability…</span>;
  if (!file) return <a className="button button--ghost launch-download" href="#download" tabIndex={tabIndex}>See download options</a>;
  const where = file.details.platform === "windows" ? "Windows" : file.details.platform === "macos" ? "macOS" : PLATFORMS[file.details.platform as keyof typeof PLATFORMS]?.label ?? file.details.platform;
  return (
    <a
      className={`button button--primary launch-download${big ? " launch-download--big" : ""}${compact ? " launch-download--compact" : ""}`}
      href={downloadUrl(file.id)}
      download={file.fileName}
      tabIndex={tabIndex}
      data-testid="launch-download"
    >
      <IconDownload />
      <span className="launch-download__text">
        <span>Download for {where}</span>
        {!compact && <small>{targetLabel(file.details.platform, file.details.architectures)} · {formatName(file.details.platform, file.details.format)} · {formatBytes(file.details.sizeBytes)}</small>}
      </span>
    </a>
  );
}

function UnsignedNote({ file }: { file: File }) {
  if (!["unsigned", "not-checked", "invalid", "not-stated"].includes(file.details.signing)) return null;
  return (
    <p className="launch-warning" role="note">
      <IconShield className="inline-icon" />
      {file.details.platform === "windows" ? (
        <span>
          <strong>Not code-signed.</strong> Windows SmartScreen may show "Windows protected your PC". Choose <em>More info</em> → <em>Run anyway</em> only if the file's{" "}
          <a className="text-link" href="#verify">SHA-256</a> matches.
        </span>
      ) : (
        <span>
          <strong>Not notarised by Apple.</strong> macOS blocks the first start; compare the <a className="text-link" href="#verify">SHA-256</a> before you allow it.
        </span>
      )}
    </p>
  );
}

function Details({ title, children, open, id }: { title: string; children: ReactNode; open?: boolean; id?: string }) {
  return (
    <details className="launch-detail" open={open} id={id}>
      <summary>{title}</summary>
      <div className="launch-detail__body">{children}</div>
    </details>
  );
}

function Checksum({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="launch-checksum">
      <span className="launch-checksum__label">SHA-256</span>
      <code className="mono break" data-testid="launch-sha256">{value}</code>
      <button type="button" className="button button--ghost button--small" onClick={() => void copy()}>
        {copied ? <><IconCheck /> Copied</> : <><IconCopy /> Copy</>}
      </button>
    </div>
  );
}

function InstallSteps({ files }: { files: File[] }) {
  const win = files.find((f) => f.details.platform === "windows");
  return (
    <ol className="launch-list launch-list--steps">
      {win ? (
        <>
          <li>Download <code>{win.fileName}</code> ({formatBytes(win.details.sizeBytes)}).</li>
          <li>Optional, recommended: check its SHA-256 (see Signing and verification).</li>
          <li>Double-click the file. It is a single self-contained program: no installation, administrator rights or .NET installation needed.</li>
          <li>If SmartScreen appears, choose More info → Run anyway (the beta is not code-signed).</li>
          <li>Add your email account with its IMAP and SMTP settings and run the connection test.</li>
        </>
      ) : (
        <li>Installation steps appear here when a download is available for your platform.</li>
      )}
    </ol>
  );
}

function ReleaseHistory({ catalogue, product, current }: { catalogue: Catalogue; product: Product; current: Release }) {
  const rels = catalogue.releases.filter((r) => r.productId === product.id).sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""));
  return (
    <>
      <ul className="launch-list">
        {rels.map((r) => (
          <li key={r.id}>
            <strong>{r.version}</strong> · {statusOf(r.channel)} · {r.releaseDate ?? "date not stated"}
            {r.id === current.id ? " · current" : r.status === "withdrawn" ? " · withdrawn" : ""}
          </li>
        ))}
      </ul>
      <p><Link className="text-link" to={`/apps/${product.slug}/releases`}>Full release history <IconArrowRight /></Link></p>
    </>
  );
}

function Ecosystem({ catalogue, product, principle }: { catalogue: Catalogue; product: Product; principle: string | null }) {
  const others = listedProducts(catalogue).filter((p) => p.id !== product.id && p.collections.includes("featured")).slice(0, 4);
  return (
    <section className="launch-ecosystem" aria-labelledby="eco-title">
      <img className="launch-ecosystem__mark" src={assetUrl("brand/hcg-mark-480.webp")} width={480} height={218} alt="Hakmi Capital Group" loading="lazy" decoding="async" />
      <h2 id="eco-title">Part of the Hakmi Capital Group ecosystem</h2>
      <p className="launch-section__lead">{product.name} is one of the applications HCG builds for an interconnected future: each one useful on its own, and better together.</p>
      {principle && <p className="launch-ecosystem__principle">{principle}</p>}
      {others.length > 0 && (
        <ul className="launch-ecosystem__links">
          {others.map((p) => (
            <li key={p.id}>
              <Link to={`/apps/${p.slug}`} className="launch-ecosystem__link">
                <ProductMark product={p} size="sm" /> <span>{p.name}</span> <IconArrowRight />
              </Link>
            </li>
          ))}
          <li><Link to="/apps" className="launch-ecosystem__link launch-ecosystem__link--all">All HCG products <IconArrowRight /></Link></li>
        </ul>
      )}
    </section>
  );
}

function AdminLink({ productId }: { productId: string }) {
  const admin = useAdminMe();
  if (admin.status !== "ok" || !admin.me.administrator) return null;
  return (
    <p className="launch-admin">
      <Link className="button button--ghost button--small" to={`/control-center?tab=products&product=${encodeURIComponent(productId)}`}>Manage product</Link>
    </p>
  );
}

function groupByPlatform(files: File[]): [string, File[]][] {
  const m = new Map<string, File[]>();
  for (const f of files) m.set(f.details.platform, [...(m.get(f.details.platform) ?? []), f]);
  return [...m.entries()].sort((a, b) => PLATFORM_ORDER.indexOf(a[0]) - PLATFORM_ORDER.indexOf(b[0]));
}

/** The compact download bar shows once the hero has scrolled away, and hides again at the bottom call to action. */
function useStickyVisible(hero: React.RefObject<HTMLElement | null>, bottom: React.RefObject<HTMLElement | null>) {
  const [heroGone, setHeroGone] = useState(false);
  const [bottomIn, setBottomIn] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.target === hero.current) setHeroGone(!e.isIntersecting);
        if (e.target === bottom.current) setBottomIn(e.isIntersecting);
      }
    }, { threshold: 0 });
    if (hero.current) io.observe(hero.current);
    if (bottom.current) io.observe(bottom.current);
    return () => io.disconnect();
  }, [hero, bottom]);
  return heroGone && !bottomIn;
}

function Lightbox({ items, index, onIndex, onClose }: { items: Media[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const m = items[index]!;
  const go = useCallback((d: number) => onIndex((index + d + items.length) % items.length), [index, items.length, onIndex]);
  useEffect(() => {
    const dlg = ref.current;
    if (dlg && !dlg.open) dlg.showModal?.();
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go]);
  return (
    <dialog ref={ref} className="launch-lightbox" aria-label="Screenshot viewer" onClose={onClose} onCancel={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <figure>
        <img src={assetUrl(m.src)} width={m.width} height={m.height} alt={m.alt} />
        <figcaption>
          <span>{index + 1} / {items.length}</span> {m.caption}
        </figcaption>
      </figure>
      <div className="launch-lightbox__controls">
        <button type="button" className="button button--ghost" onClick={() => go(-1)} aria-label="Previous screenshot">←</button>
        <button type="button" className="button button--ghost" onClick={() => go(1)} aria-label="Next screenshot">→</button>
        <button type="button" className="button button--ghost" onClick={onClose} aria-label="Close viewer"><IconClose /></button>
      </div>
    </dialog>
  );
}

function FeatureIcon({ name }: { name: string }) {
  const p = { width: 26, height: 26, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "sync": return <svg {...p}><path d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6" /><path d="M18 2v4.5h-4.5M6 22v-4.5h4.5" /></svg>;
    case "send": return <svg {...p}><path d="M21 3 10 14" /><path d="m21 3-7 18-4-7-7-4z" /></svg>;
    case "accounts": return <svg {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></svg>;
    case "read": return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>;
    case "appearance": return <svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none" /></svg>;
    case "health": return <svg {...p}><path d="M3 12h4l2.5-6 4 12 2.5-6H21" /></svg>;
    case "organise": return <svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
    default: return <svg {...p}><path d="M12 3 5 6v6c0 4.5 3 7.7 7 9 4-1.3 7-4.5 7-9V6z" /></svg>;
  }
}
