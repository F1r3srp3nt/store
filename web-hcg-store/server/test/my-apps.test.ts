// @vitest-environment node
/**
 * "My HCG apps" (GET /api/v1/my-apps) and HCG's Owner-access policy as HCG Store reads it. Access comes only from
 * HCG (/library, stood in for by the TEST ledger here); names, e-mail addresses, profiles and browser data never
 * grant it, and owner access never makes an unreleased app downloadable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseLibrary, type TestLedgerAuthority } from "../src/entitlements";
import { setProfile } from "../src/profiles";
import { startHarness, type Harness } from "./harness";

const FOUNDER = { sub: "user-founder-0001", email: "founder@example.test", name: "Founder" };
const ORDINARY = { sub: "user-ordinary-0002", email: "founder@example.test", name: "F1r3srp3nt - YasinTrades -CEO & Founder" };

let h: Harness;
let ledger: TestLedgerAuthority;
beforeEach(async () => {
  h = await startHarness();
  ledger = h.authority as TestLedgerAuthority;
});
afterEach(async () => h.stop());

type Apps = {
  centralStatus: string;
  ownerAccess: { label: string; source: string } | null;
  apps: { productId: string; centralProductId: string | null; access: { state: string; source: string | null; allEditions: boolean; editionIds: string[] }; download: string; released: boolean; manage: string | null }[];
};
const myApps = async (user: typeof FOUNDER) => (await (await (await h.signIn(user)).get("/api/v1/my-apps")).json()) as Apps;

describe("My HCG apps", () => {
  it("signed out: 401", async () => {
    expect((await fetch(`${h.origin}/api/v1/my-apps`)).status).toBe(401);
  });

  it("Owner access confirmed by HCG: every registered product, all editions and features, source Founder / Owner grant, never 'Purchased'", async () => {
    ledger.setOwnerAccess(FOUNDER.sub, true); // HCG's Owner-access policy (granted centrally by the HCG Owner)
    const r = await myApps(FOUNDER);
    expect(r.ownerAccess).toMatchObject({ label: "Owner access — All features", source: "Founder / Owner grant" });
    for (const app of r.apps) {
      if (app.centralProductId) {
        expect(app.access).toMatchObject({ state: "owner", source: "Founder / Owner grant", allEditions: true });
        expect(app.manage).not.toBeNull();
        // Access does not make an unreleased app downloadable.
        if (!app.released) expect(app.download).toBe("not-released");
      } else {
        expect(app.access.state).toBe("not-registered"); // no central ID: nobody can hold access yet
      }
      expect(JSON.stringify(app)).not.toMatch(/Purchased/);
    }
    // No purchase record was created for any of it.
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM purchases").get()).toEqual({ n: 0 });
  });

  it("ordinary accounts see only their own grants; a founder name, e-mail or profile grants nothing", async () => {
    ledger.setOwnerAccess(FOUNDER.sub, true);
    ledger.grant(ORDINARY.sub, "fixture.quasar.shell", "standard", "admin-grant", null); // one edition, from HCG
    setProfile(h.db, { sub: ORDINARY.sub, displayName: "F1r3srp3nt - YasinTrades -CEO & Founder", designation: "Founder / Original User", authorisedBy: "test", performedBy: "test", now: Date.now() });
    const r = await myApps(ORDINARY);
    expect(r.ownerAccess).toBeNull();
    const quasar = r.apps.find((a) => a.productId === "fixture-quasar-shell")!;
    expect(quasar.access).toMatchObject({ state: "licensed", allEditions: false, editionIds: ["standard"], source: "HCG internal grant" });
    expect(r.apps.filter((a) => a.access.state === "owner")).toEqual([]);
    expect(r.apps.filter((a) => a.productId !== "fixture-quasar-shell" && a.access.state === "licensed")).toEqual([]);
  });

  it("revoking HCG's Owner-access policy takes effect on the next request", async () => {
    ledger.setOwnerAccess(FOUNDER.sub, true);
    const web = await h.signIn(FOUNDER);
    expect(((await (await web.get("/api/v1/my-apps")).json()) as Apps).ownerAccess).not.toBeNull();
    ledger.setOwnerAccess(FOUNDER.sub, false);
    const after = (await (await web.get("/api/v1/my-apps")).json()) as Apps;
    expect(after.ownerAccess).toBeNull();
    expect(after.apps.every((a) => a.access.state !== "owner")).toBe(true);
  });
});

describe("HCG /library parsing (Owner-access policy, strict)", () => {
  const base = { api_version: "v1", organisations: [], items: [] as unknown[] };
  const owner = { policy: "owner_all_products", source: "founder_owner_grant", status: "active", granted_at: "2026-11-18T00:00:00Z", revoked_at: null };
  it("recognises only the exact, active Owner-access policy", () => {
    expect(parseLibrary({ ...base, owner_access: owner }, Date.now())).toMatchObject({ status: "ok", ownerAccess: { policy: "owner_all_products", source: "founder_owner_grant" } });
    for (const bad of [
      { ...owner, status: "revoked" },
      { ...owner, revoked_at: "2026-11-18T01:00:00Z" },
      { ...owner, source: "purchase" },
      { ...owner, policy: "owner" },
      true,
      "owner",
      { role: "owner" },
    ]) {
      expect(parseLibrary({ ...base, owner_access: bad }, Date.now())).toMatchObject({ status: "ok", ownerAccess: null });
    }
    expect(parseLibrary({ ...base }, Date.now())).toMatchObject({ ownerAccess: null });
    expect(parseLibrary({ api_version: "v2", items: [] }, Date.now()).status).toBe("unavailable");
  });

  it("reads product and edition licences; skips expired, inactive and unknown scopes", () => {
    const now = Date.parse("2026-11-18T00:00:00Z");
    const v = parseLibrary(
      {
        ...base,
        items: [
          { product_id: "hcg.mail", scope: "product", scope_key: null, license_type: "internal", status: "active", ends_at: null },
          { product_id: "hcg.terminal", scope: "module", scope_key: "edition:unleashed", license_type: "perpetual", status: "active", ends_at: null },
          { product_id: "hcg.news", scope: "product", scope_key: null, license_type: "trial", status: "active", ends_at: "2026-11-01T00:00:00Z" },
          { product_id: "hcg.lifeos", scope: "product", scope_key: null, license_type: "internal", status: "revoked", ends_at: null },
          { product_id: "hcg.cardx", scope: "feature", scope_key: "ai.use", license_type: "internal", status: "active", ends_at: null },
        ],
      },
      now,
    );
    expect(v).toMatchObject({
      status: "ok",
      items: [
        { centralProductId: "hcg.mail", scope: "product", edition: null, licenseType: "internal" },
        { centralProductId: "hcg.terminal", scope: "edition", edition: "unleashed", licenseType: "perpetual" },
      ],
    });
  });
});
