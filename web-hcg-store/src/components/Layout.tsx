import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { runtimeConfig } from "../config/runtime";
import { assetUrl } from "../lib/format";
import { useCatalogueState } from "../app/catalogue-context";
import { IconClose, IconMenu, IconSearch } from "./Icons";
import { RouteFocus } from "./RouteFocus";

const NAV = [
  { to: "/", label: "Store", end: true },
  { to: "/apps", label: "Browse apps", end: false },
  { to: "/getting-started", label: "Getting started", end: false },
  { to: "/account", label: "Account & Connections", end: false },
];

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const menuId = useId();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const { deployment } = runtimeConfig;

  return (
    <>
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
            <span className="brand__store">Store</span>
          </Link>

          <nav className="site-nav" aria-label="Primary">
            <ul>
              {NAV.map((n) => (
                <li key={n.to}>
                  <NavLink to={n.to} end={n.end} className="site-nav__link">
                    {n.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          <HeaderSearch />

          <button
            type="button"
            className="menu-toggle"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? <IconClose /> : <IconMenu />}
            <span className="visually-hidden">{menuOpen ? "Close menu" : "Open menu"}</span>
          </button>
        </div>
        <div id={menuId} className="mobile-menu" hidden={!menuOpen}>
          <HeaderSearch mobile />
          <nav aria-label="Primary (mobile)">
            <ul>
              {NAV.map((n) => (
                <li key={n.to}>
                  <NavLink to={n.to} end={n.end} className="mobile-menu__link">
                    {n.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>

      <RouteFocus targetId="main" />
      <main id="main" tabIndex={-1} className="site-main">
        <Outlet />
      </main>
      <SiteFooter />
    </>
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
      <input id={id} type="search" placeholder="Search apps" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
    </form>
  );
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
            No purchases are processed here. Downloads are delivered by the provider named on each release.
          </p>
        </div>
        <nav aria-label="Footer">
          <ul className="site-footer__links">
            {NAV.map((n) => (
              <li key={n.to}>
                <Link to={n.to}>{n.label}</Link>
              </li>
            ))}
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
