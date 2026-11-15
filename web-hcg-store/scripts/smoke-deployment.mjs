#!/usr/bin/env node
/**
 * Deployment smoke check for the HCG Store storefront.
 *
 *   node scripts/smoke-deployment.mjs https://store.hakmicapitalgroup.com/ [--expect-commit <sha>] [--wait 300]
 *
 * Fails (exit 1) unless the URL serves the BUILT storefront at its root. It detects the classic
 * misdeployment where GitHub Pages renders the repository README instead of the app, and it
 * checks nested-route reloads, assets, images, the build manifest, and that no source files,
 * server data or protected files are reachable. For https URLs it also requires a valid
 * certificate (Node refuses invalid ones) and checks that plain http redirects to https.
 *
 * Plain Node 22, no dependencies.
 */

const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith("--"));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!base) {
  console.error("Usage: smoke-deployment.mjs <base URL> [--expect-commit <sha>] [--wait <seconds>] [--no-http-redirect-check]");
  process.exit(2);
}
const root = new URL(base.endsWith("/") ? base : `${base}/`);
const expectCommit = opt("expect-commit");
const waitSeconds = Number(opt("wait") ?? 0);
const checkHttpRedirect = root.protocol === "https:" && !args.includes("--no-http-redirect-check");

/** Text that appears when the repository README (or any docs page) is served instead of the app. */
const README_MARKERS = [
  /HCG Store \(web storefront\)/i,
  /npm run dev/i,
  /npm ci\b/i,
  /Run locally/i,
  /web-hcg-store\//i,
  /id="hcg-store-web-storefront"/i,
  /jekyll/i,
];

const results = [];
const pass = (name, detail = "") => results.push({ ok: true, name, detail });
const fail = (name, detail = "") => results.push({ ok: false, name, detail });

async function get(path, init = {}) {
  const url = new URL(path, root);
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "user-agent": "hcg-store-smoke/1" }, ...init });
    const body = res.status >= 300 && res.status < 400 ? "" : await res.text();
    return { url: url.toString(), status: res.status, type: res.headers.get("content-type") ?? "", location: res.headers.get("location"), body };
  } catch (e) {
    const cause = e?.cause?.code || e?.cause?.message || e?.message || String(e);
    return { url: url.toString(), status: 0, type: "", location: null, body: "", error: cause };
  }
}

/** Follows same-host redirects (e.g. a trailing-slash redirect) and returns the final response. */
async function getFollow(path, hops = 3) {
  let r = await get(path);
  while (hops-- > 0 && r.status >= 300 && r.status < 400 && r.location) {
    const next = new URL(r.location, r.url);
    if (next.host !== root.host) break;
    r = await get(next.pathname + next.search);
  }
  return r;
}

function isAppShell(html) {
  return /<div id="root"><\/div>/.test(html) && /<title>HCG Store<\/title>/.test(html) && /<script type="module"[^>]+src="\/assets\/index-[\w-]+\.js"/.test(html);
}

async function checkOnce() {
  results.length = 0;

  // 1. Root must be the built app shell, not the README or a docs page.
  const home = await get("");
  if (home.error) fail("homepage reachable", `${home.url}: ${home.error}`);
  else if (home.status !== 200) fail("homepage returns 200", `${home.url}: HTTP ${home.status}`);
  else {
    pass("homepage returns 200", home.url);
    const readme = README_MARKERS.filter((re) => re.test(home.body));
    if (readme.length) fail("homepage is not the repository README", `found ${readme.map(String).join(", ")}`);
    else pass("homepage is not the repository README");
    if (isAppShell(home.body)) pass("homepage is the built HCG Store app shell");
    else fail("homepage is the built HCG Store app shell", "missing #root, <title>HCG Store</title> or the /assets/index-*.js module script");
    if (/src="\/src\/main\.tsx"/.test(home.body)) fail("homepage is built, not raw source", "references /src/main.tsx (unbuilt index.html)");
  }

  // 2. The app bundle and stylesheet load.
  const script = /src="(\/assets\/index-[\w-]+\.js)"/.exec(home.body)?.[1];
  const css = /href="(\/assets\/index-[\w-]+\.css)"/.exec(home.body)?.[1];
  for (const [label, path, type] of [
    ["app script", script, /javascript/],
    ["stylesheet", css, /css/],
  ]) {
    if (!path) {
      fail(`${label} referenced`, "not found in homepage");
      continue;
    }
    const r = await get(path);
    if (r.status === 200 && type.test(r.type)) pass(`${label} loads`, `${path} (${r.type})`);
    else fail(`${label} loads`, `${path}: HTTP ${r.status} ${r.type}`);
  }

  // 3. Direct loads / reloads of nested routes return the app shell with 200.
  for (const route of ["apps", "apps/hcg-terminal", "apps/hcg-terminal/releases", "apps/hcg-nexus", "getting-started", "account", "library"]) {
    const r = await getFollow(route);
    if (r.status === 200 && isAppShell(r.body)) pass(`direct load /${route}`);
    else fail(`direct load /${route}`, `HTTP ${r.status}${isAppShell(r.body) ? "" : ", not the app shell"}`);
  }
  // Unknown paths still render the app (its own "not found" page), never a host error page.
  const unknown = await get("definitely-not-a-page");
  if (isAppShell(unknown.body)) pass("unknown path renders the app's not-found page", `HTTP ${unknown.status}`);
  else fail("unknown path renders the app's not-found page", `HTTP ${unknown.status}`);

  // 4. Images and brand assets.
  for (const path of ["brand/hcg-mark-240.webp", "brand/hcg-store-banner-1200.webp", "brand/favicon-32.png", "media/products/hcg-executable-maker/dashboard-720.webp"]) {
    const r = await get(path);
    if (r.status === 200 && /^image\//.test(r.type)) pass(`image /${path}`);
    else fail(`image /${path}`, `HTTP ${r.status} ${r.type}`);
  }

  // 5. Build manifest: the right build is deployed.
  const manifest = await get("hcg-build.json");
  try {
    const m = JSON.parse(manifest.body);
    if (m.app !== "HCG Store") throw new Error("not an HCG Store build");
    pass("build manifest", `deployEnv=${m.deployEnv} hosting=${m.hostingTarget} accountService=${m.accountService} commit=${m.commit ?? "n/a"}`);
    if (root.hostname === "store.hakmicapitalgroup.com") {
      if (m.deployEnv !== "production") fail("production build on the production domain", `deployEnv=${m.deployEnv}`);
      if (m.publicOrigin !== root.origin) fail("build origin matches the domain", `publicOrigin=${m.publicOrigin}`);
      if (m.fixtureMode) fail("no test fixture data in production");
    }
    if (expectCommit) {
      if (m.commit === expectCommit) pass("deployed commit", m.commit);
      else fail("deployed commit", `expected ${expectCommit}, serving ${m.commit}`);
    }
  } catch (e) {
    fail("build manifest", `${manifest.url}: HTTP ${manifest.status} ${e.message}`);
  }

  // 6. Nothing that must stay private or unbuilt is reachable. (Only meaningful when the site
  // answers at all: "unreachable" is never counted as "not published".)
  if (home.status === 0) {
    fail("private paths checked", "site unreachable; cannot verify that nothing private is published");
    return finishHttps(home);
  }
  for (const path of [
    "README.md",
    "web-hcg-store/README.md",
    "web-hcg-store/package.json",
    "src/main.tsx",
    "server/data/offers.json",
    "server/src/app.ts",
    ".env",
    "catalogue/products.json",
  ]) {
    const r = await get(path);
    const leaked = r.status === 200 && !isAppShell(r.body);
    if (leaked) fail(`/${path} not published`, `HTTP 200 ${r.type}`);
    else pass(`/${path} not published`, `HTTP ${r.status}`);
  }
  // Static hosting has no account server: protected download URLs must never yield a file.
  const dl = await get("api/v1/downloads/any-file");
  if (dl.status === 200 && !isAppShell(dl.body) && !/application\/json/.test(dl.type)) fail("no protected file served statically", `HTTP 200 ${dl.type}`);
  else pass("no protected file served statically", `HTTP ${dl.status}`);

  return finishHttps(home);
}

async function finishHttps(home) {
  // 7. HTTPS: valid certificate (fetch already refused invalid ones) and http → https.
  if (root.protocol === "https:") {
    if (home.status === 200) pass("HTTPS with a certificate valid for the host", root.host);
    else if (/CERT|SSL|TLS/i.test(home.error ?? "")) fail("HTTPS with a certificate valid for the host", `${root.host}: ${home.error}`);
  }
  if (checkHttpRedirect) {
    const http = new URL(root);
    http.protocol = "http:";
    const r = await get(http.toString());
    const to = r.location ? new URL(r.location, http) : null;
    if (r.status >= 301 && r.status <= 308 && to?.protocol === "https:" && to.host === root.host) pass("http redirects to https", `${r.status} → ${to}`);
    else fail("http redirects to https", r.error ? r.error : `HTTP ${r.status}${r.location ? ` → ${r.location}` : " (no redirect)"}`);
  }

  return results.every((r) => r.ok);
}

const deadline = Date.now() + waitSeconds * 1000;
let ok = await checkOnce();
while (!ok && Date.now() < deadline) {
  console.log(`… not ready yet (${results.filter((r) => !r.ok).length} failing); retrying in 20 s`);
  await new Promise((r) => setTimeout(r, 20_000));
  ok = await checkOnce();
}
for (const r of results) console.log(`${r.ok ? "✔" : "✖"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
console.log(ok ? `\nSMOKE OK: ${root} serves the HCG Store storefront.` : `\nSMOKE FAILED: ${root} does not serve the HCG Store storefront correctly.`);
process.exit(ok ? 0 : 1);
