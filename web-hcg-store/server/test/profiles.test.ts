// @vitest-environment node
/**
 * Store profiles (server/src/profiles.ts): a display name and designation for an existing, verified HCG account.
 * Presentation only. These tests prove a profile, a name, an e-mail or browser data never grants anything, that only
 * the server-side operator path writes it, and that permission changes still come from HCG.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { featureEdition, type TestLedgerAuthority } from "../src/entitlements";
import { getProfile, ProfileError, setProfile, subjectOfVerifiedSession } from "../src/profiles";
import { startHarness, type Harness } from "./harness";

const MAKER_CLIENT = "99999999-8888-4777-8666-555555555555";
const ME_URL = "https://hcg.test/api/public/ecosystem/v1";
const FOUNDER = { sub: "user-founder-0001", email: "founder@example.test", name: "Founder" };
const ORDINARY = { sub: "user-ordinary-0002", email: "ordinary@example.test", name: "Founder" };
const RELEASE = { productId: "fixture-quasar-shell", editionId: "standard", version: "4.0.0", build: "1", releaseNotes: [], compatibility: { minimumOs: {}, architectures: [], notes: [] }, distribution: "paid", eligibility: "private" };

/** HCG's /me, answering for the token's own subject (as deployed). */
const mockMe = (async (_i: string | URL | Request, init?: RequestInit) => {
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  const { sub } = JSON.parse(Buffer.from(auth.replace("Bearer ", "").split(".")[1] ?? "", "base64url").toString("utf8")) as { sub: string };
  return new Response(JSON.stringify({ api_version: "v1", user: { id: sub, email: "x@x" }, organisations: [] }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

let h: Harness;
let ledger: TestLedgerAuthority;
beforeEach(async () => {
  h = await startHarness({
    env: {
      HCG_ECOSYSTEM_API_URL: ME_URL,
      HCG_STORE_PUBLISHING: "enabled",
      HCG_STORE_PUBLISHING_CLIENT_IDS: MAKER_CLIENT,
      HCG_STORE_PUBLISHER_CENTRAL_ID: "store.publish",
      HCG_STORE_RELEASE_APPROVER_CENTRAL_ID: "store.release.approve",
      HCG_STORE_RELEASE_PUBLICATION_CENTRAL_ID: "store.release.publish",
    },
    ecosystemFetch: mockMe,
  });
  h.idp.otherClients.add(MAKER_CLIENT);
  ledger = h.authority as TestLedgerAuthority;
});
afterEach(async () => h.stop());

const sessionRef = (sub: string) =>
  (h.db.prepare("SELECT substr(id_hash, 1, 12) AS ref FROM sessions WHERE sub = ? ORDER BY created_at DESC LIMIT 1").get(sub) as { ref: string }).ref;
const desktop = async (user: typeof FOUNDER) => {
  const token = await h.idp.accessToken(user, MAKER_CLIENT);
  return (method: string, path: string, body?: unknown) =>
    fetch(h.origin + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
};
const set = (sub: string, displayName: string | null, designation: string | null) =>
  setProfile(h.db, { sub, displayName, designation, authorisedBy: "founder (test)", performedBy: "operator (test)", now: Date.now() });

describe("Store profiles", () => {
  it("are keyed to a sign-in the Store verified and matched with HCG's /me, shown on the session, and idempotent", async () => {
    const web = await h.signIn(FOUNDER);
    const sub = subjectOfVerifiedSession(h.db, sessionRef(FOUNDER.sub));
    expect(sub).toBe(FOUNDER.sub);
    expect(set(sub, "Founder Display Name (test)", "Founder / Original User").changed).toBe(true);
    expect(set(sub, "Founder Display Name (test)", "Founder / Original User").changed).toBe(false); // idempotent
    const events = h.db.prepare("SELECT action, authorised_by, performed_by FROM store_profile_events WHERE sub = ?").all(sub);
    expect(events).toEqual([{ action: "profile.set", authorised_by: "founder (test)", performed_by: "operator (test)" }]);
    const s = (await (await web.get("/api/v1/session")).json()) as { profile: unknown; user: { email: string } };
    expect(s.profile).toEqual({ displayName: "Founder Display Name (test)", designation: "Founder / Original User" });
    expect(s.user.email).toBe(FOUNDER.email); // the HCG identity itself is unchanged
    // The audit of profile changes cannot be rewritten.
    expect(() => h.db.exec("UPDATE store_profile_events SET authorised_by = 'someone else'")).toThrow(/append-only/);
    expect(() => h.db.exec("DELETE FROM store_profile_events")).toThrow(/append-only/);
  });

  it("refuse unverified or unknown sign-ins, references that are not exact, and unsafe text", async () => {
    await h.signIn(FOUNDER);
    h.db.prepare("UPDATE sessions SET account_confirmed_at = NULL").run(); // as if HCG's /me had been unreachable
    expect(() => subjectOfVerifiedSession(h.db, sessionRef(FOUNDER.sub))).toThrow(ProfileError);
    expect(() => subjectOfVerifiedSession(h.db, "not-a-ref")).toThrow(ProfileError);
    expect(() => subjectOfVerifiedSession(h.db, "000000000000")).toThrow(ProfileError);
    expect(() => set(FOUNDER.sub, "x‮evil", null)).toThrow(ProfileError);
    expect(() => setProfile(h.db, { sub: FOUNDER.sub, displayName: "x", designation: null, authorisedBy: "", performedBy: "op", now: 1 })).toThrow(/authorised/);
  });

  it("grant nothing: a founder profile, a founder name or e-mail, and browser data never permit publishing or approval", async () => {
    // An ordinary account whose HCG name is also "Founder", with the founder's display name and designation.
    await h.signIn(ORDINARY);
    set(ORDINARY.sub, "Founder Display Name (test)", "Founder / Original User");
    const call = await desktop(ORDINARY);
    expect((await call("POST", "/api/v1/publishing/releases", RELEASE)).status).toBe(403);
    // Browser-supplied data: extra JSON fields are refused, and headers are not read.
    const web = await h.signIn(ORDINARY);
    const forged = await fetch(h.origin + "/api/v1/publishing/releases", {
      method: "POST",
      headers: { cookie: web.cookieHeader(), origin: h.origin, "content-type": "application/json", "x-hcg-role": "owner", "x-store-designation": "Founder" },
      body: JSON.stringify({ ...RELEASE, role: "owner", designation: "Founder / Original User" }),
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect((await call("POST", "/api/v1/publishing/releases", RELEASE)).status).toBe(403);
    // There is no HTTP route that writes a profile or a permission.
    for (const path of ["/api/v1/profile", "/api/v1/profiles", "/api/v1/admin/grants", "/api/v1/owner", "/api/v1/session"]) {
      const r = await fetch(h.origin + path, { method: "POST", headers: { cookie: web.cookieHeader(), origin: h.origin, "content-type": "application/json" }, body: "{}" });
      expect([401, 403, 404, 405]).toContain(r.status);
    }
    expect(getProfile(h.db, ORDINARY.sub)?.designation).toBe("Founder / Original User"); // unchanged, and still powerless
  });

  it("permissions come only from HCG's grants on hcg.store, and revoking them takes effect on the next request", async () => {
    await h.signIn(FOUNDER);
    set(FOUNDER.sub, "Founder Display Name (test)", "Founder / Original User");
    const call = await desktop(FOUNDER);
    expect((await call("POST", "/api/v1/publishing/releases", RELEASE)).status).toBe(403); // profile alone: nothing
    ledger.grant(FOUNDER.sub, "hcg.store", featureEdition("store.publish"), "hcg-erp", null); // HCG's personal grant
    expect((await call("POST", "/api/v1/publishing/releases", RELEASE)).status).toBe(201);
    ledger.revokeAll(FOUNDER.sub); // HCG revokes
    expect((await call("POST", "/api/v1/publishing/releases", { ...RELEASE, build: "2" })).status).toBe(403);
  });
});
