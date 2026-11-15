import { describe, expect, it } from "vitest";
import { knownRoutes, metaCsp, securityHeaders } from "./hosting-plugin";
import { parseDeploymentConfig } from "../src/config/deployment";

describe("GitHub Pages hosting helpers", () => {
  it("lists every storefront route, including each product and its release history", () => {
    const r = knownRoutes(["hcg-terminal", "hcg-nexus"]);
    expect(r).toEqual(
      expect.arrayContaining(["apps", "getting-started", "account", "library", "checkout/return", "apps/hcg-terminal", "apps/hcg-terminal/releases", "apps/hcg-nexus"]),
    );
    expect(r.every((x) => !x.startsWith("/"))).toBe(true);
  });

  it("puts the same CSP in a meta tag, minus frame-ancestors (not allowed in meta)", () => {
    const env = { VITE_DEPLOY_ENV: "production", VITE_PUBLIC_ORIGIN: "https://store.hakmicapitalgroup.com" };
    const csp = metaCsp(securityHeaders(parseDeploymentConfig(env), env));
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("frame-ancestors");
  });
});
