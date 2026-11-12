import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CatalogueGate } from "../app/catalogue-context";
import { IconArrowRight, IconDownload, IconLayers, IconShield, IconTerminal } from "../components/Icons";
import { HeroBanner } from "../components/HeroBanner";
import { PageMeta } from "../components/PageMeta";
import { ProductCard } from "../components/ProductCard";
import type { Catalogue } from "../domain/catalogue";
import { availability } from "../domain/model";
import { PLATFORMS, PLATFORM_IDS } from "../domain/taxonomy";

export function HomePage() {
  return (
    <>
      <PageMeta title="HCG Store" />
      <CatalogueGate>{(c) => <Home catalogue={c} />}</CatalogueGate>
    </>
  );
}

function Home({ catalogue }: { catalogue: Catalogue }) {
  const products = [...catalogue.products].sort((a, b) => a.name.localeCompare(b.name, "en"));
  const downloadable = products.filter((p) => availability(catalogue, p) === "downloadable");
  const devTools = products.filter((p) => p.category === "developer-tools");
  const active = products.filter((p) => p.category !== "developer-tools" && (p.developmentStatus === "in-development" || p.developmentStatus === "testing"));
  const roadmap = products.filter((p) => p.category !== "developer-tools" && !active.includes(p) && !downloadable.includes(p));
  const platformCounts = PLATFORM_IDS.map((id) => ({ id, count: products.filter((p) => p.platforms.some((x) => x.platform === id)).length })).filter(
    (x) => x.count > 0,
  );

  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero__inner page-width">
          <HeroBanner />
          <div className="hero__body">
            <div className="hero__copy">
              <p className="eyebrow eyebrow--accent">Hakmi Capital Group · Software distribution</p>
              <h1 id="hero-title" className="hero__title">
                <span className="metal-text">HCG</span> Store
              </h1>
              <p className="hero__lead">
                The home for Hakmi Capital Group applications and developer tools. Every listing shows its real development
                status. Downloads appear only when HCG has approved a release.
              </p>
              <div className="hero__actions">
                <Link to="/apps" className="button button--primary">
                  Browse apps <IconArrowRight />
                </Link>
                <Link to="/getting-started" className="button button--ghost">
                  Getting started
                </Link>
              </div>
            </div>
            <dl className="hero__stats" aria-label="Catalogue status">
              <div>
                <dt>Products listed</dt>
                <dd>{products.length}</dd>
              </div>
              <div>
                <dt>Public downloads</dt>
                <dd>{downloadable.length}</dd>
              </div>
              <div>
                <dt>In development</dt>
                <dd>{products.filter((p) => p.developmentStatus === "in-development").length}</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <nav className="page-width platform-nav" aria-labelledby="platform-nav-title">
        <h2 id="platform-nav-title" className="section-kicker">
          Browse by platform
        </h2>
        <ul>
          {platformCounts.map(({ id, count }) => (
            <li key={id}>
              <Link to={`/apps?platform=${id}`} className="platform-tile">
                <span className="platform-tile__name">{PLATFORMS[id].label}</span>
                <span className="platform-tile__count">
                  {count} {count === 1 ? "product" : "products"}
                </span>
              </Link>
            </li>
          ))}
          <li>
            <Link to="/apps" className="platform-tile platform-tile--all">
              <span className="platform-tile__name">All products</span>
              <span className="platform-tile__count">{products.length} listed</span>
            </Link>
          </li>
        </ul>
      </nav>

      {downloadable.length > 0 ? (
        <Section id="downloads" kicker="Available now" title="Available downloads" icon={<IconDownload />}>
          <Grid catalogue={catalogue} items={downloadable} />
        </Section>
      ) : (
        <div className="page-width">
          <p className="notice" role="note">
            <IconShield className="inline-icon" /> No public downloads have been published yet. Products appear under{" "}
            <em>Available downloads</em> once HCG approves a release with a real download link.
          </p>
        </div>
      )}

      <Section id="in-development" kicker="Being built" title="In development" icon={<IconLayers />} more={{ to: "/apps?status=in-development", label: "All in-development products" }}>
        <Grid catalogue={catalogue} items={active} />
      </Section>

      <Section
        id="developer-tools"
        kicker="Umbrella category"
        title="HCG Development Tools"
        icon={<IconTerminal />}
        intro="Build, packaging and engineering tools from HCG. Development Tools is a category, not a separate product."
        more={{ to: "/apps?category=developer-tools", label: "Browse development tools" }}
      >
        <Grid catalogue={catalogue} items={devTools} />
      </Section>

      {roadmap.length > 0 && (
        <Section id="roadmap" kicker="Named products" title="Also in the HCG portfolio" intro="These products are listed by name. Details will be published when HCG confirms them.">
          <ul className="roadmap-list">
            {roadmap.map((p) => (
              <li key={p.id}>
                <Link to={`/apps/${p.slug}`} className="roadmap-item">
                  <span className="roadmap-item__name">{p.name}</span>
                  <span className="roadmap-item__summary">{p.summary}</span>
                  <IconArrowRight className="roadmap-item__arrow" />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <section className="page-width principles" aria-labelledby="principles-title">
        <h2 id="principles-title" className="section-kicker">
          How HCG Store works
        </h2>
        <div className="principles__grid">
          <div className="principle">
            <h3>Approved releases only</h3>
            <p>A download is shown only when HCG supplies release metadata and a real file link. Everything else is labelled honestly.</p>
          </div>
          <div className="principle">
            <h3>Direct from the provider</h3>
            <p>Files are delivered by the hosting provider named on the release. Your browser handles the download; HCG Store cannot see whether it finished.</p>
          </div>
          <div className="principle">
            <h3>No account needed to browse</h3>
            <p>The public catalogue and public downloads work without signing in. HCG Connect sign-in will be added once it is approved centrally.</p>
          </div>
        </div>
      </section>
    </>
  );
}

function Section({
  id,
  kicker,
  title,
  intro,
  icon,
  more,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  intro?: string;
  icon?: ReactNode;
  more?: { to: string; label: string };
  children: ReactNode;
}) {
  return (
    <section className="section page-width" aria-labelledby={`${id}-title`}>
      <div className="section__head">
        <div>
          <p className="eyebrow">
            {icon}
            {kicker}
          </p>
          <h2 id={`${id}-title`} className="section__title">
            {title}
          </h2>
          {intro && <p className="section__intro">{intro}</p>}
        </div>
        {more && (
          <Link to={more.to} className="text-link">
            {more.label} <IconArrowRight />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

function Grid({ catalogue, items }: { catalogue: Catalogue; items: Catalogue["products"] }) {
  return (
    <ul className="product-grid">
      {items.map((p) => (
        <li key={p.id}>
          <ProductCard catalogue={catalogue} product={p} />
        </li>
      ))}
    </ul>
  );
}
