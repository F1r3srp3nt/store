// @vitest-environment node
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, parseStoreConfig } from "../src/config";
import { buildRegistry, loadRegistry, RegistryError, type Offer } from "../src/registry";
import { validateCatalogue } from "../../src/domain/catalogue";
import { readFileSync } from "node:fs";
import { FIXTURE_CATALOGUE, ROOT, TEST_OFFERS } from "./harness";

const KEY = Buffer.alloc(32, 7).toString("base64");
const prod = (env: Record<string, string>) => () => parseStoreConfig({ HCG_STORE_PUBLIC_ORIGIN: "https://store.example.test", HCG_STORE_SECRET_KEY: KEY, ...env });

describe("server configuration refuses unsafe launches", () => {
  it("starts closed by default: no sign-in, no payments, no protected downloads", () => {
    const cfg = prod({})();
    expect(cfg).toMatchObject({ mode: "production", hcgConnect: null, paymentProvider: "none", entitlementAuthority: "none", protectedDownloads: false });
  });

  it("refuses the test payment provider, test ledger and unknown providers in production", () => {
    expect(prod({ HCG_STORE_PAYMENT_PROVIDER: "test" })).toThrow(/test mode/);
    expect(prod({ HCG_STORE_PAYMENT_PROVIDER: "stripe" })).toThrow(/No live payment provider/);
    expect(prod({ HCG_STORE_ENTITLEMENT_AUTHORITY: "test-ledger" })).toThrow(/test mode/);
  });

  it("refuses protected downloads without sign-in, an authority, private storage and founder approval", () => {
    const err = (() => {
      try {
        prod({ HCG_STORE_PROTECTED_DOWNLOADS: "enabled" })();
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.problems.join("\n")).toMatch(/HCG Connect/);
    expect(err!.problems.join("\n")).toMatch(/entitlement authority/);
    expect(err!.problems.join("\n")).toMatch(/founder-approved/);
    expect(err!.problems.join("\n")).toMatch(/private directory/);
  });

  it("requires a secret key and an https origin in production, and complete HCG Connect settings", () => {
    expect(() => parseStoreConfig({ HCG_STORE_PUBLIC_ORIGIN: "https://store.example.test" })).toThrow(/SECRET_KEY/);
    expect(prod({ HCG_STORE_PUBLIC_ORIGIN: "http://store.example.test" })).toThrow(/https/);
    expect(prod({ HCG_CONNECT_CLIENT_ID: "x" })).toThrow(/partly configured/);
    expect(
      prod({
        HCG_CONNECT_ISSUER: "https://id.example.test/auth/v1",
        HCG_CONNECT_AUTHORIZATION_ENDPOINT: "https://id.example.test/auth/v1/oauth/authorize",
        HCG_CONNECT_TOKEN_ENDPOINT: "https://id.example.test/auth/v1/oauth/token",
        HCG_CONNECT_JWKS_URI: "https://id.example.test/auth/v1/.well-known/jwks.json",
        HCG_CONNECT_CLIENT_ID: "client",
        HCG_CONNECT_REDIRECT_URI: "https://elsewhere.example.test/auth/callback",
      }),
    ).toThrow(/must be on HCG_STORE_PUBLIC_ORIGIN/);
  });
});

describe("offers and protected artifacts", () => {
  const fixture = () => {
    const r = validateCatalogue(
      JSON.parse(readFileSync(join(FIXTURE_CATALOGUE, "products.json"), "utf8")),
      JSON.parse(readFileSync(join(FIXTURE_CATALOGUE, "releases.json"), "utf8")),
    );
    if (!r.ok) throw new Error(r.errors.join("\n"));
    return r.catalogue;
  };
  const base = TEST_OFFERS.offers[0] as Offer;

  it("ships with no offers and no protected artifacts for the real catalogue", () => {
    const reg = loadRegistry({
      catalogueDir: join(ROOT, "catalogue"),
      offersFile: join(ROOT, "server/data/offers.json"),
      artifactsFile: join(ROOT, "server/data/artifacts.json"),
      testMode: false,
    });
    expect(reg.offers).toEqual([]);
    expect(reg.artifacts).toEqual([]);
  });

  it("ignores test-only offers outside test mode", () => {
    const reg = buildRegistry(fixture(), [base], [], false);
    expect(reg.offers).toEqual([]);
    expect(reg.warnings.join()).toMatch(/test-only/);
  });

  it("refuses to sell an unreleased product (no preorder policy)", () => {
    const unreleased: Offer = { ...base, id: "nebula", productId: "fixture-nebula-pad", centralProductId: "fixture.nebula", editionId: null, grants: [{ edition: "default" }] };
    expect(() => buildRegistry(fixture(), [unreleased], [], true)).toThrow(RegistryError);
  });

  it("refuses offers whose central product ID is not the product's confirmed ID, or that grant unknown editions", () => {
    expect(() => buildRegistry(fixture(), [{ ...base, centralProductId: "something.else" }], [], true)).toThrow(/confirmed central ID/);
    expect(() => buildRegistry(fixture(), [{ ...base, grants: [{ edition: "pro" }] }], [], true)).toThrow(/unknown edition/);
  });
});

describe("database backups", () => {
  it("writes complete, private copies and keeps the newest N", async () => {
    const { mkdtempSync, readdirSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const { openDatabase } = await import("../src/db");
    const { backupDatabase } = await import("../src/backup");
    const dir = mkdtempSync(join(tmpdir(), "hcg-backup-"));
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO auth_events (at, type) VALUES (1, 'server_started')").run();
    let t = Date.parse("2026-11-16T00:00:00Z");
    for (let i = 0; i < 4; i++) backupDatabase(db, join(dir, "b"), 3, (t += 86_400_000));
    const files = readdirSync(join(dir, "b")).sort();
    expect(files).toEqual(["hcg-store-20261118T000000Z.sqlite", "hcg-store-20261119T000000Z.sqlite", "hcg-store-20261120T000000Z.sqlite"]);
    expect(statSync(join(dir, "b", files[2]!)).mode & 0o777).toBe(0o600);
    const copy = new DatabaseSync(join(dir, "b", files[2]!), { readOnly: true });
    expect(copy.prepare("SELECT type FROM auth_events").all()).toEqual([{ type: "server_started" }]);
    copy.close();
  });
});
