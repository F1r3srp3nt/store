/**
 * Operator diagnosis (read-only towards HCG): why does a signed-in person get, or not get, HCG Store's publishing
 * permissions? Replays exactly the central checks the Store makes (HCG's /me, then POST /check per organisation for
 * each configured hcg.store feature) with that person's own stored session token, and prints the answers SANITISED:
 * no account ID, organisation ID, e-mail address or token. Organisations are shown by position and a short hash.
 *
 *   node server-dist/permission-diagnosis.mjs --session-ref <12 hex>
 *
 * It changes no grant and no setting. Like any protected Store action, it renews the session with HCG Connect when
 * its access token has expired (the same code path the server uses), which is recorded in the sign-in evidence.
 */
import { createHash } from "node:crypto";
import { parseStoreConfig } from "./config";
import { openDatabase } from "./db";
import { STORE_CENTRAL_PRODUCT_ID } from "./publishing";
import { HcgConnectClient } from "./hcg-connect";
import { SessionStore } from "./sessions";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const short = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 8);
/** Keeps only short, non-identifying fields of an HCG answer (codes and reasons, never IDs or e-mail addresses). */
function sanitize(v: unknown, depth = 0): unknown {
  if (depth > 3) return "…";
  if (Array.isArray(v)) return v.slice(0, 10).map((x) => sanitize(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (/(^|_)(id|uuid|sub|email|user_id|org_id|token)$/i.test(k) || /email|token/i.test(k)) out[k] = typeof x === "string" ? `<${k}:${short(x)}>` : `<${k}>`;
      else out[k] = sanitize(x, depth + 1);
    }
    return out;
  }
  if (typeof v === "string") {
    if (/@/.test(v)) return "<redacted>";
    // Never let an ID inside a message through.
    return v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => `<uuid:${short(m)}>`).slice(0, 200);
  }
  return v;
}

async function main() {
  const cfg = parseStoreConfig(process.env);
  if (!cfg.hcgConnect || !cfg.ecosystem) throw new Error("HCG Connect and the HCG ecosystem API must be configured.");
  const ref = arg("--session-ref") ?? "";
  if (!/^[0-9a-f]{12}$/.test(ref)) throw new Error("--session-ref is the 12-hex session reference from the sign-in evidence.");
  const db = openDatabase(cfg.dataDir);
  try {
    const rows = db.prepare("SELECT id_hash, account_confirmed_at FROM sessions WHERE substr(id_hash, 1, 12) = ? AND ended_at IS NULL").all(ref) as { id_hash: string; account_confirmed_at: number | null }[];
    if (rows.length !== 1) throw new Error("No single active session has that reference.");
    const sessions = new SessionStore(db, cfg, new HcgConnectClient(cfg.hcgConnect), Date.now);
    const s0 = sessions.byHash(rows[0]!.id_hash);
    if (!s0) throw new Error("Session not readable.");
    const fresh = await sessions.ensureFresh(s0);
    if (fresh.status !== "ok") throw new Error(`The session could not be renewed with HCG Connect (${fresh.status}).`);
    const s = fresh.session;
    const token = s.accessToken ?? "";
    const claims = (() => {
      try {
        const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
        return { iss: p.iss, aud: p.aud, client_id: p.client_id, scope: p.scope, role: p.role, aal: p.aal, amr: Array.isArray(p.amr) ? p.amr.map((m: { method?: unknown }) => m?.method) : undefined, expiresInSeconds: typeof p.exp === "number" ? Math.round(p.exp - Date.now() / 1000) : null };
      } catch {
        return { unreadable: true };
      }
    })();
    const base = cfg.ecosystem.baseUrl;
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      const type = res.headers.get("content-type") ?? "";
      return { status: res.status, json: type.includes("application/json") ? ((await res.json()) as unknown) : null, type: type.split(";")[0] };
    };
    const me = await call("/me");
    const meJson = (me.json ?? {}) as { api_version?: unknown; organisations?: { org_id?: string; role?: unknown; name?: unknown }[]; product_policy?: unknown; user?: { display_name?: unknown } };
    const orgs = (Array.isArray(meJson.organisations) ? meJson.organisations : []).filter((o) => typeof o.org_id === "string");
    const features = [
      ["store.publish (submit, upload)", cfg.publishing.publisherCentralId],
      ["store.release.approve (approve)", cfg.publishing.approverCentralId],
      ["store.release.publish (publish)", cfg.publishing.publicationCentralId],
    ] as const;
    const checks = [];
    for (const [label, feature] of features) {
      if (!feature) {
        checks.push({ permission: label, configured: false });
        continue;
      }
      const perOrg = [];
      for (const [i, o] of orgs.entries()) {
        const r = await call("/check", { org_id: o.org_id, product_id: STORE_CENTRAL_PRODUCT_ID, feature_key: feature });
        const j = (r.json ?? {}) as Record<string, unknown>;
        perOrg.push({
          org: `#${i + 1} <${short(o.org_id!)}>`,
          httpStatus: r.status,
          allowed: j.allowed ?? null,
          echoes: j.api_version === "v1" && j.org_id === o.org_id && j.product_id === STORE_CENTRAL_PRODUCT_ID && j.feature_key === feature,
          answer: sanitize(j),
        });
      }
      checks.push({ permission: label, feature, product: STORE_CENTRAL_PRODUCT_ID, storeDecision: perOrg.some((x) => x.allowed === true && x.echoes) ? "granted" : "not granted", perOrg });
    }
    process.stdout.write(JSON.stringify({
      sessionRef: ref,
      accountRef: short(s.sub),
      signInMatchedWithMe: rows[0]!.account_confirmed_at !== null,
      storeClient: cfg.hcgConnect.clientId,
      token: claims,
      me: { httpStatus: me.status, apiVersion: meJson.api_version ?? null, organisations: orgs.map((o, i) => ({ org: `#${i + 1} <${short(o.org_id!)}>`, role: o.role ?? null })), productPolicy: sanitize(meJson.product_policy) },
      checks,
    }) + "\n");
  } finally {
    db.close();
  }
}
main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : "failed" }) + "\n");
  process.exitCode = 1;
});
