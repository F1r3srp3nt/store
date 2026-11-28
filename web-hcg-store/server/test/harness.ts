/** TEST ONLY. Starts a Store server against the mock HCG Connect provider and the fixture catalogue. */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createStoreApp, type StoreApp } from "../src/app";
import { parseStoreConfig, type StoreConfig } from "../src/config";
import { openDatabase } from "../src/db";
import { HcgEcosystemAuthority, NoAuthority, TestLedgerAuthority, type EntitlementAuthority } from "../src/entitlements";
import { CentralGrantOutbox } from "../src/grants";
import type { Db } from "../src/db";
import { HcgConnectClient } from "../src/hcg-connect";
import { loadRegistry } from "../src/registry";
import { MockHcgConnect, type MockUser } from "./mock-hcg-connect";

export const ROOT = resolve(import.meta.dirname, "../..");
export const FIXTURE_CATALOGUE = join(ROOT, "tests/fixtures/catalogue-demo");

export const FILES = {
  "quasar/unleashed-1.0.0-arm64.deb": Buffer.from("FIXTURE DEB: com.example.fixture.quasar.unleashed 1.0.0 iphoneos-arm64\n"),
  "quasar/standard-1.0.0.ipa": Buffer.from("FIXTURE IPA: Fixture Quasar Shell standard 1.0.0\n"),
};
export const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export class Clock {
  t = Date.parse("2026-11-15T12:00:00Z");
  now = () => this.t;
  advance(seconds: number) {
    this.t += seconds * 1000;
  }
}

export interface Harness {
  app: StoreApp;
  outbox: CentralGrantOutbox;
  db: Db;
  cfg: StoreConfig;
  idp: MockHcgConnect;
  clock: Clock;
  origin: string;
  authority: EntitlementAuthority;
  stop: () => Promise<void>;
  /** Signs in through the full browser redirect flow; returns a client holding the session cookie. */
  signIn: (user: MockUser) => Promise<Client>;
  anonymous: () => Client;
}

export class Client {
  cookies = new Map<string, string>();
  csrf: string | undefined;
  csrfFor = "";
  constructor(public readonly origin: string) {}
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const k = pair!.slice(0, i);
      const v = pair!.slice(i + 1);
      if (v === "" || /Max-Age=0/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
  async request(path: string, init: RequestInit & { json?: unknown; sameOrigin?: boolean; csrf?: boolean } = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", this.cookieHeader());
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    if (init.sameOrigin !== false && init.method && init.method !== "GET") headers.set("origin", this.origin);
    // Like the Store's own pages: management changes carry the session's CSRF token (from /api/v1/publishing/me).
    const p = path.startsWith("http") ? new URL(path).pathname : path;
    if (init.sameOrigin !== false && init.method && init.method !== "GET" && p.startsWith("/api/v1/publishing") && this.cookies.size && !headers.has("x-hcg-csrf") && (init as { csrf?: boolean }).csrf !== false) {
      if (this.csrf === undefined || this.csrfFor !== this.cookieHeader()) {
        const me = await fetch(this.origin + "/api/v1/publishing/me", { headers: { cookie: this.cookieHeader() } });
        this.csrf = me.ok ? ((await me.json()) as { csrfToken?: string }).csrfToken ?? "" : "";
        this.csrfFor = this.cookieHeader();
      }
      if (this.csrf) headers.set("x-hcg-csrf", this.csrf);
    }
    const res = await fetch(path.startsWith("http") ? path : this.origin + path, { ...init, headers, body, redirect: "manual" });
    this.absorb(res);
    return res;
  }
  get(path: string, init: RequestInit = {}) {
    return this.request(path, init);
  }
  post(path: string, json?: unknown, init: RequestInit & { sameOrigin?: boolean; csrf?: boolean } = {}) {
    return this.request(path, { ...init, method: "POST", json: json ?? {} });
  }
}

export interface HarnessOptions {
  env?: Record<string, string>;
  authority?: "test-ledger" | "none" | "hcg-ecosystem";
  ecosystemFetch?: typeof fetch;
  /** fetch used by the central grant outbox (D5); set HCG_STORE_GRANT_API_URL/CREDENTIAL in env to enable it. */
  grantFetch?: typeof fetch;
  withStaticDir?: string;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const idp = await new MockHcgConnect().start();
  const clock = new Clock();
  idp.now = clock.now;

  const storage = mkdtempSync(join(tmpdir(), "hcg-store-private-"));
  for (const [k, v] of Object.entries(FILES)) {
    mkdirSync(join(storage, k, ".."), { recursive: true });
    writeFileSync(join(storage, k), v);
  }
  const fixtures = mkdtempSync(join(tmpdir(), "hcg-store-registry-"));
  writeFileSync(join(fixtures, "offers.json"), JSON.stringify(TEST_OFFERS));
  writeFileSync(join(fixtures, "artifacts.json"), JSON.stringify(testArtifacts()));

  const server: Server = createServer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  const origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  const authorityKind = opts.authority ?? "test-ledger";
  const cfg = parseStoreConfig({
    HCG_STORE_MODE: "test",
    HCG_STORE_PUBLIC_ORIGIN: origin,
    HCG_STORE_REPO_ORIGINS: "http://127.0.0.1:9",
    HCG_CONNECT_ISSUER: idp.issuer,
    HCG_CONNECT_AUTHORIZATION_ENDPOINT: `${idp.issuer}/oauth/authorize`,
    HCG_CONNECT_TOKEN_ENDPOINT: `${idp.issuer}/oauth/token`,
    HCG_CONNECT_JWKS_URI: `${idp.issuer}/.well-known/jwks.json`,
    HCG_CONNECT_CLIENT_ID: idp.clientId,
    HCG_CONNECT_REDIRECT_URI: `${origin}/auth/callback`,
    HCG_STORE_ENTITLEMENT_AUTHORITY: authorityKind,
    ...(authorityKind === "hcg-ecosystem" ? { HCG_ECOSYSTEM_API_URL: "http://127.0.0.1:9/api/public/ecosystem/v1" } : {}),
    HCG_STORE_PAYMENT_PROVIDER: "test",
    HCG_STORE_PROTECTED_DOWNLOADS: "enabled",
    HCG_STORE_ARTIFACT_STORAGE_DIR: storage,
    HCG_STORE_STATIC_DIR: opts.withStaticDir ?? "",
    HCG_CATALOGUE_DIR: FIXTURE_CATALOGUE,
    HCG_STORE_OFFERS_FILE: join(fixtures, "offers.json"),
    HCG_STORE_ARTIFACTS_FILE: join(fixtures, "artifacts.json"),
    HCG_STORE_DATA_DIR: ":memory:",
    HCG_STORE_SILEO_PUBLIC_APPROVED: "founder-approved",
    ...opts.env,
  });
  const registry = loadRegistry({ catalogueDir: cfg.catalogueDir, offersFile: cfg.offersFile, artifactsFile: cfg.artifactsFile, testMode: true });
  const db = openDatabase(cfg.dataDir);
  const connect = new HcgConnectClient(cfg.hcgConnect!, fetch, clock.now);
  const authority =
    authorityKind === "test-ledger"
      ? new TestLedgerAuthority(db, clock.now)
      : authorityKind === "hcg-ecosystem"
        ? new HcgEcosystemAuthority(cfg.ecosystem!.baseUrl, opts.ecosystemFetch)
        : new NoAuthority();
  const outbox = new CentralGrantOutbox(db, clock.now, cfg.grants, opts.grantFetch);
  const app = createStoreApp({ cfg, db, registry, connect, authority, now: clock.now, outbox, ecosystemFetch: opts.ecosystemFetch });
  server.on("request", (req, res) => void app.handle(req, res));

  const anonymous = () => new Client(origin);
  async function signIn(user: MockUser) {
    const c = anonymous();
    idp.nextUser = user;
    const start = await c.get("/auth/login?return_to=/library");
    if (start.status !== 302) throw new Error(`login start ${start.status}`);
    const authz = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const cb = authz.headers.get("location")!;
    const done = await c.get(cb.replace(origin, ""));
    if (done.status !== 302 || done.headers.get("location") !== "/library") throw new Error(`callback ${done.status} ${await done.text()}`);
    return c;
  }

  return {
    app,
    outbox,
    db,
    cfg,
    idp,
    clock,
    origin,
    authority,
    signIn,
    anonymous,
    stop: async () => {
      await new Promise<void>((ok) => server.close(() => ok()));
      await idp.stop();
      db.close();
    },
  };
}

export const TEST_OFFERS = {
  offers: [
    {
      id: "fixture-quasar-unleashed-test",
      productId: "fixture-quasar-shell",
      centralProductId: "fixture.quasar.shell",
      editionId: "unleashed",
      title: "Fixture Quasar Shell Unleashed (TEST)",
      kind: "one-time",
      interval: null,
      currency: "EUR",
      unitAmount: 999,
      grants: [{ edition: "unleashed" }],
      status: "approved-for-sale",
      testOnly: true,
    },
    {
      id: "fixture-quasar-standard-monthly-test",
      productId: "fixture-quasar-shell",
      centralProductId: "fixture.quasar.shell",
      editionId: "standard",
      title: "Fixture Quasar Shell monthly (TEST)",
      kind: "subscription",
      interval: "month",
      currency: "EUR",
      unitAmount: 299,
      grants: [{ edition: "standard" }],
      status: "approved-for-sale",
      testOnly: true,
    },
  ],
};

export function testArtifacts() {
  return {
    artifacts: [
      {
        id: "fixture-quasar-unleashed-1-0-0-arm64",
        productId: "fixture-quasar-shell",
        releaseId: "fixture-quasar-shell-1-0-0",
        catalogueArtifactId: "unleashed-rootless",
        editionId: "unleashed",
        fileName: "com.example.fixture.quasar.unleashed_1.0.0_iphoneos-arm64.deb",
        contentType: "application/vnd.debian.binary-package",
        sha256: sha(FILES["quasar/unleashed-1.0.0-arm64.deb"]),
        storageKey: "quasar/unleashed-1.0.0-arm64.deb",
        deliveryApproved: true,
        testOnly: true,
      },
      {
        id: "fixture-quasar-standard-1-0-0",
        productId: "fixture-quasar-shell",
        releaseId: "fixture-quasar-shell-1-0-0",
        catalogueArtifactId: "standard-ipa",
        editionId: "standard",
        fileName: "FixtureQuasarShell-1.0.0.ipa",
        contentType: "application/octet-stream",
        sha256: sha(FILES["quasar/standard-1.0.0.ipa"]),
        storageKey: "quasar/standard-1.0.0.ipa",
        deliveryApproved: true,
        testOnly: true,
      },
    ],
  };
}

export const FIXTURE_PACKAGE = "com.example.fixture.quasar.unleashed";
export const FIXTURE_REPO = "https://repo.hakmicapitalgroup.com/repo/";

/**
 * TEST set-up standing in for the Payment Provider Studio: the provider profile (availability, TEST payments, HCG
 * Repo associated) and the fixture package's distribution channel, recorded as an operator would.
 */
export function enableSileoProvider(h: Harness, opts: { availability?: "disabled" | "internal" | "public"; paymentMode?: "off" | "test"; access?: "paid" | "account"; updatePolicy?: "all-updates" | "same-major" } = {}) {
  const c = h.app.commerce;
  const cur = c.profile();
  c.updateProfile("test-operator", { ...cur.value, availability: opts.availability ?? "public", paymentMode: opts.paymentMode ?? "test", repositories: [FIXTURE_REPO] }, cur.revision);
  const ch = c.channel(FIXTURE_PACKAGE);
  c.upsertChannel("test-operator", FIXTURE_PACKAGE, {
    productId: "fixture-quasar-shell", editionId: "unleashed", status: "active", access: opts.access ?? "paid", architectures: ["iphoneos-arm64"],
    minIos: "15.0", maxIos: null, updatePolicy: opts.updatePolicy ?? "all-updates", repository: FIXTURE_REPO, ...(ch ? { revision: ch.revision } : {}),
  });
}

/** Completes a TEST checkout through the simulated provider page. */
export async function buy(c: Client, offerId: string, outcome: "pay" | "fail" | "pending" = "pay") {
  const start = await c.post("/api/v1/checkout", { offerId });
  if (start.status !== 201) return { start, checkoutId: null as string | null };
  const { checkoutId, redirectUrl } = (await start.json()) as { checkoutId: string; redirectUrl: string };
  const page = await c.get(redirectUrl);
  if (page.status !== 200) throw new Error(`checkout page ${page.status}`);
  const form = await c.request(redirectUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `outcome=${outcome}`,
  });
  return { start, checkoutId, returnLocation: form.headers.get("location") };
}
