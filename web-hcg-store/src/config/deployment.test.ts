import { describe, expect, it } from "vitest";
import { findSecretLikePublicEnvNames, parseDeploymentConfig } from "./deployment";

describe("deployment configuration", () => {
  it("defaults to a non-indexed development build without an origin", () => {
    const c = parseDeploymentConfig({});
    expect(c).toMatchObject({ deployEnv: "development", publicOrigin: null, indexingAllowed: false, errors: [] });
  });

  it("accepts localhost over http and normalises origins", () => {
    expect(parseDeploymentConfig({ VITE_PUBLIC_ORIGIN: "http://localhost:5173/" }).publicOrigin).toBe("http://localhost:5173");
    expect(parseDeploymentConfig({ VITE_PUBLIC_ORIGIN: "https://hcg-store-preview.example.dev" }).publicOrigin).toBe("https://hcg-store-preview.example.dev");
  });

  it("rejects non-https, credentials, paths and malformed origins", () => {
    for (const o of ["http://preview.example.dev", "https://u:p@x.example", "https://x.example/sub", "https://x.example/?a=1", "nope"]) {
      expect(parseDeploymentConfig({ VITE_PUBLIC_ORIGIN: o }).errors.length).toBeGreaterThan(0);
    }
  });

  it("refuses the future production domain outside an explicit production build", () => {
    for (const env of ["development", "preview"]) {
      const c = parseDeploymentConfig({ VITE_DEPLOY_ENV: env, VITE_PUBLIC_ORIGIN: "https://store.hakmicapitalgroup.com" });
      expect(c.errors.join(" ")).toMatch(/not live/);
    }
    expect(parseDeploymentConfig({ VITE_DEPLOY_ENV: "production", VITE_PUBLIC_ORIGIN: "https://store.hakmicapitalgroup.com" }).errors).toEqual([]);
  });

  it("only allows indexing for explicit production builds with an origin", () => {
    expect(parseDeploymentConfig({ VITE_DEPLOY_ENV: "preview", VITE_ALLOW_INDEXING: "true", VITE_PUBLIC_ORIGIN: "https://p.example.dev" }).indexingAllowed).toBe(false);
    expect(parseDeploymentConfig({ VITE_DEPLOY_ENV: "production", VITE_ALLOW_INDEXING: "true" }).errors.join()).toMatch(/requires VITE_PUBLIC_ORIGIN/);
    expect(parseDeploymentConfig({ VITE_DEPLOY_ENV: "production", VITE_PUBLIC_ORIGIN: "https://p.example.dev" }).indexingAllowed).toBe(false);
    expect(
      parseDeploymentConfig({ VITE_DEPLOY_ENV: "production", VITE_ALLOW_INDEXING: "true", VITE_PUBLIC_ORIGIN: "https://p.example.dev" }).indexingAllowed,
    ).toBe(true);
  });

  it("never allows fixture data in production", () => {
    expect(parseDeploymentConfig({ VITE_DEPLOY_ENV: "production", VITE_FIXTURE_MODE: "true" }).errors.join()).toMatch(/Fixture/);
  });

  it("rejects unknown deploy environments", () => {
    expect(parseDeploymentConfig({ VITE_DEPLOY_ENV: "prod" }).errors.length).toBe(1);
  });

  it("flags secret-looking public variables", () => {
    expect(
      findSecretLikePublicEnvNames({
        VITE_HCG_CONNECT_CLIENT_ID: "x",
        VITE_HCG_CONNECT_CLIENT_SECRET: "x",
        VITE_SUPABASE_SERVICE_ROLE_KEY: "x",
        VITE_DROPBOX_ACCESS_TOKEN: "x",
        SERVER_SECRET: "not public, ignored",
      }).sort(),
    ).toEqual(["VITE_DROPBOX_ACCESS_TOKEN", "VITE_HCG_CONNECT_CLIENT_SECRET", "VITE_SUPABASE_SERVICE_ROLE_KEY"]);
  });
});
