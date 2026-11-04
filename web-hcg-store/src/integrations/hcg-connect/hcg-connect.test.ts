import { afterEach, describe, expect, it, vi } from "vitest";
import { createHcgConnectAdapter, HcgConnectUnavailableError } from "./adapter";
import { HCG_CONNECT_FIELDS, parseHcgConnectConfig } from "./config";

const ORIGIN = "https://preview.example.dev";
const full = {
  VITE_HCG_CONNECT_CONTRACT_VERSION: "test-1",
  VITE_HCG_CONNECT_AUTHORIZATION_ENDPOINT: "https://central.example/authorize",
  VITE_HCG_CONNECT_TOKEN_ENDPOINT: "https://central.example/token",
  VITE_HCG_CONNECT_REVOCATION_ENDPOINT: "https://central.example/revoke",
  VITE_HCG_CONNECT_APP_ACCESS_ENDPOINT: "https://central.example/app-access",
  VITE_HCG_CONNECT_CLIENT_ID: "public-client",
  VITE_HCG_CONNECT_REDIRECT_URI: `${ORIGIN}/account/callback`,
  VITE_HCG_CONNECT_SCOPES: "openid profile",
  VITE_HCG_CONNECT_APP_IDENTIFIER: "hcg-store",
  VITE_HCG_CONNECT_APPROVED_BY_FOUNDER: "true",
};

afterEach(() => vi.restoreAllMocks());

describe("HCG Connect configuration", () => {
  it("reports 'not configured' with every missing field when nothing is set", () => {
    const s = parseHcgConnectConfig({}, ORIGIN);
    expect(s.state).toBe("not-configured");
    if (s.state === "not-configured") expect(s.missing).toHaveLength(HCG_CONNECT_FIELDS.length);
  });

  it("reports partial configuration as invalid with the missing fields", () => {
    const s = parseHcgConnectConfig({ VITE_HCG_CONNECT_CLIENT_ID: "x" }, ORIGIN);
    expect(s.state).toBe("invalid");
    if (s.state === "invalid") expect(s.problems.join()).toMatch(/Token endpoint/);
  });

  it("requires https endpoints, a matching redirect origin and founder approval", () => {
    const s = parseHcgConnectConfig(
      {
        ...full,
        VITE_HCG_CONNECT_TOKEN_ENDPOINT: "http://central.example/token",
        VITE_HCG_CONNECT_REDIRECT_URI: "https://store.hakmicapitalgroup.com/callback",
        VITE_HCG_CONNECT_APPROVED_BY_FOUNDER: "false",
      },
      ORIGIN,
    );
    expect(s.state).toBe("invalid");
    const text = s.state === "invalid" ? s.problems.join("\n") : "";
    expect(text).toMatch(/Token endpoint must use https/);
    expect(text).toMatch(/does not match the origin/);
    expect(text).toMatch(/Founder approval/);
  });

  it("accepts a complete, approved configuration", () => {
    const s = parseHcgConnectConfig(full, ORIGIN);
    expect(s.state).toBe("ready");
    if (s.state === "ready") expect(s.config.scopes).toEqual(["openid", "profile"]);
  });
});

describe("HCG Connect adapter", () => {
  it("never reports a signed-in user and makes no network requests, even when configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const env of [{}, { VITE_HCG_CONNECT_CLIENT_ID: "x" }, full]) {
      const a = createHcgConnectAdapter(parseHcgConnectConfig(env, ORIGIN));
      expect(a.canSignIn).toBe(false);
      expect(a.authentication.state).toBe("unavailable");
      expect(a.appAccess.state).toBe("unavailable");
      await expect(a.signIn()).rejects.toBeInstanceOf(HcgConnectUnavailableError);
      await expect(a.signOut()).rejects.toBeInstanceOf(HcgConnectUnavailableError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("explains why sign-in is unavailable", () => {
    const a = createHcgConnectAdapter(parseHcgConnectConfig({}, ORIGIN));
    expect(a.authentication).toEqual({ state: "unavailable", reason: "HCG Connect not configured." });
  });
});
