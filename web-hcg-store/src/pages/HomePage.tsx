import { useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DOWNLOADS_NOT_AVAILABLE } from "../account/api";
import { CatalogueGate } from "../app/catalogue-context";
import { storefrontStatus } from "../components/Badges";
import { HeroBanner } from "../components/HeroBanner";
import { IconArrowRight, IconExternal, IconLock, IconSearch, IconShield, IconTerminal } from "../components/Icons";
import { PageMeta } from "../components/PageMeta";
import { ProductCard } from "../components/ProductCard";
import { ProductMark } from "../components/ProductArt";
import { hcgRepoProductUrl, runtimeConfig } from "../config/runtime";
import type { Catalogue } from "../domain/catalogue";
import { availability, inCollection, listedProducts } from "../domain/model";
import type { Product } from "../domain/schema";
import { CATEGORIES, EDITION_CHANNELS, PLATFORMS, PLATFORM_IDS } from "../domain/taxonomy";

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
  const products = listedProducts(catalogue);
  const featured = inCollection(catalogue, "featured");
  const jailbreak = inCollection(catalogue, "jailbreak");
  const all = [...products].sort((a, b) => {
    const sa = STATUS_ORDER.indexOf(storefrontStatus(a.developmentStatus, availability(catalogue, a)).label);
    const sb = STATUS_ORDER.indexOf(storefrontStatus(b.developmentStatus, availability(catalogue, b)).label);
    return sa - sb || a.name.localeCompare(b.name, "en");
  });

  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="page-width hero__inner">
          <HeroBanner />
          <div className="hero__bar">
            <div className="hero__copy">
              <h1 id="hero-title" className="hero__title">
                HCG Store
              </h1>
              <p className="hero__lead">Apps, jailbreak tools and developer software from Hakmi Capital Group, each shown with its real status.</p>
            </div>
            <div className="hero__actions">
              <Link to="/apps" className="button button--primary">
                Browse Products <IconArrowRight />
              </Link>
              <a href={runtimeConfig.repoBaseUrl} className="button button--ghost">
                HCG Repo <IconExternal />
              </a>
            </div>
          </div>
        </div>
      </section>

      <Discover products={products} />

      {featured.length > 0 && (
        <section className="section page-width" aria-labelledby="featured-title">
          <SectionHead id="featured-title" kicker="Selected by HCG" title="Featured products" more={{ to: "/apps", label: "All products" }} />
          <div className="featured">
            {featured.map((p, i) => (
              <ProductCard key={p.id} catalogue={catalogue} product={p} variant={i === 0 ? "feature" : "card"} />
            ))}
          </div>
        </section>
      )}

      {jailbreak.length > 0 && <JailbreakCollection products={jailbreak} />}

      <section className="section page-width" aria-labelledby="all-title">
        <SectionHead id="all-title" kicker="Catalogue" title="All products" intro="Every HCG product listed in the store, with its platforms and current status." />
        <ul className="product-rows">
          {all.map((p) => (
            <li key={p.id}>
              <ProductCard catalogue={catalogue} product={p} variant="row" />
            </li>
          ))}
        </ul>
      </section>

      <Guidance />
    </>
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

/** Search plus category and platform shortcuts into the Browse page (filters live in the URL). */
function Discover({ products }: { products: Product[] }) {
  const navigate = useNavigate();
  const id = useId();
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    navigate(q.trim() ? `/apps?q=${encodeURIComponent(q.trim())}` : "/apps");
  };
  const categories = Object.entries(CATEGORIES)
    .map(([key, c]) => ({ key, label: c.label, count: products.filter((p) => p.category === key).length }))
    .filter((c) => c.count > 0);
  const platforms = PLATFORM_IDS.map((pid) => ({ pid, count: products.filter((p) => p.platforms.some((x) => x.platform === pid)).length })).filter((x) => x.count > 0);

  return (
    <section className="discover page-width" aria-labelledby="discover-title">
      <h2 id="discover-title" className="visually-hidden">
        Find a product
      </h2>
      <form role="search" className="discover__search" onSubmit={submit}>
        <label htmlFor={id} className="visually-hidden">
          Search products
        </label>
        <IconSearch className="discover__search-icon" />
        <input id={id} type="search" placeholder="Search products, features or platforms" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        <button type="submit" className="button button--ghost button--small">
          Search
        </button>
      </form>
      <div className="discover__groups">
        <nav aria-label="Categories" className="chip-row">
          <span className="chip-row__label">Categories</span>
          {categories.map((c) => (
            <Link key={c.key} to={`/apps?category=${c.key}`} className="chip">
              {c.label} <span className="chip__count">{c.count}</span>
            </Link>
          ))}
        </nav>
        <nav aria-label="Platforms" className="chip-row">
          <span className="chip-row__label">Platforms</span>
          {platforms.map(({ pid, count }) => (
            <Link key={pid} to={`/apps?platform=${pid}`} className="chip">
              {PLATFORMS[pid].label} <span className="chip__count">{count}</span>
            </Link>
          ))}
        </nav>
      </div>
    </section>
  );
}

/** Jailbreak and Unleashed editions, each linked to its HCG Repo product page. */
function JailbreakCollection({ products }: { products: Product[] }) {
  return (
    <section className="jailbreak circuit-bg" aria-labelledby="jailbreak-title">
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

/** Account, purchase and delivery guidance. Wording matches what is enforced today. */
function Guidance() {
  const staticSite = runtimeConfig.accountService === "none";
  return (
    <section className="page-width guidance-band" aria-labelledby="guidance-title">
      <h2 id="guidance-title" className="section-kicker">
        Accounts, purchases and delivery
      </h2>
      <ol className="guidance-steps">
        <li>
          <h3>Browse freely</h3>
          <p>Product pages, editions and status are public. No account is needed to look around.</p>
        </li>
        <li>
          <h3>
            <IconLock className="inline-icon" /> Sign in with HCG Connect
          </h3>
          <p>
            Downloads and purchases use your HCG account.{" "}
            {staticSite ? "Sign-in is not available on this site yet." : "Your library shows what your account owns."}
          </p>
        </li>
        <li>
          <h3>
            <IconShield className="inline-icon" /> Ownership is checked by HCG
          </h3>
          <p>
            Every download is authorised on the server; paid products also need ownership confirmed by HCG. {DOWNLOADS_NOT_AVAILABLE}
          </p>
        </li>
      </ol>
      <Link to="/getting-started" className="text-link">
        How access and installation work <IconArrowRight />
      </Link>
    </section>
  );
}
