/**
 * The Store's client for HCG's Ecosystem API, against a mock that follows the contract in
 * docs/MAIN-SITE-HANDOFF-REQUEST.md: `/me` and `/check` as DEPLOYED, the edition check as PROPOSED
 * (decision D2), and `/library` as PREVIEW.
 */
import { describe, expect, it } from "vitest";
import { HcgEcosystemAuthority, type CheckTarget } from "../src/entitlements";

const BASE = "https://hcg.test/api/public/ecosystem/v1";
const TOKEN = "access-token-alice";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

type Licence = { org: string; product: string; scopeKey: string | null; status?: string; endsAt?: string | null };

interface MockOpts {
  orgs?: string[];
  licences?: Licence[];
  /** "deployed": /check ignores editions (today). "edition": the proposed D2 edition check. */
  checkMode?: "deployed" | "edition";
  meStatus?: number;
  checkStatus?: (org: string) => number | undefined;
  libraryDeployed?: boolean;
  checkOverride?: (body: Record<string, string>) => unknown;
}

function mockHcg(o: MockOpts = {}) {
  const calls: { path: string; body: Record<string, string> | null; auth: string | null }[] = [];
  const orgs = o.orgs ?? [ORG_A];
  const licences = o.licences ?? [];
  const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/public/ecosystem/v1", "");
    const auth = new Headers(init?.headers).get("authorization");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : null;
    calls.push({ path, body, auth });
    if (auth !== `Bearer ${TOKEN}`) return jsonRes(401, { error: { code: "unauthorized", message: "x" }, api_version: "v1" });
    if (path === "/me") {
      if (o.meStatus && o.meStatus !== 200) return jsonRes(o.meStatus, { error: { code: "lookup_failed", message: "x" }, api_version: "v1" });
      return jsonRes(200, { api_version: "v1", user: { id: "sub-alice", email: "a@x" }, organisations: orgs.map((id) => ({ org_id: id, slug: id, name: "N", kind: "customer", org_role: "owner" })) });
    }
    if (path === "/check") {
      const forced = o.checkStatus?.(body!.org_id ?? "");
      if (forced) return jsonRes(forced, { error: { code: forced === 403 ? "not_org_member" : "evaluation_failed", message: "x" }, api_version: "v1" });
      if (o.checkOverride) return jsonRes(200, o.checkOverride(body!));
      const active = licences.filter((l) => l.org === body!.org_id && l.product === body!.product_id && (l.status ?? "active") === "active");
      const base = { api_version: "v1", org_id: body!.org_id, product_id: body!.product_id, feature_key: body!.feature_key, verified_at: "2026-11-16T12:00:00Z" };
      if ((o.checkMode ?? "deployed") === "deployed") {
        return jsonRes(200, { ...base, allowed: active.length > 0, layer: active.length ? null : "licence", reason: active.length ? null : "not_licensed" });
      }
      const key = body!.edition;
      if (!key) return jsonRes(200, { ...base, allowed: active.some((l) => l.scopeKey === null), layer: null, reason: null });
      const exact = active.some((l) => l.scopeKey === `edition:${key}`);
      const all = active.some((l) => l.scopeKey === "edition:*");
      return jsonRes(200, {
        ...base,
        edition: key,
        edition_scope: exact ? "edition" : all ? "all-editions" : "edition",
        allowed: exact || all,
        layer: exact || all ? null : "licence",
        reason: exact || all ? null : "not_licensed",
      });
    }
    if (path === "/library") {
      if (!o.libraryDeployed) return new Response("<!doctype html><title>Not found</title>", { status: 404, headers: { "content-type": "text/html" } });
      return jsonRes(200, {
        api_version: "v1",
        organisations: orgs.map((id) => ({ org_id: id, name: "N", kind: "customer", org_role: "owner" })),
        items: licences.map((l) => ({
          org_id: l.org,
          product_id: l.product,
          product_name: l.product,
          scope: l.scopeKey ? "module" : "product",
          scope_key: l.scopeKey,
          license_type: "perpetual",
          status: l.status ?? "active",
          starts_at: "2026-11-01T00:00:00Z",
          ends_at: l.endsAt ?? null,
        })),
        revalidate_after_seconds: 300,
      });
    }
    return new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const alice = { sub: "sub-alice", accessToken: TOKEN };
const unleashed: CheckTarget = { centralProductId: "hcg.terminal", editionId: "unleashed", centralEditionKey: "unleashed" };
const standard: CheckTarget = { centralProductId: "hcg.terminal", editionId: "standard", centralEditionKey: "standard" };
const lifeos: CheckTarget = { centralProductId: "hcg.lifeos", editionId: null, centralEditionKey: null };
const now = () => Date.parse("2026-11-16T12:00:00Z");

describe("HCG Ecosystem API client", () => {
  it("sends the deployed request shape: bearer token, org_id, product_id, feature_key download", async () => {
    const m = mockHcg({ licences: [{ org: ORG_A, product: "hcg.lifeos", scopeKey: null }] });
    const a = new HcgEcosystemAuthority(BASE, m.fetchImpl, now);
    expect(await a.check(alice, lifeos)).toEqual({ status: "granted", expiresAt: null });
    expect(m.calls.map((c) => c.path)).toEqual(["/me", "/check"]);
    expect(m.calls[1]!.body).toEqual({ org_id: ORG_A, product_id: "hcg.lifeos", feature_key: "download" });
    expect(m.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("D2: never grants an edition on the deployed route, which does not evaluate editions", async () => {
    // A product-wide licence exists and the deployed route says allowed:true — that is NOT an edition grant.
    const m = mockHcg({ licences: [{ org: ORG_A, product: "hcg.terminal", scopeKey: null }] });
    const a = new HcgEcosystemAuthority(BASE, m.fetchImpl, now);
    const r = await a.check(alice, unleashed);
    expect(r.status).toBe("unavailable");
    expect(m.calls[1]!.body).toEqual({ org_id: ORG_A, product_id: "hcg.terminal", feature_key: "download", edition: "unleashed" });
  });

  it("D2: grants an edition only on an explicit edition answer, and never via another edition", async () => {
    const m = mockHcg({ checkMode: "edition", licences: [{ org: ORG_A, product: "hcg.terminal", scopeKey: "edition:standard" }] });
    const a = new HcgEcosystemAuthority(BASE, m.fetchImpl, now);
    expect((await a.check(alice, standard)).status).toBe("granted");
    expect((await a.check(alice, unleashed)).status).toBe("not-granted");
  });

  it("D2: a product-wide licence does not satisfy an edition check; the explicit all-editions licence does", async () => {
    const productWide = mockHcg({ checkMode: "edition", licences: [{ org: ORG_A, product: "hcg.terminal", scopeKey: null }] });
    expect((await new HcgEcosystemAuthority(BASE, productWide.fetchImpl, now).check(alice, unleashed)).status).toBe("not-granted");
    const all = mockHcg({ checkMode: "edition", licences: [{ org: ORG_A, product: "hcg.terminal", scopeKey: "edition:*" }] });
    expect((await new HcgEcosystemAuthority(BASE, all.fetchImpl, now).check(alice, unleashed)).status).toBe("granted");
  });

  it("D2: an answer for a different edition than the one asked is not trusted", async () => {
    const m = mockHcg({
      checkOverride: (b) => ({ api_version: "v1", org_id: b.org_id, product_id: b.product_id, feature_key: b.feature_key, allowed: true, edition: "standard", edition_scope: "edition" }),
    });
    expect((await new HcgEcosystemAuthority(BASE, m.fetchImpl, now).check(alice, unleashed)).status).toBe("unavailable");
  });

  it("D2: an edition with no central key is never checked, and makes no request", async () => {
    const m = mockHcg();
    const r = await new HcgEcosystemAuthority(BASE, m.fetchImpl, now).check(alice, { centralProductId: "hcg.terminal", editionId: "unleashed", centralEditionKey: null });
    expect(r.status).toBe("unavailable");
    expect(m.calls).toHaveLength(0);
  });

  it("a person in no organisation holds no licence (handoff critical finding)", async () => {
    const m = mockHcg({ orgs: [], licences: [] });
    expect((await new HcgEcosystemAuthority(BASE, m.fetchImpl, now).check(alice, lifeos)).status).toBe("not-granted");
  });

  it("checks every organisation: a refusal in one does not hide a licence held by another", async () => {
    const m = mockHcg({ orgs: [ORG_A, ORG_B], checkStatus: (org) => (org === ORG_A ? 403 : undefined), licences: [{ org: ORG_B, product: "hcg.lifeos", scopeKey: null }] });
    expect((await new HcgEcosystemAuthority(BASE, m.fetchImpl, now).check(alice, lifeos)).status).toBe("granted");
  });

  it("a revoked or expired licence is refused (HCG answers allowed:false)", async () => {
    const m = mockHcg({ licences: [{ org: ORG_A, product: "hcg.lifeos", scopeKey: null, status: "revoked" }] });
    expect((await new HcgEcosystemAuthority(BASE, m.fetchImpl, now).check(alice, lifeos)).status).toBe("not-granted");
  });

  it("anything unexpected is 'unavailable', never a grant", async () => {
    const cases: MockOpts[] = [
      { meStatus: 503 },
      { checkStatus: () => 503 },
      { checkStatus: () => 429 },
      { checkOverride: (b) => ({ api_version: "v1", org_id: "someone-else", product_id: b.product_id, feature_key: b.feature_key, allowed: true }) },
      { checkOverride: (b) => ({ api_version: "v2", org_id: b.org_id, product_id: b.product_id, feature_key: b.feature_key, allowed: true }) },
      { checkOverride: (b) => ({ api_version: "v1", org_id: b.org_id, product_id: b.product_id, feature_key: b.feature_key, allowed: "yes" }) },
    ];
    for (const c of cases) {
      const m = mockHcg({ ...c, licences: [{ org: ORG_A, product: "hcg.lifeos", scopeKey: null }] });
      expect((await new HcgEcosystemAuthority(BASE, m.fetchImpl, now).check(alice, lifeos)).status, JSON.stringify(c)).toBe("unavailable");
    }
    // A dead session (401) and a missing token are also never a grant.
    const m = mockHcg();
    expect((await new HcgEcosystemAuthority(BASE, m.fetchImpl, now).check({ sub: "x", accessToken: "stale" }, lifeos)).status).toBe("unavailable");
    expect((await new HcgEcosystemAuthority(BASE, m.fetchImpl, now).check({ sub: "x", accessToken: null }, lifeos)).status).toBe("unavailable");
  });

  it("network failure is 'unavailable'", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect((await new HcgEcosystemAuthority(BASE, failing, now).check(alice, lifeos)).status).toBe("unavailable");
  });

  it("/library (preview) is display only: active, unexpired edition licences; unpublished route is 'unavailable'", async () => {
    const off = mockHcg();
    expect((await new HcgEcosystemAuthority(BASE, off.fetchImpl, now).list(alice)).status).toBe("unavailable");
    const m = mockHcg({
      libraryDeployed: true,
      licences: [
        { org: ORG_A, product: "hcg.terminal", scopeKey: "edition:unleashed" },
        { org: ORG_A, product: "hcg.terminal", scopeKey: "edition:standard", status: "revoked" },
        { org: ORG_A, product: "hcg.mail", scopeKey: "edition:ios", endsAt: "2026-11-01T00:00:00Z" },
        { org: ORG_A, product: "hcg.lifeos", scopeKey: null },
        { org: ORG_A, product: "hcg.news", scopeKey: "edition:*", endsAt: "2027-01-01T00:00:00Z" },
      ],
    });
    const r = await new HcgEcosystemAuthority(BASE, m.fetchImpl, now).list(alice);
    expect(r).toEqual({
      status: "ok",
      items: [
        { centralProductId: "hcg.terminal", edition: "unleashed", expiresAt: null },
        { centralProductId: "hcg.news", edition: "*", expiresAt: Date.parse("2027-01-01T00:00:00Z") },
      ],
    });
  });
});
