import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { findSecretLikePublicEnvNames, parseDeploymentConfig, type DeploymentConfig } from "../src/config/deployment";

interface Options {
  env: Record<string, string>;
  catalogueDir: string;
  basePath: string;
}

/** Collect the origins the browser app is allowed to call (CSP connect-src). */
function connectOrigins(env: Record<string, string>): string[] {
  const keys = [
    "VITE_HCG_ERP_CATALOGUE_URL",
    "VITE_HCG_CONNECT_AUTHORIZATION_ENDPOINT",
    "VITE_HCG_CONNECT_TOKEN_ENDPOINT",
    "VITE_HCG_CONNECT_REVOCATION_ENDPOINT",
    "VITE_HCG_CONNECT_APP_ACCESS_ENDPOINT",
  ];
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

export function hcgHostingPlugin({ env, catalogueDir, basePath }: Options): Plugin {
  const cfg = parseDeploymentConfig(env);
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
      // Crawlers that do not run JavaScript still see the noindex directive.
      if (cfg.indexingAllowed) return html;
      return html.replace("</head>", '    <meta name="robots" content="noindex, nofollow" />\n  </head>');
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
            builtAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      });
    },
  };
}
