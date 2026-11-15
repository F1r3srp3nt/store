import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { findSecretLikePublicEnvNames, parseDeploymentConfig, type DeploymentConfig } from "../src/config/deployment";

interface Options {
  env: Record<string, string>;
  catalogueDir: string;
  basePath: string;
  /**
   * Static host the build is for. "github-pages" has no SPA rewrites and no custom response
   * headers, so the build writes one HTML page per known route (plus 404.html for anything else)
   * and puts the Content-Security-Policy in a meta tag.
   */
  hostingTarget?: string;
  outDir?: string;
}

/** Every route the storefront knows about, relative to the base path (no leading slash). */
export function knownRoutes(slugs: string[]): string[] {
  return [
    "apps",
    "getting-started",
    "account",
    "library",
    "checkout/return",
    ...slugs.flatMap((s) => [`apps/${s}`, `apps/${s}/releases`]),
  ];
}

/** CSP for a <meta> tag: frame-ancestors is not allowed there (X-Frame-Options cannot be set either). */
export function metaCsp(headers: Record<string, string>): string {
  return (headers["Content-Security-Policy"] ?? "")
    .split("; ")
    .filter((d) => !d.startsWith("frame-ancestors"))
    .join("; ");
}

/** Collect the origins the browser app is allowed to call (CSP connect-src). */
function connectOrigins(env: Record<string, string>): string[] {
  // Sign-in, purchases and downloads go through the Store server on the same origin ('self').
  const keys = ["VITE_HCG_ERP_CATALOGUE_URL"];
  const origins = new Set<string>();
  for (const k of keys) {
    const v = env[k];
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.protocol === "https:") origins.add(u.origin);
    } catch {
      /* invalid values are reported by the app's own configuration checks */
    }
  }
  return [...origins];
}

export function securityHeaders(cfg: DeploymentConfig, env: Record<string, string>): Record<string, string> {
  const connect = ["'self'", ...connectOrigins(env)].join(" ");
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers: Record<string, string> = {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  if (!cfg.indexingAllowed) headers["X-Robots-Tag"] = "noindex, nofollow";
  return headers;
}

function readSlugs(dir: string): string[] {
  try {
    const doc = JSON.parse(readFileSync(join(dir, "products.json"), "utf8")) as { products?: { slug?: string }[] };
    return (doc.products ?? []).map((p) => p.slug).filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

export function hcgHostingPlugin({ env, catalogueDir, basePath, hostingTarget = "", outDir = "dist" }: Options): Plugin {
  const cfg = parseDeploymentConfig(env);
  const githubPages = hostingTarget === "github-pages";
  if (hostingTarget && !githubPages) cfg.errors.push(`HCG_HOSTING_TARGET "${hostingTarget}" is not supported (use "github-pages" or leave it empty).`);
  if (githubPages && env.VITE_STORE_ACCOUNT_SERVICE !== "none") {
    cfg.errors.push(
      "GitHub Pages is static and cannot run the HCG Store server. Build with VITE_STORE_ACCOUNT_SERVICE=none so the site never pretends sign-in, purchases or downloads exist.",
    );
  }
  return {
    name: "hcg-hosting",
    configResolved() {
      const secretNames = findSecretLikePublicEnvNames(env);
      if (secretNames.length) {
        cfg.errors.push(
          `Refusing to build: ${secretNames.join(", ")} look like credentials. VITE_ variables are embedded in the ` +
            "public bundle. Keep secrets on a backend and remove these variables.",
        );
      }
      if (/[\\/]tests[\\/]fixtures[\\/]/.test(catalogueDir) && !cfg.fixtureMode) {
        cfg.errors.push("A test fixture catalogue was selected without VITE_FIXTURE_MODE=true (the fixture banner would be missing).");
      }
      for (const w of cfg.warnings) console.warn(`[hcg-hosting] ${w}`);
      if (cfg.errors.length) throw new Error(`[hcg-hosting] Invalid configuration:\n - ${cfg.errors.join("\n - ")}`);
    },
    transformIndexHtml(html) {
      let out = html;
      if (githubPages) {
        // GitHub Pages cannot send response headers: put the policy in the document instead.
        const csp = metaCsp(securityHeaders(cfg, env));
        out = out.replace(
          /(<meta charset="[^"]*"\s*\/?>)/i,
          `$1\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <meta name="referrer" content="strict-origin-when-cross-origin" />`,
        );
      }
      // Crawlers that do not run JavaScript still see the noindex directive.
      if (cfg.indexingAllowed) return out;
      return out.replace("</head>", '    <meta name="robots" content="noindex, nofollow" />\n  </head>');
    },
    writeBundle() {
      if (!githubPages) return;
      // No SPA rewrites on GitHub Pages: write the app shell at every known route so direct
      // loads and reloads return 200 (Pages serves "/apps/x" from "apps/x.html"), and use it
      // as 404.html so unknown paths still render the storefront's own "not found" page.
      const shell = readFileSync(join(outDir, "index.html"), "utf8");
      for (const route of knownRoutes(readSlugs(catalogueDir))) {
        const file = join(outDir, `${route}.html`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, shell);
      }
      writeFileSync(join(outDir, "404.html"), shell);
    },
    generateBundle() {
      const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
      const robots = cfg.indexingAllowed
        ? `User-agent: *\nAllow: /\nSitemap: ${cfg.publicOrigin}${base}sitemap.xml\n`
        : "# Non-production build: indexing disabled.\nUser-agent: *\nDisallow: /\n";
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots });

      if (cfg.indexingAllowed && cfg.publicOrigin) {
        const paths = ["", "apps", "getting-started", ...readSlugs(catalogueDir).flatMap((s) => [`apps/${s}`, `apps/${s}/releases`])];
        const urls = paths.map((p) => `  <url><loc>${cfg.publicOrigin}${base}${p}</loc></url>`).join("\n");
        this.emitFile({
          type: "asset",
          fileName: "sitemap.xml",
          source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
        });
      }

      const headers = securityHeaders(cfg, env);
      const headerLines = Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`);
      if (cfg.deployEnv === "production") headerLines.push("  Strict-Transport-Security: max-age=31536000");
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: `/*\n${headerLines.join("\n")}\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/index.html\n  Cache-Control: no-cache\n`,
      });
      this.emitFile({ type: "asset", fileName: "_redirects", source: `${base}*  ${base}index.html  200\n` });
      this.emitFile({
        type: "asset",
        fileName: "hcg-build.json",
        source: JSON.stringify(
          {
            app: "HCG Store",
            deployEnv: cfg.deployEnv,
            publicOrigin: cfg.publicOrigin,
            indexingAllowed: cfg.indexingAllowed,
            fixtureMode: cfg.fixtureMode,
            hostingTarget: hostingTarget || "generic-static",
            accountService: env.VITE_STORE_ACCOUNT_SERVICE === "none" ? "none" : "same-origin-server",
            commit: process.env.GITHUB_SHA ?? null,
            builtAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      });
    },
  };
}
