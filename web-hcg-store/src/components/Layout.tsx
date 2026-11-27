import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { runtimeConfig } from "../config/runtime";
import { assetUrl } from "../lib/format";
import { useAccount } from "../account/account-context";
import { signInUrl } from "../account/api";
import { useCatalogueState } from "../app/catalogue-context";
import { listedProducts } from "../domain/model";
import { CATEGORIES, PLATFORMS, PLATFORM_IDS, type CategoryId } from "../domain/taxonomy";
import { AmbientBackground } from "../theme/AmbientBackground";
import { ThemeProvider } from "../theme/ThemeContext";
import { ThemeChoices, ThemeMenu } from "../theme/ThemeMenu";
import { IconChevronDown, IconClose, IconExternal, IconGrid, IconMenu, IconNew, IconOrbit, IconSearch, IconUser } from "./Icons";
import { RouteFocus } from "./RouteFocus";

const FOOTER_NAV = [
  { to: "/", label: "Discover" },
  { to: "/apps", label: "All products" },
  { to: "/apps?availability=released", label: "New releases" },
  { to: "/getting-started", label: "Getting started" },
  { to: "/library", label: "My Library" },
  { to: "/account", label: "Account & Connections" },
];

/** Categories and platforms that have at least one listed product, with counts (never empty entries). */
function useFacets() {
  const state = useCatalogueState();
  if (state.status !== "ready") return { categories: [], platforms: [] };
  const products = listedProducts(state.catalogue);
  const categories = (Object.keys(CATEGORIES) as CategoryId[])
    .map((key) => ({ key, label: CATEGORIES[key].label, count: products.filter((p) => p.category === key).length }))
    .filter((c) => c.count > 0);
  const platforms = PLATFORM_IDS.map((key) => ({ key, label: PLATFORMS[key].label, count: products.filter((p) => p.platforms.some((x) => x.platform === key)).length })).filter(
    (x) => x.count > 0,
  );
  return { categories, platforms };
}

/** A header disclosure menu (Categories, Platforms). Links only; closes on navigation, Escape and outside clicks. */
function NavDisclosure({ label, items }: { label: string; items: { to: string; label: string; count: number }[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLLIElement>(null);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  // Rendered even before the catalogue has loaded, so the navigation does not shift when it arrives.
  return (
    <li ref={wrap} className="nav-disclosure">
      <button type="button" className="site-nav__link nav-disclosure__button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {label} <IconChevronDown className="nav-disclosure__chevron" />
      </button>
      <div id={id} className="nav-disclosure__panel" hidden={!open}>
        <ul>
          {items.map((i) => (
            <li key={i.to}>
              <Link to={i.to} className="nav-disclosure__link">
                <span>{i.label}</span> <span className="chip__count">{i.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

/**
 * Scroll entrances: elements marked data-reveal fade in once when they enter the viewport. Without
 * IntersectionObserver (or with effects off / reduced motion, see effects.css) everything is simply visible.
 */
function useRevealObserver() {
  const location = useLocation();
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const root = document.documentElement;
    root.classList.add("reveal-ready");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).dataset.revealed = "";
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.05 },
    );
    const scan = () => document.querySelectorAll<HTMLElement>("[data-reveal]:not([data-revealed])").forEach((el) => io.observe(el));
    scan();
    const mo = new MutationObserver(scan);
    const main = document.getElementById("main");
    if (main) mo.observe(main, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [location.pathname]);
}

export function Layout() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}

function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const menuId = useId();
  const { categories, platforms } = useFacets();
  useRevealObserver();
  // NavLink ignores the query string, so the catalogue's own sections are matched here.
  const section =
    location.pathname === "/apps" ? (new URLSearchParams(location.search).get("availability") === "released" ? "releases" : "products") : null;
  useEffect(() => setMenuOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    document.documentElement.classList.add("sheet-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("sheet-open");
    };
  }, [menuOpen]);

  const { deployment } = runtimeConfig;

  return (
    <>
      <AmbientBackground />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {deployment.fixtureMode && (
        <div className="fixture-banner" role="note">
          <strong>Test fixture data.</strong> The products and releases shown in this build are not real HCG software.
        </div>
      )}
      <header className="site-header">
        <div className="site-header__inner">
          <Link to="/" className="brand" aria-label="HCG Store home">
            <img
              className="brand__mark"
              src={assetUrl("brand/hcg-mark-240.webp")}
              srcSet={`${assetUrl("brand/hcg-mark-240.webp")} 240w, ${assetUrl("brand/hcg-mark-480.webp")} 480w`}
              sizes="88px"
              width={240}
              height={109}
              alt=""
            />
            <BrandStore />
          </Link>

          <nav className="site-nav" aria-label="Primary">
            <ul>
              <li>
                <NavLink to="/" end className="site-nav__link">
                  Discover
                </NavLink>
              </li>
              <li>
                <Link to="/apps" className={`site-nav__link${section === "products" ? " active" : ""}`} aria-current={section === "products" ? "page" : undefined}>
                  Products
                </Link>
              </li>
              <NavDisclosure label="Categories" items={categories.map((c) => ({ to: `/apps?category=${c.key}`, label: c.label, count: c.count }))} />
              <NavDisclosure label="Platforms" items={platforms.map((p) => ({ to: `/apps?platform=${p.key}`, label: p.label, count: p.count }))} />
              <li>
                <Link
                  to="/apps?availability=released"
                  className={`site-nav__link site-nav__link--wide${section === "releases" ? " active" : ""}`}
                  aria-current={section === "releases" ? "page" : undefined}
                >
                  New releases
                </Link>
              </li>
              <li>
                <a href={runtimeConfig.repoBaseUrl} className="site-nav__link">
                  HCG Repo <IconExternal className="nav-external" />
                </a>
              </li>
              <li>
                <NavLink to="/account" className="site-nav__link site-nav__link--wide">
                  Account
                </NavLink>
              </li>
            </ul>
          </nav>

          <div className="site-header__tools">
            <HeaderSearch />
            <ThemeMenu />
            <AccountChip />
            <button
              type="button"
              className="menu-toggle tool-button"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <IconClose /> : <IconMenu />}
              <span className="visually-hidden">{menuOpen ? "Close menu" : "Open menu"}</span>
            </button>
          </div>
        </div>
      </header>
      <div id={menuId} className="mobile-sheet" hidden={!menuOpen}>
        <div className="mobile-sheet__inner">
          <HeaderSearch mobile />
          <nav aria-label="Primary (mobile)">
            <ul className="mobile-tiles">
              <MobileTile to="/" end icon={<IconOrbit />} label="Discover" />
              <MobileTile to="/apps" icon={<IconGrid />} label="Products" active={section === "products"} />
              <MobileTile to="/apps?availability=released" icon={<IconNew />} label="New releases" active={section === "releases"} />
              <li>
                <a href={runtimeConfig.repoBaseUrl} className="mobile-tile">
                  <IconExternal /> <span>HCG Repo</span>
                </a>
              </li>
              <MobileTile to="/library" icon={<IconUser />} label="My Library" />
              <MobileTile to="/account" icon={<IconUser />} label="Account" />
            </ul>
            {categories.length > 0 && (
              <div className="mobile-sheet__group">
                <p className="mobile-sheet__label">Categories</p>
                <ul className="chip-wrap">
                  {categories.map((c) => (
                    <li key={c.key}>
                      <Link to={`/apps?category=${c.key}`} className="chip">
                        {c.label} <span className="chip__count">{c.count}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {platforms.length > 0 && (
              <div className="mobile-sheet__group">
                <p className="mobile-sheet__label">Platforms</p>
                <ul className="chip-wrap">
                  {platforms.map((p) => (
                    <li key={p.key}>
                      <Link to={`/apps?platform=${p.key}`} className="chip">
                        {p.label} <span className="chip__count">{p.count}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ul className="mobile-sheet__links">
              <li>
                <NavLink to="/getting-started" className="mobile-menu__link">
                  Getting started
                </NavLink>
              </li>
            </ul>
          </nav>
          <AccountChip mobile />
          <div className="mobile-sheet__group">
            <ThemeChoices compact />
          </div>
        </div>
      </div>

      <RouteFocus targetId="main" />
      <main id="main" tabIndex={-1} className="site-main">
        <Outlet />
      </main>
      <SiteFooter />
    </>
  );
}

function MobileTile({ to, label, icon, end = false, active }: { to: string; label: string; icon: ReactNode; end?: boolean; active?: boolean }) {
  return (
    <li>
      {active === undefined ? (
        <NavLink to={to} end={end} className="mobile-tile">
          {icon} <span>{label}</span>
        </NavLink>
      ) : (
        <Link to={to} className={`mobile-tile${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
          {icon} <span>{label}</span>
        </Link>
      )}
    </li>
  );
}

function HeaderSearch({ mobile = false }: { mobile?: boolean }) {
  const navigate = useNavigate();
  const id = useId();
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    navigate(term ? `/apps?q=${encodeURIComponent(term)}` : "/apps");
    setQ("");
  };
  return (
    <form role="search" className={mobile ? "header-search header-search--mobile" : "header-search"} onSubmit={submit}>
      <label htmlFor={id} className="visually-hidden">
        Search apps
      </label>
      <IconSearch className="header-search__icon" />
      <input id={id} type="search" placeholder={mobile ? "Search HCG Store" : "Search"} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
    </form>
  );
}

/** Sign-in state in the header. Presentation only: the server enforces every access decision. */
function AccountChip({ mobile = false }: { mobile?: boolean }) {
  const { state } = useAccount();
  const location = useLocation();
  const cls = mobile ? "account-chip account-chip--mobile" : "account-chip";
  if (state.status === "signed-in") {
    const label = state.user.name ?? state.user.email ?? "Your account";
    return (
      <Link to="/library" className={cls} title={`Signed in as ${label}`}>
        <IconUser /> <span className="account-chip__label">{mobile ? `Library · ${label}` : "Library"}</span>
      </Link>
    );
  }
  if (state.status === "signed-out") {
    return (
      <a href={signInUrl(location.pathname + location.search)} className={cls}>
        <IconUser /> <span className="account-chip__label">Sign in</span>
      </a>
    );
  }
  return null;
}

function SiteFooter() {
  const state = useCatalogueState();
  const { deployment } = runtimeConfig;
  const source = state.status === "error" ? state.result.source : state.source;
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__brand">
          <p className="site-footer__title">HCG Store</p>
          <p>Applications and developer tools from Hakmi Capital Group.</p>
          <p className="site-footer__fine">
            Browsing is open to everyone. Downloads will require your HCG account, and paid products will also require ownership confirmed by HCG.
            Downloads are not available yet.
          </p>
        </div>
        <nav aria-label="Footer">
          <ul className="site-footer__links">
            {FOOTER_NAV.map((n) => (
              <li key={n.to + n.label}>
                <Link to={n.to}>{n.label}</Link>
              </li>
            ))}
            <li>
              <a href={runtimeConfig.repoBaseUrl}>HCG Repo</a>
            </li>
          </ul>
        </nav>
        <dl className="site-footer__status">
          <div>
            <dt>Catalogue source</dt>
            <dd>{source.authority === "central" ? "HCG ERP (central)" : "Provisional local catalogue"}</dd>
          </div>
          <div>
            <dt>Build</dt>
            <dd>
              {deployment.deployEnv === "production" ? "Production" : deployment.deployEnv === "preview" ? "Preview (not indexed)" : "Local development (not indexed)"}
            </dd>
          </div>
        </dl>
      </div>
    </footer>
  );
}

/**
 * The STORE lettering of the approved HCG STORE wordmark (homepage branding), cut from the same artwork
 * (assets/brand/hcg-store-nav-store-dark.webp): never a font. Sized and placed against the HCG mark in the artwork's own
 * proportions (layout.css). If the image cannot load, the word appears as text.
 */
function BrandStore() {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="brand__store brand__store--text">Store</span>;
  const src = (w: number) => assetUrl(`brand/hcg-store-nav-store-${w}.webp`);
  return (
    <img
      className="brand__store"
      src={src(264)}
      srcSet={`${src(132)} 132w, ${src(264)} 264w, ${src(396)} 396w`}
      sizes="(max-width: 480px) 108px, 131px"
      width={1079}
      height={228}
      alt=""
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
