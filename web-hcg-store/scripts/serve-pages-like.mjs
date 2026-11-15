#!/usr/bin/env node
/**
 * Serves a directory the way GitHub Pages does, for testing the Pages artifact locally and in CI:
 *   /            → index.html
 *   /a/b         → a/b.html, else a/b/index.html (Pages answers "/a/b" with a redirect to "/a/b/"
 *                  in that case; this server does the same)
 *   anything else → 404.html with status 404
 * No rewrites and no custom headers, exactly like Pages.
 *
 *   node scripts/serve-pages-like.mjs dist 4180
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? 4180);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const send = (res, status, file) => {
  res.writeHead(status, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
};

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const target = normalize(join(root, path));
  if (target !== root && !target.startsWith(root + sep)) return send(res, 404, join(root, "404.html"));
  if (path.endsWith("/") && isFile(join(target, "index.html"))) return send(res, 200, join(target, "index.html"));
  if (isFile(target)) return send(res, 200, target);
  if (isFile(`${target}.html`)) return send(res, 200, `${target}.html`);
  if (isFile(join(target, "index.html"))) {
    res.writeHead(301, { location: `${path}/` });
    return res.end();
  }
  return send(res, 404, join(root, "404.html"));
}).listen(port, "127.0.0.1", () => console.log(`Pages-like server for ${root} on http://127.0.0.1:${port}/`));
