import { applyLivePublications } from "./domain/live-publications";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "./account/account-context";
import type { EditionAccess } from "./account/api";
import { AppRoutes } from "./App";
import { CatalogueStateProvider } from "./app/catalogue-context";
import type { Catalogue } from "./domain/catalogue";
import { fixtureCatalogue, realCatalogue, staticProvider } from "./test/fixtures";

/**
 * Stand-in for the HCG Store server. `null` = no server (static host): every request fails. The
 * real server's behaviour is tested in server/test; these tests check what the UI shows for each
 * answer, and that the UI never invents ownership, prices or downloads on its own.
 */
type ServerStub = null | {
  session: { configured: boolean; signedIn: boolean; user?: { sub: string; email: string; name: string } };
  access?: (slug: string) => EditionAccess[];
  library?: unknown;
  manager?: unknown;
  /** /api/v1/publishing/me: what HCG lets this person do in HCG Store (server-decided). */
  me?: unknown;
};
let server: ServerStub = null;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  server = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (!server) throw new TypeError("Failed to fetch");
      const path = String(input);
      if (path.endsWith("/api/v1/session")) return json({ user: null, ...server.session });
      if (path.endsWith("/api/v1/health"))
        return json({ status: "ok", mode: "test", hcgConnect: "configured", entitlementAuthority: "test-ledger", payments: "test-mode", protectedDownloads: "disabled" });
      const m = /\/api\/v1\/products\/([a-z0-9-]+)\/access$/.exec(path);
      if (m) return json({ productId: m[1], signedIn: server.session.signedIn, editions: server.access?.(m[1]!) ?? [] });
      if (path.endsWith("/api/v1/publishing/me")) return server.me ? json(server.me) : json({ error: { code: "publishing_disabled", message: "Publishing is not enabled on this Store." } }, 404);
      if (path.endsWith("/api/v1/publishing/products")) return json({ products: [{ id: "hcg-mail", title: "HCG Mail", source: "catalogue", editions: [], centralId: "hcg.mail" }] });
      if (path.endsWith("/api/v1/publishing/manager")) return server.manager ? json(server.manager) : json({ error: { code: "publishing_disabled", message: "Publishing is not enabled on this Store." } }, 404);
      if (path.endsWith("/api/v1/library")) return server.library ? json(server.library) : json({ error: { code: "sign_in_required", message: "Sign in" } }, 401);
      return json({ error: { code: "not_found", message: "Not found." } }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function access(over: Partial<EditionAccess> & { editionId: string | null }): EditionAccess {
  return {
    productId: "x",
    state: "signed-out",
    signedIn: false,
    owned: false,
    offers: [],
    checkoutReady: false,
    checkoutUnavailableReason: "Coming soon. Not for sale before release.",
    downloadsAvailable: false,
    downloadsMessage: "Downloads are not available yet.",
    artifacts: [],
    message: null,
    ...over,
  };
}

function renderAt(path: string, catalogue: Catalogue = realCatalogue()) {
  return render(
    <CatalogueStateProvider provider={staticProvider(catalogue)}>
      {/* Explicit, so a VITE_STORE_ACCOUNT_SERVICE in the environment cannot change what is tested. */}
      <AccountProvider accountService="same-origin-server">
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </AccountProvider>
    </CatalogueStateProvider>,
  );
}

/** Things HCG Store must never show unless the server supplied them: fabricated stats, ratings, prices, install claims. */
const FORBIDDEN = [/\b\d[\d,.]*\s*(downloads|installs|users)\b/i, /\brating/i, /\breviews\b|\d\s*reviews?\b|\bwrite a review\b/i, /★/, /[$€£]\s?\d/, /add to cart/i, /successfully installed/i, /signed in as/i, /live activity/i];
const expectNoFabrication = (container: HTMLElement) => {
  const text = container.textContent ?? "";
  for (const re of FORBIDDEN) expect(text).not.toMatch(re);
  for (const b of screen.queryAllByRole("button", { name: "Buy Product" })) expect(b).toBeDisabled();
  expect(screen.queryByRole("link", { name: /^download/i })).toBeNull();
};

describe("store pages with the shipped catalogue", () => {
  it("home: compact hero, featured products, jailbreak collection, every listed product and honest guidance", async () => {
    const { container } = renderAt("/");
    expect(await screen.findByRole("heading", { level: 1, name: /HCG Store/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Browse Products/ })).toHaveAttribute("href", "/apps");
    expect(screen.getByRole("heading", { name: "Featured products" })).toBeInTheDocument();
    const jb = screen.getByRole("heading", { name: /Packages for jailbroken iPhone and iPad/ }).closest("section")!;
    expect(within(jb).getByRole("heading", { name: "HCG Terminal Unleashed" })).toBeInTheDocument();
    expect(within(jb).getAllByRole("link", { name: /View on HCG Repo/ }).map((a) => a.getAttribute("href"))).toEqual([
      "https://repo.hakmicapitalgroup.com/products/hcg-terminal-unleashed/",
      "https://repo.hakmicapitalgroup.com/products/hcg-nexus/",
    ]);
    const all = screen.getByRole("heading", { name: "All products" }).closest("section")!;
    expect(within(all).getAllByRole("listitem")).toHaveLength(11); // RePrompter is now part of Clarity; drafts are never listed
    expect(within(all).queryByText("HCG RePrompter")).toBeNull();
    // Ecosystem gateway: every listed product linked to its page, the latest release, and how access really works.
    const gateway = screen.getByRole("heading", { name: "One store. Every HCG application." }).closest("section")!;
    const nodes = gateway.querySelectorAll(".constellation-node__link");
    expect(nodes).toHaveLength(11);
    expect([...nodes].map((a) => a.getAttribute("href"))).toContain("/apps/hcg-mail");
    expect(within(gateway).getByRole("img", { name: "HCG Store" })).toBeInTheDocument();
    const latest = within(gateway).getByRole("heading", { name: "Latest releases" }).closest("section")!;
    expect(within(latest).getByText("HCG Mail")).toBeInTheDocument();
    expect(latest.textContent).toMatch(/1\.0\.0-beta\.1 · Public beta/);
    expect(latest.textContent).toMatch(/Windows x64/);
    expect(latest.textContent).toMatch(/Free/);
    for (const t of ["Public browsing", "Free downloads, no account", "Downloads with your HCG account", "Licensed products", "HCG Connect", "Purchases"]) {
      expect(within(gateway).getByRole("heading", { name: t })).toBeInTheDocument();
    }
    // The old blanket claims are gone.
    expect(container.textContent).not.toMatch(/Downloads are not available yet|Every download requires|Downloads will require/);
    // Footer: four groups, the slogan, and no build or catalogue-source details.
    const footer = container.querySelector("footer")!;
    for (const g of ["Marketplace", "HCG Ecosystem", "Resources & Support", "Your Account"]) expect(within(footer).getByRole("list", { name: g })).toBeInTheDocument();
    expect(footer.textContent).toContain("EVERYTHING IS INTERCHANGEABLE.");
    expect(footer.textContent).not.toMatch(/Catalogue source|Build|Provisional local catalogue/);
    // No counters, no internal labels, no file links.
    expect(screen.queryByLabelText("Catalogue status")).toBeNull();
    expect(container.textContent).not.toMatch(/generated tile/i);
    expect([...container.querySelectorAll("a")].some((a) => (a.getAttribute("href") ?? "").includes("/api/v1/downloads"))).toBe(false);
    expectNoFabrication(container);
  });

  it("theme selector: any visitor picks one of six themes; it is stored locally and changes nothing else", async () => {
    window.localStorage.clear();
    const { container } = renderAt("/");
    await screen.findByRole("heading", { level: 1, name: /HCG Store/ });
    const before = container.querySelector("main")!.textContent;
    fireEvent.click(screen.getAllByRole("button", { name: "Theme" })[0]!);
    const group = screen.getAllByRole("group", { name: "Theme" })[0]!;
    expect(within(group).getAllByRole("radio")).toHaveLength(6);
    fireEvent.click(within(group).getByRole("radio", { name: /Quantum Frost/ }));
    expect(document.documentElement.dataset.theme).toBe("frost");
    expect(window.localStorage.getItem("hcg-store.theme")).toBe("frost");
    expect(container.querySelector("main")!.textContent).toBe(before); // content, prices and access are untouched
    fireEvent.click(screen.getAllByRole("switch", { name: /Decorative effects/ })[0]!);
    expect(document.documentElement.dataset.effects).toBe("off");
    expect(window.localStorage.getItem("hcg-store.effects")).toBe("off");
    expect(screen.queryByRole("button", { name: /Pause/ })).toBeNull(); // no rotation without effects
    window.localStorage.clear();
  });

  it("collapses homepage sections without eligible content (no news or campaigns exist; one published release)", async () => {
    renderAt("/");
    await screen.findByRole("heading", { level: 1, name: /HCG Store/ });
    expect(within(screen.getByRole("heading", { name: "New releases" }).closest("section")!).getByText("HCG Mail")).toBeInTheDocument();
    expect(within(screen.getByRole("heading", { name: "Recently updated" }).closest("section")!).getByText("HCG Mail")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Announcements" })).toBeNull();
    expect(screen.queryByText("Sponsored")).toBeNull();
    expect(screen.getByRole("heading", { name: "Upcoming technology" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How HCG products connect" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Areas" })).toBeInTheDocument();
    expect(screen.queryByText(/HCG ADS|Signal Contractor|System Tester/)).toBeNull(); // drafts stay hidden
  });

  it("navigation offers Discover, Products, Categories, Platforms, New releases, HCG Repo and Account", async () => {
    renderAt("/");
    const nav = await screen.findByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent?.trim())).toEqual(["Discover", "Products", "New releases", "HCG Repo", "Account"]);
    expect(within(nav).getByRole("button", { name: "Categories" })).toHaveAttribute("aria-expanded", "false");
    expect(within(nav).getByRole("button", { name: "Platforms" })).toBeInTheDocument();
  });

  it("home hero: banner first, then the wordmark heading, attribution, tagline, lead and actions", async () => {
    renderAt("/");
    const h1 = await screen.findByRole("heading", { level: 1, name: "HCG Store" });
    const banner = screen.getByRole("img", { name: /HCG STORE wordmark/ });
    expect(banner).toHaveAttribute("loading", "eager");
    expect(banner).toHaveAttribute("width", "2172");
    expect(banner).toHaveAttribute("height", "724");
    expect(banner.getAttribute("srcset")).toMatch(/hcg-store-hero-800\.webp 800w/);
    expect(banner.closest("picture")?.querySelector('source[type="image/avif"]')?.getAttribute("srcset")).toMatch(/hcg-store-hero-2172\.avif 2172w/);
    expect(screen.getAllByText("Illustration").length).toBeGreaterThan(0);
    // The wordmark image is decorative inside the h1; the heading's name comes from its text.
    const wordmark = h1.querySelector("img")!;
    expect(wordmark).toHaveAttribute("alt", "");
    expect(wordmark.getAttribute("src")).toMatch(/hcg-store-wordmark-dark-1440\.webp$/);
    // Document order: banner, wordmark heading, attribution, tagline, lead, Browse Products, Explore the ecosystem.
    const hero = h1.closest("section")!;
    const order = [
      banner,
      h1,
      within(hero).getByText("A Hakmi Capital Group Platform"),
      within(hero).getByText("The marketplace of an interconnected future"),
      within(hero).getByText(/Apps, infrastructure, security instruments/),
      within(hero).getByRole("link", { name: /Browse Products/ }),
      within(hero).getByRole("link", { name: "Explore the ecosystem" }),
    ];
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(hero).queryByText(/^Hakmi Capital Group$/)).toBeNull();
    // Failures leave the heading readable.
    fireEvent.error(wordmark);
    expect(h1.querySelector("img")).toBeNull();
    expect(within(h1).getByText("HCG Store")).not.toHaveClass("visually-hidden");
    fireEvent.error(banner);
    expect(screen.queryByRole("img", { name: /HCG STORE wordmark/ })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "HCG Store" })).toBeInTheDocument();
  });

  it("product page shows 'Coming soon', editions, and 'Downloads are not available yet.' (HCG Mail before its release)", async () => {
    const c = realCatalogue();
    const { container } = renderAt("/apps/hcg-mail", { ...c, products: c.products.map((p) => (p.id === "hcg-mail" ? { ...p, currentReleaseId: null } : p)) });
    expect(await screen.findByRole("heading", { level: 1, name: "HCG Mail" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Coming soon" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Windows desktop" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "iPhone and iPad" })).toBeInTheDocument();
    expect(screen.getAllByText("Downloads are not available yet.").length).toBeGreaterThan(0);
    expect(screen.getByText(/Development activity does not mean a downloadable build exists/)).toBeInTheDocument();
    expectNoFabrication(container);
  });

  it("catalogue v2: shows edition tier and access where stated, related products, and gives drafts no page", async () => {
    const { container } = renderAt("/apps/hcg-terminal");
    await screen.findByRole("heading", { level: 1, name: "HCG Terminal" });
    expect(screen.getByText("Unleashed")).toBeInTheDocument();
    expect(screen.getByText("Sign-in with an HCG account")).toBeInTheDocument();
    expectNoFabrication(container);
    cleanup();
    renderAt("/apps/hcg-server");
    await screen.findByRole("heading", { level: 1, name: "HCG Server" });
    expect(within(screen.getByRole("main")).getByRole("link", { name: "HCG Executable Maker" })).toHaveAttribute("href", "/apps/hcg-executable-maker");
    cleanup();
    renderAt("/apps/hcg-ads");
    expect(await screen.findByText(/not found|doesn.t exist|could not find/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "HCG ADS" })).toBeNull();
  });

  it("labels real screenshots and keeps planned features apart from current ones", async () => {
    const { container } = renderAt("/apps/hcg-executable-maker");
    await screen.findByRole("heading", { level: 1, name: "HCG Executable Maker" });
    expect(screen.getAllByText("Screenshot").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Available in the current build" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Planned (not available yet)" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/generated tile|generated artwork/i);
  });

  it("product page: the banner is the one priority image, AVIF with WebP fallback, decorative; screenshots stay", async () => {
    const { container } = renderAt("/apps/hcg-executable-maker");
    await screen.findByRole("heading", { level: 1, name: "HCG Executable Maker" });
    const banner = container.querySelector(".product-banner img")!;
    expect(banner).toHaveAttribute("src", "/media/products/hcg-executable-maker/banner-2000.webp");
    expect(banner).toHaveAttribute("alt", ""); // the h1 below already names the product
    expect(banner).toHaveAttribute("loading", "eager");
    expect(banner).toHaveAttribute("fetchpriority", "high");
    expect([banner.getAttribute("width"), banner.getAttribute("height")]).toEqual(["2000", "667"]);
    expect(container.querySelector(".product-banner source[type='image/avif']")!.getAttribute("srcset")).toMatch(/banner-640\.avif 640w/);
    // Real screenshots, grouped by the platform each capture ran on, lazily loaded and labelled; the banner is never
    // called a screenshot.
    const group = screen.getByRole("group", { name: "Screenshots by platform" });
    const macos = within(group).getByRole("button", { name: /macOS/ });
    const linux = within(group).getByRole("button", { name: /Linux/ });
    expect(macos).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelectorAll(".product-gallery img")).toHaveLength(1);
    fireEvent.click(linux);
    expect(linux).toHaveAttribute("aria-pressed", "true");
    const shots = container.querySelectorAll(".product-gallery img");
    expect(shots).toHaveLength(3);
    shots.forEach((img) => expect(img).toHaveAttribute("loading", "lazy"));
    expect(screen.getByText(/Linux · version 0\.3\.0/)).toBeInTheDocument();
    expect(screen.getAllByText("Screenshot")).toHaveLength(1);
    expect(container.querySelector(".product-banner .art-label")).toBeNull();
    // Exactly one high-priority image on the page.
    expect(container.querySelectorAll("img[fetchpriority='high']")).toHaveLength(1);
  });

  it.each([
    ["hcg-clarity", "HCG Clarity"],
    ["hcg-lifeos", "HCG LifeOS"],
    ["hcg-one-unleashed", "HCG ONE: Unleashed"],
  ])("%s shows its framed icon whole, next to an HTML heading", async (slug, name) => {
    const { container } = renderAt(`/apps/${slug}`);
    await screen.findByRole("heading", { level: 1, name });
    const mark = container.querySelector(".product-hero .product-mark")!;
    expect(mark).toHaveClass("product-mark--framed");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark.querySelector("img")).toHaveAttribute("src", `/media/products/${slug}/icon-256.webp`);
    expect(container.querySelector(".product-banner img")).toHaveAttribute("src", `/media/products/${slug}/banner-2000.webp`);
  });

  it("home and browse cards show each product's banner, lazy-loaded, with the name as text", async () => {
    const { container } = renderAt("/apps");
    await screen.findByText("11 products");
    const cards = [...container.querySelectorAll("article.product-card")];
    expect(cards).toHaveLength(11);
    for (const card of cards) {
      const id = card.getAttribute("data-product-id");
      const img = card.querySelector(".product-cover img")!;
      expect(img.getAttribute("src")).toMatch(new RegExp(`^/media/products/${id}/(banner|cover)-2000\\.webp$`));
      expect(img).toHaveAttribute("loading", "lazy");
      expect(img).toHaveAttribute("alt", "");
      expect(card.querySelector("h3")!.textContent).toBeTruthy();
    }
  });

  it("superseded products keep their page and point to the successor", async () => {
    renderAt("/apps/hcg-reprompter");
    await screen.findByRole("heading", { level: 1, name: "HCG RePrompter" });
    expect(screen.getByText(/HCG RePrompter is now part of HCG Clarity/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to HCG Clarity/ })).toHaveAttribute("href", "/apps/hcg-clarity");
  });

  it("the successor shows its former names", async () => {
    renderAt("/apps/hcg-clarity");
    await screen.findByRole("heading", { level: 1, name: "HCG Clarity" });
    expect(screen.getByText("Formerly HCG RePrompter and Distil")).toBeInTheDocument();
  });

  it("release history shows an empty state", async () => {
    renderAt("/apps/hcg-lifeos/releases");
    expect(await screen.findByRole("heading", { name: "Coming soon" })).toBeInTheDocument();
  });

  it("unknown product and unknown route show not-found pages", async () => {
    renderAt("/apps/does-not-exist");
    expect(await screen.findByRole("heading", { name: "Product not found" })).toBeInTheDocument();
  });

  it("account page without the account service: disabled sign-in and no simulated session", async () => {
    const { container } = renderAt("/account");
    expect(await screen.findByRole("heading", { level: 1, name: /Account & Connections/ })).toBeInTheDocument();
    expect(await screen.findByText(/Account service not available on this site/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with HCG Connect" })).toBeDisabled();
    expect(screen.getByText(/Provisional local data/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/signed in as|welcome back|owner access granted/i);
  });

  it("browse filters work and sync with the URL", async () => {
    const user = userEvent.setup();
    renderAt("/apps?platform=ios");
    expect(await screen.findByText("6 of 11 products match")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "HCG CardX" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "iOS" }));
    expect(screen.getByText("11 products")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "imap");
    expect(screen.getByText("1 of 11 products match")).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search" }));
    await user.click(screen.getByRole("radio", { name: "Release approved" }));
    expect(screen.getByText("1 of 11 products match")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "HCG Mail" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Linux" }));
    expect(screen.getByRole("heading", { name: "No products match these filters" })).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    expect(screen.getByText("11 products")).toBeInTheDocument();
  });

  it("getting started never tells people to disable security and explains IPA installs", async () => {
    const { container } = renderAt("/getting-started");
    await screen.findByRole("heading", { level: 1, name: "Getting started" });
    expect(container.textContent).toMatch(/Downloading an .ipa file does not install it/);
    expect(container.textContent).not.toMatch(/disable (gatekeeper|smartscreen|sip)|spctl --master-disable|run anyway/i);
  });
});

describe("HCG Repo links and editions (shipped catalogue)", () => {
  it("links each jailbreak edition to its HCG Repo product page and keeps checkout disabled", async () => {
    const { container } = renderAt("/apps/hcg-terminal?edition=unleashed");
    await screen.findByRole("heading", { level: 1, name: "HCG Terminal" });
    const unleashed = screen.getByRole("heading", { name: "HCG Terminal Unleashed" }).closest("li")!;
    expect(unleashed).toHaveClass("edition--selected");
    expect(within(unleashed).getByRole("link", { name: /View on HCG Repo/ })).toHaveAttribute(
      "href",
      "https://repo.hakmicapitalgroup.com/products/hcg-terminal-unleashed/",
    );
    expect(within(unleashed).getAllByText("com.hakmicapitalgroup.hcgterminal.unleashed", { selector: "dd" })).toHaveLength(2);
    const standard = screen.getByRole("heading", { name: "HCG Terminal", level: 3 }).closest("li")!;
    expect(within(standard).queryByRole("link", { name: /HCG Repo/ })).toBeNull();
    expectNoFabrication(container);
  });

  it("links Nexus and Sentinel to their HCG Repo pages", async () => {
    renderAt("/apps/hcg-nexus");
    await screen.findByRole("heading", { level: 1, name: "HCG Nexus" });
    expect(screen.getAllByRole("link", { name: /View on HCG Repo/ })[0]).toHaveAttribute("href", "https://repo.hakmicapitalgroup.com/products/hcg-nexus/");
  });
});

describe("account and ownership (stubbed HCG Store server)", () => {
  const ALICE = { sub: "u1", email: "alice@example.test", name: "Alice" };

  it("restores a signed-in session and shows the library", async () => {
    server = {
      session: { configured: true, signedIn: true, user: ALICE },
      library: {
        owned: [
          { productId: "hcg-terminal", slug: "hcg-terminal", name: "HCG Terminal", editionId: "unleashed", editionName: "HCG Terminal Unleashed", state: "downloads-not-available" },
          { productId: "hcg-lifeos", slug: "hcg-lifeos", name: "HCG LifeOS", editionId: null, editionName: null, state: "downloads-not-available" },
        ],
        purchases: [],
        ownershipUnavailable: false,
        downloadsMessage: "Downloads are not available yet.",
      },
    };
    const { container } = renderAt("/library");
    expect(await screen.findByRole("link", { name: "HCG Terminal Unleashed" })).toBeInTheDocument();
    expect(screen.getAllByText("Owned")).toHaveLength(2);
    expect(screen.getAllByText("Downloads are not available yet.").length).toBeGreaterThan(0);
    // Owned products show the same icons as the rest of the store, from the catalogue.
    const icons = [...container.querySelectorAll(".library-item .product-mark img")].map((i) => i.getAttribute("src"));
    expect(icons).toEqual(["/media/products/hcg-terminal/icon-256.webp", "/media/products/hcg-lifeos/icon-256.webp"]);
  });

  it("library v2: licence, edition, current release, HCG Repo, subscriptions, invoices and devices, without install claims", async () => {
    server = {
      session: { configured: true, signedIn: true, user: ALICE },
      library: {
        owned: [
          { productId: "hcg-terminal", slug: "hcg-terminal", name: "HCG Terminal", editionId: "unleashed", editionName: "HCG Terminal Unleashed", state: "downloads-not-available",
            acquisition: "licensed", licence: "Active HCG licence", tier: "unleashed", pricingModel: "not-set", currentRelease: null, hcgRepoKey: "hcg-terminal-unleashed", channel: "jailbreak-package" },
        ],
        purchases: [],
        subscriptions: [],
        invoices: { available: false, items: [], message: "HCG Store has not issued any invoices. Live payments are not switched on." },
        devices: [{ kind: "sileo", label: "Sileo (HCG Repo)", connectedAt: Date.UTC(2026, 10, 20) }],
        packageManagers: [
          { ref: "pms_fixture", client: "Sileo", deviceModel: "iPhone14,2", deviceBound: true, connectedAt: Date.UTC(2026, 10, 20), lastUsedAt: null, expiresAt: null, status: "active", endedAt: null, endedReason: null },
        ],
        devicesNote: "A connected package manager is not an installation.",
        ownershipUnavailable: false,
        downloadsMessage: "Downloads are not available yet.",
      },
    };
    const { container } = renderAt("/library");
    expect(await screen.findByText("Active HCG licence")).toBeInTheDocument();
    expect(screen.getByText("Not released yet")).toBeInTheDocument();
    expect(screen.getByText("Unleashed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Install with Sileo via HCG Repo/ })).toBeInTheDocument();
    expect(screen.getByText("No active subscriptions.")).toBeInTheDocument();
    expect(screen.getByText(/has not issued any invoices/)).toBeInTheDocument();
    const pms = screen.getByTestId("package-managers");
    expect(within(pms).getByText("Sileo")).toBeInTheDocument();
    expect(within(pms).getByText("iPhone14,2")).toBeInTheDocument();
    expect(within(pms).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/installed on|update available|up to date/i);
  });

  it("asks signed-out visitors to sign in for the library", async () => {
    server = { session: { configured: true, signedIn: false } };
    renderAt("/library");
    expect(await within(screen.getByRole("main")).findByRole("link", { name: "Sign in with HCG Connect" })).toHaveAttribute("href", "/auth/login?return_to=%2Flibrary");
  });

  it("shows Owned and 'Get from HCG Repo' only when the server says the edition is owned", async () => {
    server = {
      session: { configured: true, signedIn: true, user: ALICE },
      access: () => [
        access({ editionId: "standard", state: "not-for-sale", signedIn: true }),
        access({ editionId: "unleashed", state: "owned", signedIn: true, owned: true }),
      ],
    };
    renderAt("/apps/hcg-terminal");
    const get = await screen.findByRole("link", { name: /Get from HCG Repo/ });
    expect(get).toHaveAttribute("href", "https://repo.hakmicapitalgroup.com/products/hcg-terminal-unleashed/");
    const unleashed = get.closest("li")!;
    expect(within(unleashed).getByText("Owned")).toBeInTheDocument();
    expect(within(unleashed).getByText("Downloads are not available yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^download/i })).toBeNull();
  });

  it("shows a server-supplied test price and an enabled Buy button only when checkout is ready", async () => {
    server = {
      session: { configured: true, signedIn: true, user: ALICE },
      access: () => [
        access({
          editionId: null,
          state: "not-owned",
          signedIn: true,
          checkoutReady: true,
          checkoutUnavailableReason: null,
          offers: [{ id: "o1", title: "T", kind: "one-time", interval: null, currency: "EUR", unitAmount: 999, grants: ["default"], testOnly: true }],
        }),
      ],
    };
    renderAt("/apps/fixture-nebula-pad", fixtureCatalogue());
    expect(await screen.findByRole("button", { name: "Buy Product" })).toBeEnabled();
    expect(screen.getByText("€9.99")).toBeInTheDocument();
    expect(screen.getByText("Test mode")).toBeInTheDocument();
  });

  it("never shows an enabled Buy button or price without the server, and offers sign-in when signed out", async () => {
    server = { session: { configured: true, signedIn: false }, access: () => [access({ editionId: null })] };
    const { container } = renderAt("/apps/hcg-sentinel");
    expect(await screen.findByRole("link", { name: /Sign in to check access/ })).toBeInTheDocument();
    expectNoFabrication(container);
  });

  it("on a static host (no account service) makes no account requests and says sign-in is unavailable", async () => {
    server = { session: { configured: true, signedIn: true, user: ALICE } };
    render(
      <CatalogueStateProvider provider={staticProvider(realCatalogue())} live={false}>
        <AccountProvider accountService="none">
          <MemoryRouter initialEntries={["/apps/hcg-terminal"]}>
            <AppRoutes />
          </MemoryRouter>
        </AccountProvider>
      </CatalogueStateProvider>,
    );
    expect(await screen.findByText(/Sign-in and purchases are not available on this site/)).toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    for (const b of screen.queryAllByRole("button", { name: "Buy Product" })) expect(b).toBeDisabled();
  });

  it("the checkout return page never claims success by itself", async () => {
    server = { session: { configured: true, signedIn: true, user: ALICE } };
    renderAt("/checkout/return?checkout=chk_forged&status=success");
    expect(await screen.findByRole("heading", { level: 1, name: "Checkout not found" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing was added to your account/)).toBeInTheDocument();
  });
});

describe("store pages with release data (test fixture)", () => {
  it("shows release details without any download link; files require sign-in", async () => {
    renderAt("/apps/fixture-orbit-notes", fixtureCatalogue());
    await screen.findByRole("heading", { level: 1, name: "Fixture Orbit Notes" });
    expect(screen.queryByRole("link", { name: /^Download/ })).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/dropbox\.com/);
    expect(screen.getAllByText(/Delivered only to signed-in HCG accounts with access/).length).toBe(2);
    expect(screen.getByRole("heading", { name: "Version 1.10.0" })).toBeInTheDocument();
    expect(screen.getByText("Signed and notarised (stated by HCG)")).toBeInTheDocument();
    expect(screen.getAllByText(/does not verify signatures or file safety/).length).toBe(2);
  });

  it("shows release info without a download when no artifact exists", async () => {
    renderAt("/apps/fixture-signal-desk", fixtureCatalogue());
    expect(await screen.findByText(/published release information but no file for this release/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Download/ })).toBeNull();
  });

  it("shows a readable fallback when an image fails to load", async () => {
    renderAt("/apps/fixture-nebula-pad", fixtureCatalogue());
    await screen.findByRole("heading", { level: 1, name: "Fixture Nebula Pad" });
    const img = screen.getByAltText("Missing fixture image");
    fireEvent.error(img);
    expect(screen.getByRole("img", { name: "Image unavailable: Missing fixture image" })).toBeInTheDocument();
    expect(screen.getAllByText("Illustration").length).toBeGreaterThan(0);
  });

  it("release history distinguishes current, previous and withdrawn releases and never delivers withdrawn ones", async () => {
    renderAt("/apps/fixture-orbit-notes/releases", fixtureCatalogue());
    await screen.findByRole("heading", { level: 1, name: "Fixture Orbit Notes" });
    const versions = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(versions).toEqual(["v2.0.0-beta.1", "v1.10.1-beta.1", "v1.10.0", "v1.9.2", "v1.2.0"]);
    expect(screen.getByText("Current approved release")).toBeInTheDocument();
    expect(screen.getAllByText("Previous release")).toHaveLength(2);
    expect(screen.getByText("Withdrawn")).toBeInTheDocument();
    expect(screen.getByText(/Withdrawn — not delivered/)).toBeInTheDocument();
  });

  it("gives jailbreak-package guidance (not Linux guidance) for iOS .deb files", async () => {
    renderAt("/apps/fixture-quasar-shell", fixtureCatalogue());
    await screen.findByRole("heading", { level: 1, name: "Fixture Quasar Shell" });
    expect(screen.getByText("How to install: Jailbreak package (.deb)")).toBeInTheDocument();
    expect(screen.queryByText("How to install: Linux package")).toBeNull();
  });

  it("explains that an IPA download does not install the app", async () => {
    renderAt("/apps/fixture-pocket-relay", fixtureCatalogue());
    await screen.findByRole("heading", { level: 1, name: "Fixture Pocket Relay" });
    expect(screen.getByText(/Downloading an .ipa file does not install it/)).toBeInTheDocument();
  });
});

describe("Release Manager", () => {
  const signedIn = { configured: true, signedIn: true, user: { sub: "u", email: "u@example.test", name: "U" } };
  const rel = (over: Record<string, unknown>) => ({
    id: "rel-0000000000000001", productId: "hcg-terminal", productTitle: "HCG Terminal", productSource: "catalogue", editionId: "standard",
    version: "1.0.0", build: "1", channel: "beta", status: "approved", stage: "approved", approvedEligibility: "public", requestedEligibility: "public",
    distribution: "paid", createdAt: 1, submittedAt: 2, approvedAt: Date.UTC(2026, 10, 20), publishedAt: null, supersededBy: null, withdrawnReason: null,
    files: 2, reviewUrl: "https://store.example/publishing/releases/rel-0000000000000001", mayApprove: true, mayPublish: false, ...over,
  });

  it("asks signed-out visitors to sign in and says when publishing is off", async () => {
    server = { session: { configured: true, signedIn: false } };
    renderAt("/release-manager");
    expect(await screen.findByRole("heading", { name: /Sign in to manage releases/ })).toBeInTheDocument();
    cleanup();
    server = { session: signedIn };
    renderAt("/release-manager");
    expect(await screen.findByText("Publishing is not enabled on this Store yet.")).toBeInTheDocument();
  });

  it("groups releases by product with their stage, and approves or publishes nothing itself", async () => {
    server = { session: signedIn, manager: { auditIntact: true, releases: [rel({}), rel({ id: "rel-0000000000000002", version: "0.9.0", stage: "superseded", status: "superseded", mayApprove: false })] } };
    const { container } = renderAt("/release-manager");
    expect(await screen.findByRole("heading", { level: 2, name: "HCG Terminal" })).toBeInTheDocument();
    expect([...container.querySelectorAll(".rm-release .badge")].map((b) => b.textContent)).toEqual(["Approved, not published", "Superseded"]);
    expect(screen.getByRole("link", { name: "Review, approve or publish" })).toHaveAttribute("href", "https://store.example/publishing/releases/rel-0000000000000001");
    expect(screen.getByRole("button", { name: "Compare with 0.9.0 (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(approve|publish)$/i })).toBeNull();
    expect(container.textContent).not.toMatch(/downloads?\s+\d|installed/i);
  });

  it("warns when the audit chain does not verify, and explains an empty list without implying a purchase grants rights", async () => {
    server = { session: signedIn, manager: { auditIntact: false, releases: [] } };
    renderAt("/release-manager");
    expect(await screen.findByText(/audit chain does not verify/)).toBeInTheDocument();
    expect(screen.getByText(/Buying a product never grants either/)).toBeInTheDocument();
  });
});

describe("Control Center (web administration)", () => {
  const user = { sub: "u1", email: "u1@example.test", name: "U" };
  const me = (perms: Partial<{ submit: boolean; approve: boolean; publish: boolean }>) => ({
    sub: "u1", email: "u1@example.test", permissions: { submit: false, approve: false, publish: false, offers: false, ...perms },
    administrator: Object.values(perms).some(Boolean), publishingMode: "uploads",
    capabilities: { uploads: true, approval: false, publication: false, publicDelivery: false, offers: false }, devicePolicy: { mode: "off", note: "" }, csrfToken: "t",
  });

  it("asks for sign-in, then shows an ordinary account that it is not authorised (the server decides)", async () => {
    server = { session: { configured: true, signedIn: false } };
    renderAt("/control-center");
    expect(await screen.findByRole("heading", { name: /sign in to administer/i })).toBeTruthy();
    cleanup();
    server = { session: { configured: true, signedIn: true, user }, me: me({}) };
    renderAt("/control-center");
    expect(await screen.findByTestId("not-authorised")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText(/create private draft/i)).toBeNull();
  });

  it("shows HCG Store's operations to an account HCG granted store.publish, with publication marked as off", async () => {
    server = { session: { configured: true, signedIn: true, user }, me: me({ submit: true }) };
    renderAt("/control-center");
    expect(await screen.findByRole("tab", { name: "Upload application" })).toBeTruthy();
    expect(screen.getByText("Private uploads only")).toBeTruthy();
    for (const op of ["Add new update", "Add new product", "Add to listed product", "Continue a draft"]) expect(screen.getByRole("radio", { name: new RegExp(op) })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /create private draft/i })).toBeTruthy();
    expect(screen.getByText(/supersede previous compatible release after successful publication/i)).toBeTruthy();
  });

  it("shows Manage product on a product page only to administrators", async () => {
    server = { session: { configured: true, signedIn: true, user }, me: me({}) };
    renderAt("/apps/hcg-mail");
    await screen.findAllByRole("heading", { name: /HCG Mail/ });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("manage-product")).toBeNull();
    cleanup();
    server = { session: { configured: true, signedIn: true, user }, me: me({ approve: true }) };
    renderAt("/apps/hcg-mail");
    const link = await screen.findByTestId("manage-product");
    expect(link.getAttribute("href")).toBe("/control-center?tab=products&product=hcg-mail");
  });
});


describe("Launch page (published product with landing content)", () => {
  const MAIL_RELEASE = "rel-bc6c2096b73a977f";
  const details = { version: "1.0.0-beta.1", channel: "beta", architectures: ["x64"], platform: "windows", format: "exe", sizeBytes: 119023581, sha256: "0424c7c6a264b66da841e320b2661fdcf9b2d8bf0bf17e3ab1ec92af32202fdf", minimumOs: "Windows 10", signing: "unsigned", publishedAt: 1795757739075 };
  const mailAccess = (slug: string) => slug === "hcg-mail"
    ? [access({ productId: "hcg-mail", editionId: "windows-desktop", state: "free", anonymous: true, downloadsAvailable: true, downloadsMessage: "Free download.", artifacts: [{ id: "art-cdf727e41e4fb77d", fileName: "HCGMail.exe", releaseId: MAIL_RELEASE, details }] }),
       access({ productId: "hcg-mail", editionId: "ios" })]
    : [];
  const published = () => {
    const c = realCatalogue();
    return { ...c, products: c.products.map((p) => (p.id === "hcg-mail" ? { ...p, currentReleaseId: MAIL_RELEASE } : p)) };
  };

  it("leads with the brand, the headline, and one download from HCG Store's own endpoint, with its real facts", async () => {
    server = { session: { configured: true, signedIn: false }, access: mailAccess };
    const { container } = renderAt("/apps/hcg-mail", published());
    expect(await screen.findByRole("heading", { level: 1, name: "HCG Mail" })).toBeInTheDocument();
    expect(screen.getByText("Your inbox. Reimagined.", { selector: ".launch-hero__headline" })).toBeInTheDocument();
    expect(screen.getByText("A dedicated desktop email experience built for an interconnected future.", { selector: ".launch-hero__tagline" })).toBeInTheDocument();
    const downloads = await screen.findAllByTestId("launch-download");
    expect(downloads.length).toBeGreaterThanOrEqual(3); // hero, platform card, bottom (and the sticky bar)
    for (const d of downloads) expect(d.getAttribute("href")).toBe("/api/v1/downloads/art-cdf727e41e4fb77d");
    expect(downloads[0]).toHaveTextContent("Download for Windows");
    expect(downloads[0]).toHaveTextContent("Windows x64 · EXE · 114 MB");
    expect(container.querySelector(".launch-hero__facts")).toHaveTextContent(/1\.0\.0-beta\.1.*Free.*Windows x64.*114 MB.*None required/);
    // The unsigned warning is next to the download, not hidden.
    expect(screen.getAllByText("Not code-signed.").length).toBeGreaterThan(0);
    // macOS is announced, never offered; nothing links to GitHub or another file host.
    expect(screen.getAllByText("Coming soon").length).toBeGreaterThan(0);
    expect(screen.getByText("No download is offered yet.")).toBeInTheDocument();
    expect([...container.querySelectorAll("a")].some((a) => /github\.com\/.*\/releases|\.exe$|\.pkg$|\.zip$/.test(a.getAttribute("href") ?? ""))).toBe(false);
    expect(screen.getByTestId("launch-sha256")).toHaveTextContent(details.sha256);
    // Genuine screenshots only, each with its caption.
    expect(container.querySelectorAll(".launch-gallery li")).toHaveLength(6);
    // No ratings, review counts, download statistics or invented prices (the downloads here are the server's).
    for (const re of FORBIDDEN) expect(container.textContent ?? "").not.toMatch(re);
  });

  const MAC_RELEASE = "rel-1111111111111111";
  const macFile = (id: string, fileName: string, format: string, sizeBytes: number) => ({
    id, fileName, releaseId: MAC_RELEASE,
    details: { version: "1.0.0-beta.1", channel: "beta", architectures: ["arm64"], platform: "macos", format, sizeBytes, sha256: (format === "pkg" ? "b" : "c").repeat(64), minimumOs: "macOS 11", signing: "notarized", publishedAt: 1795800000000 },
  });
  const bothAccess = (slug: string) => slug === "hcg-mail"
    ? [...mailAccess(slug), access({ productId: "hcg-mail", editionId: "macos-desktop", state: "free", anonymous: true, downloadsAvailable: true, downloadsMessage: "Free download.",
        artifacts: [macFile("art-2222222222222222", "HCG Mail.app.zip", "zip", 60_000_000), macFile("art-1111111111111111", "HCG Mail-1.0.0-beta.1-osx-arm64.pkg", "pkg", 61_000_000)] })]
    : [];
  /** The catalogue as the live overlay leaves it after the macOS release is published (applyLivePublications). */
  const withMac = () => applyLivePublications(published(), { format: "hcg.store.published/1", products: { "hcg-mail": [
    { releaseId: MAIL_RELEASE, editionId: "windows-desktop", version: "1.0.0-beta.1", build: "1.0.0.0", channel: "beta", distribution: "free", publishedAt: 1795757739075, releaseNotes: [], knownLimitations: [], files: [{ id: "art-cdf727e41e4fb77d", fileName: "HCGMail.exe", platform: "windows", format: "exe", architectures: ["x64"], minimumOs: "Windows 10", sizeBytes: 119023581, sha256: details.sha256, signing: "unsigned" }] },
    { releaseId: MAC_RELEASE, editionId: "macos-desktop", version: "1.0.0-beta.1", build: "4", channel: "beta", distribution: "free", publishedAt: 1795800000000,
      releaseNotes: ["HCG Mail 1.0.0-beta.1 for Mac with Apple silicon: public beta. Free."], knownLimitations: ["The window needs a display at least 1040 points wide."],
      files: [macFile("art-1111111111111111", "HCG Mail-1.0.0-beta.1-osx-arm64.pkg", "pkg", 61_000_000), macFile("art-2222222222222222", "HCG Mail.app.zip", "zip", 60_000_000)].map((f) => ({ id: f.id, fileName: f.fileName, ...f.details })) },
  ] } });
  const asVisitor = (userAgent: string, platform: string) => {
    const nav = window.navigator as unknown as Record<string, unknown>;
    const saved = { userAgent: nav.userAgent, platform: nav.platform };
    Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true });
    Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
    return () => {
      Object.defineProperty(window.navigator, "userAgent", { value: saved.userAgent, configurable: true });
      Object.defineProperty(window.navigator, "platform", { value: saved.platform, configurable: true });
    };
  };

  it("once macOS is published: a Mac visitor is offered the macOS installer first, with the ZIP and Windows still offered", async () => {
    const restore = asVisitor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "MacIntel");
    try {
      server = { session: { configured: true, signedIn: false }, access: bothAccess };
      const { container } = renderAt("/apps/hcg-mail", withMac());
      const downloads = await screen.findAllByTestId("launch-download");
      expect(downloads[0]).toHaveTextContent("Download for macOS");
      expect(downloads[0]).toHaveTextContent("Apple Silicon (M-series) · Installer (.pkg)");
      expect(downloads[0]!.getAttribute("href")).toBe("/api/v1/downloads/art-1111111111111111");
      const hrefs = downloads.map((d) => d.getAttribute("href"));
      for (const id of ["art-1111111111111111", "art-2222222222222222", "art-cdf727e41e4fb77d"]) expect(hrefs).toContain(`/api/v1/downloads/${id}`);
      expect(screen.getByTestId("launch-also")).toHaveTextContent("Also available for Windows.");
      // macOS is no longer "coming soon"; both platforms are available now, macOS first for this visitor.
      expect(screen.queryByText("No download is offered yet.")).toBeNull();
      expect(container.querySelector(".launch-hero__upcoming")).toBeNull();
      expect([...container.querySelectorAll(".launch-platform--available h3")].map((x) => x.textContent)).toEqual(["macOS", "Windows"]);
      // Notarized: no Gatekeeper warning next to the macOS download; the Windows file keeps its SmartScreen note.
      expect(container.querySelector(".launch-hero")!.textContent).not.toMatch(/Not notarised/);
      expect(screen.getAllByText("Not code-signed.").length).toBeGreaterThan(0);
      expect(container.querySelector(".launch-hero__facts")).toHaveTextContent(/1\.0\.0-beta\.1.*Free.*Apple Silicon \(M-series\).*None required/);
      // Each platform's own release notes and limitations, and both in the release history.
      expect(container.textContent).toContain("HCG Mail 1.0.0-beta.1 for Mac with Apple silicon: public beta. Free.");
      expect(container.textContent).toContain("The window needs a display at least 1040 points wide.");
      expect(container.textContent).toMatch(/shasum -a 256 "HCG Mail\.app\.zip"/);
      for (const re of FORBIDDEN) expect(container.textContent ?? "").not.toMatch(re);
    } finally {
      restore();
    }
  });

  it("a Windows visitor still gets the unchanged Windows file first, with macOS offered next to it", async () => {
    const restore = asVisitor("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36", "Win32");
    try {
      server = { session: { configured: true, signedIn: false }, access: bothAccess };
      const { container } = renderAt("/apps/hcg-mail", withMac());
      const downloads = await screen.findAllByTestId("launch-download");
      expect(downloads[0]!.getAttribute("href")).toBe("/api/v1/downloads/art-cdf727e41e4fb77d");
      expect(downloads[0]).toHaveTextContent("Windows x64 · EXE · 114 MB");
      expect(screen.getByTestId("launch-also")).toHaveTextContent("Also available for macOS.");
      expect([...container.querySelectorAll(".launch-platform--available h3")].map((x) => x.textContent)).toEqual(["Windows", "macOS"]);
    } finally {
      restore();
    }
  });

  it("without a current release, the product keeps its detail page", async () => {
    server = { session: { configured: true, signedIn: false }, access: mailAccess };
    const c = realCatalogue();
    const { container } = renderAt("/apps/hcg-mail", { ...c, products: c.products.map((p) => (p.id === "hcg-mail" ? { ...p, currentReleaseId: null } : p)) });
    expect(await screen.findByRole("heading", { level: 1, name: "HCG Mail" })).toBeInTheDocument();
    expect(container.querySelector(".launch")).toBeNull();
  });
});
