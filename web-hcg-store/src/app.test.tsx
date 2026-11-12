import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "./App";
import { CatalogueStateProvider } from "./app/catalogue-context";
import type { Catalogue } from "./domain/catalogue";
import { fixtureCatalogue, realCatalogue, staticProvider } from "./test/fixtures";

function renderAt(path: string, catalogue: Catalogue = realCatalogue()) {
  return render(
    <CatalogueStateProvider provider={staticProvider(catalogue)}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </CatalogueStateProvider>,
  );
}

/** Things HCG Store must never show: fabricated stats, ratings, prices, purchase or install claims. */
const FORBIDDEN = [/\b\d[\d,.]*\s*(downloads|installs|users)\b/i, /\brating/i, /\breviews?\b/i, /★/, /[$€£]\s?\d/, /\bbuy\b/i, /add to cart/i, /successfully installed/i, /signed in as/i, /live activity/i];
const expectNoFabrication = (container: HTMLElement) => {
  const text = container.textContent ?? "";
  for (const re of FORBIDDEN) expect(text).not.toMatch(re);
};

describe("store pages with the shipped catalogue", () => {
  it("home shows real counts, no download section, and honest messaging", async () => {
    const { container } = renderAt("/");
    expect(await screen.findByRole("heading", { level: 1, name: /HCG Store/ })).toBeInTheDocument();
    const stats = screen.getByLabelText("Catalogue status");
    expect(within(stats).getByText("Public downloads").nextSibling).toHaveTextContent("0");
    expect(within(stats).getByText("Products listed").nextSibling).toHaveTextContent("14");
    expect(screen.queryByRole("heading", { name: "Available downloads" })).toBeNull();
    expect(screen.getByText(/No public downloads have been published yet/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "In development" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "HCG Development Tools" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /download/i })).toBeNull();
    expectNoFabrication(container);
  });

  it("home hero uses the banner as a labelled illustration and keeps the heading if it fails", async () => {
    renderAt("/");
    await screen.findByRole("heading", { level: 1, name: /HCG Store/ });
    const banner = screen.getByRole("img", { name: /illustration of the HCG Store wordmark/i });
    expect(banner).toHaveAttribute("loading", "eager");
    expect(banner.getAttribute("srcset")).toMatch(/hcg-store-banner-800\.webp 800w/);
    expect(screen.getByText("Illustration")).toBeInTheDocument();
    fireEvent.error(banner);
    expect(screen.queryByRole("img", { name: /illustration of the HCG Store wordmark/i })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: /HCG Store/ })).toBeInTheDocument();
  });

  it("product page shows 'No public release supplied' and no download button", async () => {
    const { container } = renderAt("/apps/hcg-mail");
    expect(await screen.findByRole("heading", { level: 1, name: "HCG Mail" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No public release supplied" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^download/i })).toBeNull();
    expect(screen.getByText(/Development activity does not mean a downloadable build exists/)).toBeInTheDocument();
    expectNoFabrication(container);
  });

  it("labels real screenshots and generated tiles", async () => {
    renderAt("/apps/hcg-executable-maker");
    await screen.findByRole("heading", { level: 1, name: "HCG Executable Maker" });
    expect(screen.getAllByText("Screenshot").length).toBe(2);
    expect(screen.getByRole("img", { name: /generated artwork, not a screenshot/ })).toBeInTheDocument();
  });

  it("release history shows an empty state", async () => {
    renderAt("/apps/hcg-lifeos/releases");
    expect(await screen.findByRole("heading", { name: "No public release supplied" })).toBeInTheDocument();
  });

  it("unknown product and unknown route show not-found pages", async () => {
    renderAt("/apps/does-not-exist");
    expect(await screen.findByRole("heading", { name: "Product not found" })).toBeInTheDocument();
  });

  it("account page shows 'HCG Connect not configured', a disabled sign-in and no simulated session", async () => {
    const { container } = renderAt("/account");
    expect(await screen.findByRole("heading", { level: 1, name: /Account & Connections/ })).toBeInTheDocument();
    expect(screen.getAllByText(/HCG Connect not configured/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Sign in with HCG Connect" })).toBeDisabled();
    expect(screen.getByText(/Provisional local data/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/signed in as|welcome back|owner access granted/i);
  });

  it("browse filters work and sync with the URL", async () => {
    const user = userEvent.setup();
    renderAt("/apps?platform=ios");
    expect(await screen.findByText("1 of 14 products match")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "HCG CardX" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "iOS" }));
    expect(screen.getByText("14 products")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "imap");
    expect(screen.getByText("1 of 14 products match")).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search" }));
    await user.click(screen.getByRole("radio", { name: "Download available" }));
    expect(screen.getByRole("heading", { name: "No products match these filters" })).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    expect(screen.getByText("14 products")).toBeInTheDocument();
  });

  it("getting started never tells people to disable security and explains IPA installs", async () => {
    const { container } = renderAt("/getting-started");
    await screen.findByRole("heading", { level: 1, name: "Getting started" });
    expect(container.textContent).toMatch(/Downloading an .ipa file does not install it/);
    expect(container.textContent).not.toMatch(/disable (gatekeeper|smartscreen|sip)|spctl --master-disable|run anyway/i);
  });
});

describe("store pages with release data (test fixture)", () => {
  it("offers Dropbox downloads as plain links with dl=1, and reports only 'requested'", async () => {
    renderAt("/apps/fixture-orbit-notes", fixtureCatalogue());
    await screen.findByRole("heading", { level: 1, name: "Fixture Orbit Notes" });
    const links = screen.getAllByRole("link", { name: /^Download/ });
    expect(links).toHaveLength(2);
    for (const a of links) {
      const href = new URL(a.getAttribute("href")!);
      expect(href.hostname).toBe("www.dropbox.com");
      expect(href.searchParams.get("dl")).toBe("1");
      expect(href.searchParams.get("rlkey")).toBeTruthy();
      expect(a).not.toHaveAttribute("download");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    // Prevent jsdom navigation; we only check the status message.
    links[0]!.addEventListener("click", (e) => e.preventDefault());
    await act(async () => fireEvent.click(links[0]!));
    const status = screen.getByText(/Download requested from Dropbox/);
    expect(status.textContent).toMatch(/cannot confirm it finished or that anything was installed/);
    expect(screen.getByRole("heading", { name: "Version 1.10.0" })).toBeInTheDocument();
    expect(screen.getByText("Signed and notarised (stated by HCG)")).toBeInTheDocument();
    expect(screen.getAllByText(/does not verify signatures or file safety/).length).toBe(2);
  });

  it("shows release info without a download when no artifact exists", async () => {
    renderAt("/apps/fixture-signal-desk", fixtureCatalogue());
    expect(await screen.findByText(/published release information but no downloadable file/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Download/ })).toBeNull();
  });

  it("shows a readable fallback when an image fails to load", async () => {
    renderAt("/apps/fixture-nebula-pad", fixtureCatalogue());
    await screen.findByRole("heading", { level: 1, name: "Fixture Nebula Pad" });
    const img = screen.getByAltText("Missing fixture image");
    fireEvent.error(img);
    expect(screen.getByRole("img", { name: "Image unavailable: Missing fixture image" })).toBeInTheDocument();
    expect(screen.getByText(/Concept artwork — not the working app/)).toBeInTheDocument();
  });

  it("release history distinguishes current, previous and withdrawn releases and disables withdrawn downloads", async () => {
    renderAt("/apps/fixture-orbit-notes/releases", fixtureCatalogue());
    await screen.findByRole("heading", { level: 1, name: "Fixture Orbit Notes" });
    const versions = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(versions).toEqual(["v2.0.0-beta.1", "v1.10.1-beta.1", "v1.10.0", "v1.9.2", "v1.2.0"]);
    expect(screen.getByText("Current approved release")).toBeInTheDocument();
    expect(screen.getAllByText("Previous release")).toHaveLength(2);
    expect(screen.getByText("Withdrawn")).toBeInTheDocument();
    expect(screen.getByText("Withdrawn — download disabled.")).toBeInTheDocument();
  });

  it("explains that an IPA download does not install the app", async () => {
    renderAt("/apps/fixture-pocket-relay", fixtureCatalogue());
    await screen.findByRole("heading", { level: 1, name: "Fixture Pocket Relay" });
    expect(screen.getByText(/Downloading an .ipa file does not install it/)).toBeInTheDocument();
  });
});
