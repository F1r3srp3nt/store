import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CatalogueGate } from "../app/catalogue-context";
import { IconSearch } from "../components/Icons";
import { PageMeta } from "../components/PageMeta";
import { ProductCard } from "../components/ProductCard";
import type { Catalogue } from "../domain/catalogue";
import { filterProducts, isEmptyQuery, paramsFromQuery, queryFromParams, type CatalogueQuery } from "../domain/query";
import { CATEGORIES, CATEGORY_IDS, DEVELOPMENT_STATUS, DEVELOPMENT_STATUS_IDS, PLATFORMS, PLATFORM_IDS, type PlatformId } from "../domain/taxonomy";

export function BrowsePage() {
  return (
    <>
      <PageMeta title="Browse apps" description="Search and filter HCG applications and developer tools by platform, category and release availability." />
      <div className="page-width page-pad">
        <header className="page-head">
          <p className="eyebrow eyebrow--accent">Catalogue</p>
          <h1>Browse apps</h1>
          <p className="page-head__lead">Search by name or description, then filter by platform, category, development status and release availability.</p>
        </header>
        <CatalogueGate>{(c) => <Browse catalogue={c} />}</CatalogueGate>
      </div>
    </>
  );
}

function Browse({ catalogue }: { catalogue: Catalogue }) {
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => queryFromParams(params), [params]);
  const results = useMemo(() => filterProducts(catalogue, query), [catalogue, query]);
  const ids = { q: useId(), cat: useId(), status: useId(), avail: useId(), plat: useId() };

  const update = (patch: Partial<CatalogueQuery>) => setParams(paramsFromQuery({ ...query, ...patch }), { replace: true });

  // The text box owns its value while the user is typing; URL updates can lag behind keystrokes.
  // It re-syncs from the URL only when the change came from elsewhere (header search, Clear filters,
  // back/forward), i.e. while the box is not focused.
  const [text, setText] = useState(query.q);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement === searchRef.current) return;
    setText((t) => (t.trim() === query.q.trim() ? t : query.q));
  }, [query.q]);
  const clearAll = () => {
    setText("");
    setParams(new URLSearchParams(), { replace: true });
  };
  const togglePlatform = (id: PlatformId) =>
    update({ platforms: query.platforms.includes(id) ? query.platforms.filter((p) => p !== id) : [...query.platforms, id] });

  return (
    <div className="browse">
      <form className="filters" role="search" aria-label="Filter apps" onSubmit={(e) => e.preventDefault()}>
        <div className="field field--search">
          <label htmlFor={ids.q}>Search</label>
          <div className="input-icon">
            <IconSearch />
            <input ref={searchRef} id={ids.q} type="search" value={text}
              placeholder="Name, description, tag…"
              onChange={(e) => {
                setText(e.target.value);
                update({ q: e.target.value });
              }} autoComplete="off" />
          </div>
        </div>

        <div className="field">
          <label htmlFor={ids.cat}>Category</label>
          <select id={ids.cat} value={query.category ?? ""} onChange={(e) => update({ category: (e.target.value || null) as CatalogueQuery["category"] })}>
            <option value="">All categories</option>
            {CATEGORY_IDS.map((id) => (
              <option key={id} value={id}>
                {CATEGORIES[id].label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor={ids.status}>Development status</label>
          <select id={ids.status} value={query.status ?? ""} onChange={(e) => update({ status: (e.target.value || null) as CatalogueQuery["status"] })}>
            <option value="">Any status</option>
            {DEVELOPMENT_STATUS_IDS.map((id) => (
              <option key={id} value={id}>
                {DEVELOPMENT_STATUS[id].label}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="field segmented">
          <legend>Release availability</legend>
          {(
            [
              ["any", "Any"],
              ["downloadable", "Download available"],
              ["no-download", "No download yet"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="segmented__option">
              <input type="radio" name={ids.avail} value={value} checked={query.availability === value} onChange={() => update({ availability: value })} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="field chips">
          <legend>Platform</legend>
          {PLATFORM_IDS.map((id) => (
            <label key={id} className="chip-check">
              <input type="checkbox" checked={query.platforms.includes(id)} onChange={() => togglePlatform(id)} />
              <span>{PLATFORMS[id].label}</span>
            </label>
          ))}
          <p className="fine">Includes products that are supported, in development or planned for a platform.</p>
        </fieldset>

        {!isEmptyQuery(query) && (
          <button type="button" className="button button--ghost button--small" onClick={clearAll}>
            Clear filters
          </button>
        )}
      </form>

      <section className="results" aria-labelledby="results-title">
        <h2 id="results-title" className="visually-hidden">
          Results
        </h2>
        <p className="results__count" role="status" aria-live="polite">
          {results.length === catalogue.products.length
            ? `${results.length} products`
            : `${results.length} of ${catalogue.products.length} products match`}
        </p>
        {results.length ? (
          <ul className="product-grid product-grid--browse">
            {results.map((p) => (
              <li key={p.id}>
                <ProductCard catalogue={catalogue} product={p} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">
            <h3>No products match these filters</h3>
            <p>Try fewer filters or a different search term.</p>
            <button type="button" className="button button--ghost" onClick={clearAll}>
              Clear filters
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
