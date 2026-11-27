import { useId, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CatalogueGate } from "../app/catalogue-context";
import { storefrontStatus } from "../components/Badges";
import { CinematicHero } from "../components/home/CinematicHero";
import { EcosystemExplorer } from "../components/home/EcosystemExplorer";
import { EcosystemGateway } from "../components/home/EcosystemGateway";
import { NewsAnnouncements, PromotionSlot } from "../components/home/Placements";
import { IconArrowRight, IconExternal, IconSearch, IconTerminal } from "../components/Icons";
import { PageMeta } from "../components/PageMeta";
import { ProductCard } from "../components/ProductCard";
import { ProductMark } from "../components/ProductArt";
import { hcgRepoProductUrl } from "../config/runtime";
import type { Catalogue } from "../domain/catalogue";
import {
  availability,
  inCollection,
  listedProducts,
  newReleases,
  productsInCategory,
  recentlyUpdated,
  unleashedProducts,
  upcomingProducts,
} from "../domain/model";
import type { Product } from "../domain/schema";
import { CATEGORIES, EDITION_CHANNELS, PLATFORMS, PLATFORM_IDS, type CategoryId } from "../domain/taxonomy";
import { resolveStorefront, type SectionId } from "../storefront/config";

export function HomePage() {
  return (
    <>
      <PageMeta title="HCG Store" />
      <CatalogueGate>{(c) => <Home catalogue={c} />}</CatalogueGate>
    </>
  );
}

/** Status order for scanning: released first, then testing, in development, planned, the rest. */
const STATUS_ORDER = ["Released", "Testing", "In development", "Planned", "Maintained", "Paused", "Status not stated"];

function Home({ catalogue }: { catalogue: Catalogue }) {
  const store = resolveStorefront(catalogue);
  const products = listedProducts(catalogue);
  const featured = store.featured.length ? store.featured : inCollection(catalogue, "featured");
  const spotlight = store.spotlight.length ? store.spotlight : featured;
  const all = [...products].sort((a, b) => {
    const sa = STATUS_ORDER.indexOf(storefrontStatus(a.developmentStatus, availability(catalogue, a)).label);
    const sb = STATUS_ORDER.indexOf(storefrontStatus(b.developmentStatus, availability(catalogue, b)).label);
    return sa - sb || a.name.localeCompare(b.name, "en");
  });

  const sections: Record<SectionId, () => ReactNode> = {
    "new-releases": () => {
      const items = newReleases(catalogue);
      return items.length ? (
        <Shelf id="new-title" kicker="Approved in HCG Store" title="New releases" more={{ to: "/apps?availability=released", label: "All releases" }}>
          {items.map(({ product }) => (
            <ProductCard key={product.id} catalogue={catalogue} product={product} />
          ))}
        </Shelf>
      ) : null;
    },
    "recently-updated": () => {
      const items = recentlyUpdated(catalogue);
      return items.length ? (
        <section className="section page-width" aria-labelledby="updated-title" data-reveal>
          <SectionHead id="updated-title" kicker="Release history" title="Recently updated" />
          <ul className="compact-list">
            {items.map(({ product }) => (
              <li key={product.id}>
                <ProductCard catalogue={catalogue} product={product} variant="compact" />
              </li>
            ))}
          </ul>
        </section>
      ) : null;
    },
    featured: () =>
      featured.length ? (
        <section className="section page-width" aria-labelledby="featured-title" data-reveal>
          <SectionHead id="featured-title" kicker="Selected by HCG" title="Featured products" more={{ to: "/apps", label: "All products" }} />
          <div className="featured">
            {featured.map((p, i) => (
              <ProductCard key={p.id} catalogue={catalogue} product={p} variant={i === 0 ? "feature" : "card"} />
            ))}
          </div>
        </section>
      ) : null,
    categories: () => <Discover products={products} />,
    upcoming: () => {
      const items = upcomingProducts(catalogue);
      return items.length ? (
        <Shelf id="upcoming-title" kicker="Being built, tested or planned" title="Upcoming technology" intro="In development at HCG. Nothing here is released yet; each page says exactly where it stands.">
          {items.map((p) => (
            <ProductCard key={p.id} catalogue={catalogue} product={p} />
          ))}
        </Shelf>
      ) : null;
    },
    ecosystem: () => (
      <section id="ecosystem" className="section page-width ecosystem" aria-labelledby="eco-title" data-reveal>
        <SectionHead
          id="eco-title"
          kicker="HCG ecosystem"
          title="How HCG products connect"
          intro="Integrations each product's own data states. Solid lines are available today; dashed lines are planned."
        />
        <EcosystemExplorer catalogue={catalogue} />
      </section>
    ),
    // The four areas share one tabbed section, placed where the first of them appears in the configuration.
    "developer-tools": () => areaSection("developer-tools"),
    security: () => areaSection("security"),
    infrastructure: () => areaSection("infrastructure"),
    productivity: () => areaSection("productivity"),
    unleashed: () => {
      const items = unleashedProducts(catalogue);
      const jb = items.length ? items : inCollection(catalogue, "jailbreak");
      return jb.length ? <JailbreakCollection products={jb} /> : null;
    },
    news: () => <NewsAnnouncements />,
    campaigns: () => <PromotionSlot slot="home-campaign" heading="From HCG" />,
  };

  const areaOrder = store.sections.filter((x): x is AreaId => (AREA_IDS as readonly string[]).includes(x));
  const areaSection = (id: AreaId) => (id === areaOrder[0] ? <AreaTabs catalogue={catalogue} order={areaOrder} /> : null);

  return (
    <>
      <CinematicHero catalogue={catalogue} spotlight={spotlight} rotateSeconds={store.rotateSeconds} />
      {store.sections.map((id) => (
        <SectionSlot key={id}>{sections[id]()}</SectionSlot>
      ))}

      <section className="section page-width" aria-labelledby="all-title" data-reveal>
        <SectionHead id="all-title" kicker="Catalogue" title="All products" intro="Every HCG product listed in the store, with its platforms and current status." />
        <ul className="product-rows">
          {all.map((p) => (
            <li key={p.id}>
              <ProductCard catalogue={catalogue} product={p} variant="row" />
            </li>
          ))}
        </ul>
      </section>

      <EcosystemGateway catalogue={catalogue} />
    </>
  );
}

function SectionSlot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** A horizontal, snap-scrolling shelf of cards: dense on phones, a grid-like row on desktop. */
function Shelf({ id, kicker, title, intro, more, children }: { id: string; kicker: string; title: string; intro?: string; more?: { to: string; label: string }; children: ReactNode }) {
  return (
    <section className="section page-width shelf" aria-labelledby={id} data-reveal>
      <SectionHead id={id} kicker={kicker} title={title} intro={intro} more={more} />
      <div className="shelf__track" role="list">
        {Array.isArray(children)
          ? children.map((c, i) => (
              <div role="listitem" className="shelf__item" key={i}>
                {c}
              </div>
            ))
          : children}
      </div>
    </section>
  );
}

const AREA_IDS = ["developer-tools", "security", "infrastructure", "productivity"] as const;
type AreaId = (typeof AREA_IDS)[number];
const AREAS: Record<AreaId, { title: string; kicker: string }> = {
  "developer-tools": { title: "Developer tools", kicker: "Build, ship, operate" },
  security: { title: "Security instruments", kicker: "Authorised testing" },
  infrastructure: { title: "Infrastructure", kicker: "Devices, storage, services" },
  productivity: { title: "Productivity", kicker: "Plan, focus, create" },
};

/** Developer tools, security instruments, infrastructure and productivity as tabs over one shelf. Empty areas get no tab. */
function AreaTabs({ catalogue, order }: { catalogue: Catalogue; order: AreaId[] }) {
  const areas = order.map((id) => ({ id, ...AREAS[id], items: productsInCategory(catalogue, id) })).filter((a) => a.items.length > 0);
  const [active, setActive] = useState(0);
  const baseId = useId();
  if (!areas.length) return null;
  const a = areas[Math.min(active, areas.length - 1)]!;
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (active + (e.key === "ArrowRight" ? 1 : areas.length - 1)) % areas.length;
    setActive(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  };
  return (
    <section className="section page-width areas" aria-labelledby={`${baseId}-title`} data-reveal>
      <SectionHead id={`${baseId}-title`} kicker="Explore by area" title="Instruments for every layer" more={{ to: `/apps?category=${a.id}`, label: `All in ${CATEGORIES[a.id].label}` }} />
      <div className="areas__tabs" role="tablist" aria-label="Areas" onKeyDown={onKey}>
        {areas.map((x, i) => (
          <button
            key={x.id}
            id={`${baseId}-tab-${i}`}
            type="button"
            role="tab"
            aria-selected={i === active}
            aria-controls={`${baseId}-panel`}
            tabIndex={i === active ? 0 : -1}
            className="areas__tab"
            onClick={() => setActive(i)}
          >
            {x.title} <span className="chip__count">{x.items.length}</span>
          </button>
        ))}
      </div>
      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${active}`} className="shelf__track areas__panel">
        {a.items.map((p) => (
          <div className="shelf__item" key={p.id}>
            <ProductCard catalogue={catalogue} product={p} />
          </div>
        ))}
      </div>
    </section>
  );
}


function SectionHead({ id, kicker, title, intro, more }: { id: string; kicker: string; title: string; intro?: string; more?: { to: string; label: string } }) {
  return (
    <div className="section__head">
      <div>
        <p className="eyebrow">{kicker}</p>
        <h2 id={id} className="section__title">
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
  );
}

/** Search, a category grid and platform shortcuts into the Browse page (filters live in the URL). */
function Discover({ products }: { products: Product[] }) {
  const navigate = useNavigate();
  const id = useId();
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    navigate(q.trim() ? `/apps?q=${encodeURIComponent(q.trim())}` : "/apps");
  };
  const categories = (Object.keys(CATEGORIES) as CategoryId[])
    .map((key) => ({ key, label: CATEGORIES[key].label, items: products.filter((p) => p.category === key && !p.supersededBy) }))
    .filter((c) => c.items.length > 0);
  const platforms = PLATFORM_IDS.map((pid) => ({ pid, count: products.filter((p) => p.platforms.some((x) => x.platform === pid)).length })).filter((x) => x.count > 0);

  return (
    <section className="discover page-width" aria-labelledby="discover-title" data-reveal>
      <div className="section__head">
        <div>
          <p className="eyebrow">Discover</p>
          <h2 id="discover-title" className="section__title">
            Browse by category
          </h2>
        </div>
      </div>
      <form role="search" className="discover__search" onSubmit={submit}>
        <label htmlFor={id} className="visually-hidden">
          Search products
        </label>
        <IconSearch className="discover__search-icon" />
        <input id={id} type="search" placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        <button type="submit" className="button button--ghost button--small">
          Search
        </button>
      </form>
      <ul className="category-grid" aria-label="Categories">
        {categories.map((c) => (
          <li key={c.key}>
            <Link to={`/apps?category=${c.key}`} className="category-tile holo-border">
              <span className="category-tile__icons" aria-hidden="true">
                {c.items.slice(0, 3).map((p) => (
                  <ProductMark key={p.id} product={p} size="sm" />
                ))}
              </span>
              <span className="category-tile__label">{c.label}</span>
              <span className="category-tile__count">
                {c.items.length} {c.items.length === 1 ? "product" : "products"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <nav aria-label="Platforms" className="chip-row chip-row--wrap">
        <span className="chip-row__label">Platforms</span>
        {platforms.map(({ pid, count }) => (
          <Link key={pid} to={`/apps?platform=${pid}`} className="chip">
            {PLATFORMS[pid].label} <span className="chip__count">{count}</span>
          </Link>
        ))}
      </nav>
    </section>
  );
}

/** Jailbreak and Unleashed editions, each linked to its HCG Repo product page. */
function JailbreakCollection({ products }: { products: Product[] }) {
  return (
    <section className="jailbreak circuit-bg" aria-labelledby="jailbreak-title" data-reveal>
      <div className="page-width">
        <div className="jailbreak__intro">
          <p className="eyebrow eyebrow--accent">
            <IconTerminal /> Jailbreak &amp; Unleashed
          </p>
          <h2 id="jailbreak-title" className="section__title">
            Packages for jailbroken iPhone and iPad
          </h2>
          <p className="section__intro">
            Separate jailbreak editions of HCG apps, distributed through HCG Repo for Sileo. Each package page on HCG Repo links back to its store page.
          </p>
        </div>
        <ul className="jailbreak__list">
          {products.map((p) =>
            p.hcgRepo.map((link) => {
              const edition = p.editions.find((e) => e.id === link.editionId) ?? null;
              const pkg = edition?.identifiers.find((i) => i.kind === "debian-package")?.value;
              return (
                <li key={link.key} className="jailbreak-item">
                  <ProductMark product={p} size="md" />
                  <div className="jailbreak-item__body">
                    <h3 className="jailbreak-item__title">{edition?.name ?? p.name}</h3>
                    <p className="jailbreak-item__summary">{edition?.summary ?? p.summary}</p>
                    <p className="jailbreak-item__meta">
                      {edition ? EDITION_CHANNELS[edition.channel].label : "Not a jailbreak package"}
                      {pkg && (
                        <>
                          {" · "}
                          <code>{pkg}</code>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="jailbreak-item__actions">
                    <Link to={`/apps/${p.slug}${link.editionId ? `?edition=${encodeURIComponent(link.editionId)}` : ""}`} className="button button--ghost button--small">
                      View Product
                    </Link>
                    <a href={hcgRepoProductUrl(link.key)} className="button button--ghost button--small">
                      View on HCG Repo <IconExternal />
                    </a>
                  </div>
                </li>
              );
            }),
          )}
        </ul>
      </div>
    </section>
  );
}

