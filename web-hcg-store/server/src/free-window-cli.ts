/**
 * Operator command for free testing windows (free-windows.ts). Runs on the server, never over HTTP. Text is passed
 * base64-encoded so no shell quoting can alter it. Times are ISO 8601 (e.g. 2026-12-31T23:59:59Z).
 *
 *   node server-dist/free-window.mjs open --product hcg-mail --edition windows-desktop [--release rel-…]
 *        --starts <iso|now> --ends <iso> --authorised-by-b64 <b64> --performed-by-b64 <b64>
 *   node server-dist/free-window.mjs open --product hcg-mail --edition windows-desktop --release rel-…
 *        --starts publication --days 30 --authorised-by-b64 <b64> --performed-by-b64 <b64>
 *        (starts when that release is published, or at its publication time if it already is; lasts 30 days)
 *   node server-dist/free-window.mjs extend --id fw-… (--ends <iso> | --days <total days from the start>) --authorised-by-b64 … --performed-by-b64 …
 *   node server-dist/free-window.mjs terminate --id fw-… --reason-b64 <b64> --authorised-by-b64 … --performed-by-b64 …
 *   node server-dist/free-window.mjs list [--product hcg-mail]
 *
 * A window never creates or changes a price, never asks for payment details and never charges anyone.
 */
import { parseStoreConfig } from "./config";
import { openDatabase } from "./db";
import { extendWindow, FreeWindowError, listWindows, openWindow, terminateWindow, type WindowPeriod } from "./free-windows";
import { findProduct, loadRegistry } from "./registry";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const b64 = (name: string) => Buffer.from(arg(name) ?? "", "base64").toString("utf8");
const time = (name: string, now: number) => {
  const v = arg(name);
  if (v === "now") return now;
  const t = v ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw new FreeWindowError(`${name} must be an ISO 8601 time or "now".`);
  return t;
};

const days = (name: string) => {
  const v = Number(arg(name));
  if (!Number.isInteger(v) || v < 1) throw new FreeWindowError(`${name} must be a whole number of days.`);
  return v * 24 * 3600 * 1000;
};

const cfg = parseStoreConfig(process.env);
const db = openDatabase(cfg.dataDir);
const now = Date.now();
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
const show = (w: ReturnType<typeof listWindows>[number]) => ({ ...w, startsAt: iso(w.startsAt), endsAt: iso(w.endsAt), terminatedAt: iso(w.terminatedAt) });
try {
  const who = { authorisedBy: b64("--authorised-by-b64"), performedBy: b64("--performed-by-b64") };
  const cmd = process.argv[2];
  if (cmd === "open") {
    const registry = loadRegistry({ catalogueDir: cfg.catalogueDir, offersFile: cfg.offersFile, artifactsFile: cfg.artifactsFile, testMode: cfg.mode === "test" });
    const product = findProduct(registry, arg("--product") ?? "");
    const editionId = arg("--edition") ?? null;
    if (!product || product.visibility === "draft") throw new FreeWindowError("Unknown product.");
    if (product.editions.length ? !product.editions.some((e) => e.id === editionId) : editionId !== null) throw new FreeWindowError("Unknown edition.");
    const releaseId = arg("--release") ?? null;
    let publishedAt: number | null = null;
    if (releaseId) {
      const r = db.prepare("SELECT product_id, edition_id, distribution, status, published_at FROM pub_releases WHERE id = ?").get(releaseId) as { product_id: string; edition_id: string | null; distribution: string; status: string; published_at: number | null } | undefined;
      if (!r || r.product_id !== product.id || r.edition_id !== editionId) throw new FreeWindowError("The release is not a release of this product edition.");
      if (r.distribution !== "free") throw new FreeWindowError("Only a release distributed as free can be in a free testing window.");
      if (["withdrawn", "superseded"].includes(r.status)) throw new FreeWindowError(`The release is ${r.status}.`);
      publishedAt = r.published_at;
    }
    const period: WindowPeriod = arg("--starts") === "publication"
      ? { anchor: "publication", durationMs: days("--days"), publishedAt }
      : { anchor: "fixed", startsAt: time("--starts", now), endsAt: time("--ends", now) };
    const w = openWindow(db, { productId: product.id, editionId, releaseId, period, ...who }, now);
    process.stdout.write(JSON.stringify({ opened: show(w) }) + "\n");
  } else if (cmd === "extend") {
    const change = arg("--days") !== undefined ? { durationMs: days("--days") } : { endsAt: time("--ends", now) };
    process.stdout.write(JSON.stringify({ extended: show(extendWindow(db, arg("--id") ?? "", change, who, now)) }) + "\n");
  } else if (cmd === "terminate") {
    process.stdout.write(JSON.stringify({ terminated: show(terminateWindow(db, arg("--id") ?? "", b64("--reason-b64"), who, now)) }) + "\n");
  } else if (cmd === "list") {
    const events = db.prepare("SELECT at, window_id, action, detail, authorised_by, performed_by FROM free_window_events ORDER BY seq").all();
    process.stdout.write(JSON.stringify({ windows: listWindows(db, now, arg("--product")).map(show), events }) + "\n");
  } else {
    throw new FreeWindowError("Use: open | extend | terminate | list");
  }
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e instanceof FreeWindowError ? e.message : (e as Error).message }) + "\n");
  process.exitCode = 1;
} finally {
  db.close();
}
