// @vitest-environment node
/**
 * "My HCG apps" (GET /api/v1/my-apps) against HCG's shared product-access API as published on 18 Nov 2026
 * (main-site docs/hcg-connect/shared-product-access-handoff.md): /me product_policy, /library founder_ownership, and
 * /access per product. Access comes only from HCG; names, e-mail addresses, Store profiles and browser data never
 * grant it, and access never makes an unreleased app downloadable.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FOUNDER_POLICY, parseAccess, type TestLedgerAuthority } from "../src/entitlements";
import { setProfile } from "../src/profiles";
import { startHarness, type Harness } from "./harness";

const BASE = "https://hcg.test/api/public/ecosystem/v1";
const FOUNDER = { sub: "11111111-1111-4111-8111-111111111111", email: "founder@example.test", name: "Founder" };
const ORDINARY = { sub: "22222222-2222-4222-8222-222222222222", email: "founder@example.test", name: "Founder Display Name (test)" };
const ORG_HCG = "44444444-4444-4444-8444-444444444444";
const ORG_CUSTOMER = "33333333-3333-4333-8333-333333333333";
// HCG's registry as /library's founder_ownership lists it (abbreviated): Store-known and registry-only products.
const REGISTRY = [
  { id: "fixture.quasar.shell", name: "Fixture Quasar Shell", release: "in_development" },
  { id: "hakmi.signature.studios", name: "Hakmi Signature Studios", release: "in_development" },
  { id: "hcg.store", name: "HCG Store", release: "planned" },
];

/** A mock of HCG's published API with the handoff's exact response shapes. */
function mockHcg(opts: { founderActive: boolean; ordinaryLicence?: string }) {
  const calls: string[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/public/ecosystem/v1", "");
    calls.push(path + url.search);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    let sub = "";
    try {
      sub = (JSON.parse(Buffer.from(auth.replace("Bearer ", "").split(".")[1] ?? "", "base64url").toString("utf8")) as { sub: string }).sub;
    } catch {
      return json(401, { api_version: "v1", error: { code: "unauthorized", message: "x" } });
    }
    const founder = sub === FOUNDER.sub && opts.founderActive;
    const orgs = sub === FOUNDER.sub ? [{ org_id: ORG_HCG, slug: "hcg", name: "Hakmi Capital Group", kind: "internal", org_role: "admin" }] : [{ org_id: ORG_CUSTOMER, slug: "c", name: "C", kind: "customer", org_role: "owner" }];
    const policy = { active: founder, policy_key: founder ? FOUNDER_POLICY : null, scope: "all_registered_products_editions_features", administrative_roles_granted: false, purchase_record_created: false };
    if (path === "/me") {
      return json(200, { api_version: "v1", user: { id: sub, email: "x@example.test", display_name: sub === FOUNDER.sub ? "Founder Display Name (test)" : null }, organisations: orgs, product_policy: policy, revalidate_after_seconds: 60 });
    }
    if (path === "/library") {
      const items = sub === ORDINARY.sub && opts.ordinaryLicence
        ? [{ org_id: ORG_CUSTOMER, product_id: opts.ordinaryLicence, product_name: "x", scope: "product", scope_key: null, license_type: "perpetual", status: "active", starts_at: "2026-11-01T00:00:00Z", ends_at: null }]
        : [];
      const founder_ownership = founder ? REGISTRY.map((p) => ({ product_id: p.id, product_name: p.name, ownership: "founder_owner", entitlement_source: FOUNDER_POLICY, editions: "all", administrative_roles_granted: false, purchase_record_created: false })) : [];
      return json(200, { api_version: "v1", organisations: orgs, items, founder_ownership, revalidate_after_seconds: 300 });
    }
    if (path === "/access") {
      const product = REGISTRY.find((p) => p.id === url.searchParams.get("product"));
      const org = url.searchParams.get("org");
      if (!founder && !org) return json(400, { api_version: "v1", error: { code: "org_required", message: "x" } });
      if (!product) return json(404, { api_version: "v1", error: { code: "product_unavailable", message: "x" } });
      if (!founder && !orgs.some((o) => o.org_id === org)) return json(403, { api_version: "v1", error: { code: "not_org_member", message: "x" } });
      const licensed = !founder && opts.ordinaryLicence === product.id;
      const src = founder ? FOUNDER_POLICY : licensed ? "organisation_license" : null;
      return json(200, {
        api_version: "v1",
        product: { product_id: product.id, name: product.name, release_status: product.release },
        org_id: org,
        ownership: { owned: founder || licensed, kind: founder ? "founder_owner" : licensed ? "organisation_license" : "none", policy_key: founder ? FOUNDER_POLICY : null, administrative_roles_granted: false, purchase_record_created: false },
        entitlement_source: src,
        editions: founder ? "all" : licensed ? ["standard"] : [],
        features: { download: founder || licensed, "illustration.layers": false },
        feature_details: [
          { feature_key: "download", enabled: true, access_class: "customer", editions: "all", allowed: founder || licensed, entitlement_source: src, reason: founder || licensed ? null : "not_licensed" },
          { feature_key: "illustration.layers", enabled: false, access_class: "customer", editions: "all", allowed: false, entitlement_source: null, reason: "feature_unavailable" },
        ],
        licences: [],
        licence: null,
        protected_action_check: "/api/public/ecosystem/v1/check",
        revalidate_after_seconds: 300,
      });
    }
    return new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

type Apps = {
  centralStatus: string;
  displayName: string | null;
  ownerAccess: { label: string; source: string } | null;
  apps: {
    centralProductId: string | null; name: string; storeProductId: string | null; hcgReleaseStatus: string | null; storeRelease: string;
    access: { state: string; source: string | null; editions: "all" | string[]; features: { available: string[]; notAvailable: number } };
    download: string;
  }[];
};

let h: Harness | null = null;
afterEach(async () => {
  await h?.stop();
  h = null;
});
const startCentral = async (opts: { founderActive: boolean; ordinaryLicence?: string }) => {
  const m = mockHcg(opts);
  h = await startHarness({ authority: "hcg-ecosystem", env: { HCG_ECOSYSTEM_API_URL: BASE }, ecosystemFetch: m.fetchImpl });
  return m;
};
const myApps = async (user: typeof FOUNDER) => {
  const web = await h!.signIn(user);
  return { web, body: (await (await web.get("/api/v1/my-apps")).json()) as Apps };
};

describe("My HCG apps against HCG's published product-access API", () => {
  it("Founder: every registered app (from HCG's registry), Owner access — All features, source Founder / Owner grant, release shown separately", async () => {
    const m = await startCentral({ founderActive: true });
    const { web, body } = await myApps(FOUNDER);
    expect(body.ownerAccess).toEqual({ label: "Owner access — All features", source: "Founder / Owner grant" });
    expect(body.displayName).toBe("Founder Display Name (test)");
    const byId = new Map(body.apps.map((a) => [a.centralProductId, a]));
    for (const p of REGISTRY) {
      expect(byId.get(p.id)!.access).toMatchObject({ state: "owner", source: "Founder / Owner grant", editions: "all" });
      expect(byId.get(p.id)!.hcgReleaseStatus).toBe(p.release);
    }
    // Registry-only app: owned, but not offered by HCG Store and nothing to download.
    expect(byId.get("hakmi.signature.studios")).toMatchObject({ storeProductId: null, storeRelease: "not-in-store", download: "not-in-store" });
    // A disabled feature is reported as not switched on, not as granted.
    expect(byId.get("fixture.quasar.shell")!.access.features).toEqual({ available: ["download"], notAvailable: 1 });
    expect(JSON.stringify(body)).not.toMatch(/Purchased/);
    // The Founder's /access calls carry no organisation; nothing asked HCG to create a purchase.
    expect(m.calls.filter((c) => c.startsWith("/access")).every((c) => !c.includes("org="))).toBe(true);
    expect(h!.db.prepare("SELECT COUNT(*) AS n FROM purchases").get()).toEqual({ n: 0 });
    // The account card's name comes from HCG's /me for this matched account.
    expect(((await (await web.get("/api/v1/session")).json()) as { user: { name: string } }).user.name).toBe("Founder Display Name (test)");
    // Token-free evidence of what was shown.
    const ev = h!.db.prepare("SELECT detail, sub FROM auth_events WHERE type = 'my_apps_viewed'").get() as { detail: string; sub: string | null };
    expect(JSON.parse(ev.detail)).toMatchObject({ central: "ok", founderPolicy: true, owner: REGISTRY.length });
    expect(ev.sub).toBeNull();
  });

  it("ordinary account: only its own licence, asked per organisation; a founder name, e-mail or Store profile grants nothing", async () => {
    const m = await startCentral({ founderActive: true, ordinaryLicence: "fixture.quasar.shell" });
    await h!.signIn(ORDINARY);
    setProfile(h!.db, { sub: ORDINARY.sub, displayName: "Founder Display Name (test)", designation: "Founder / Original User", authorisedBy: "test", performedBy: "test", now: Date.now() });
    const { body } = await myApps(ORDINARY);
    expect(body.ownerAccess).toBeNull();
    expect(body.apps.filter((a) => a.access.state === "owner")).toEqual([]);
    expect(body.apps.find((a) => a.centralProductId === "fixture.quasar.shell")!.access).toMatchObject({ state: "licensed", source: "Organisation licence", editions: ["Fixture Quasar Shell"] });
    expect(body.apps.filter((a) => a.access.state === "licensed").map((a) => a.centralProductId)).toEqual(["fixture.quasar.shell"]);
    // Registry-only products are not listed for an ordinary account (HCG lists the registry only for the Founder).
    expect(body.apps.some((a) => a.centralProductId === "hakmi.signature.studios")).toBe(false);
    const access = m.calls.filter((c) => c.startsWith("/access"));
    expect(access.length).toBeGreaterThan(0);
    expect(access.every((c) => c.includes(`org=${ORG_CUSTOMER}`))).toBe(true);
  });

  it("revoking HCG's Founder policy shows on the next page load", async () => {
    await startCentral({ founderActive: false });
    const { body } = await myApps(FOUNDER);
    expect(body.ownerAccess).toBeNull();
    expect(body.apps.every((a) => a.access.state !== "owner")).toBe(true);
  });
});

describe("TEST ledger stand-in", () => {
  it("Founder policy on and off; access state never comes from a name", async () => {
    h = await startHarness();
    const ledger = h.authority as TestLedgerAuthority;
    ledger.setFounderPolicy(FOUNDER.sub, true);
    expect((await myApps(FOUNDER)).body.ownerAccess).not.toBeNull();
    expect((await myApps(ORDINARY)).body.ownerAccess).toBeNull();
    ledger.setFounderPolicy(FOUNDER.sub, false);
    expect((await myApps(FOUNDER)).body.ownerAccess).toBeNull();
    expect((await fetch(`${h.origin}/api/v1/my-apps`)).status).toBe(401);
  });
});

describe("parseAccess (strict)", () => {
  const good = {
    api_version: "v1",
    product: { product_id: "hcg.terminal", name: "HCG Terminal", release_status: "planned" },
    ownership: { owned: true, kind: "founder_owner", policy_key: FOUNDER_POLICY },
    entitlement_source: FOUNDER_POLICY,
    editions: "all",
    feature_details: [],
  };
  it("accepts the Founder kind only when the answer says so for that exact product", () => {
    expect(parseAccess(good, "hcg.terminal").kind).toBe("founder_owner");
    expect(parseAccess(good, "hcg.mail").kind).toBe("unknown"); // answer for another product
    expect(parseAccess({ ...good, entitlement_source: "organisation_license" }, "hcg.terminal").kind).toBe("unknown");
    expect(parseAccess({ ...good, ownership: { ...good.ownership, policy_key: "something_else" } }, "hcg.terminal").kind).toBe("unknown");
    expect(parseAccess({ ...good, ownership: { owned: false, kind: "founder_owner", policy_key: FOUNDER_POLICY } }, "hcg.terminal").kind).toBe("unknown");
    expect(parseAccess({ ...good, api_version: "v2" }, "hcg.terminal").kind).toBe("unknown");
    expect(parseAccess({ ...good, ownership: { owned: false, kind: "none", policy_key: null }, entitlement_source: null }, "hcg.terminal")).toMatchObject({ kind: "none", editions: [] });
  });
});
