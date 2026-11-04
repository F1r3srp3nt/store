import type { HcgConnectConfigState } from "./config";

/** Each concern is tracked separately (mirrors the HCG LifeOS handoff). */
export type AuthenticationState =
  | { state: "unavailable"; reason: string }
  | { state: "signed-out" }
  | { state: "signing-in" }
  | { state: "signed-in"; subject: string }
  | { state: "expired" }
  | { state: "failed"; reason: string };

export type AppAccessState =
  | { state: "unavailable"; reason: string }
  | { state: "not-checked" }
  | { state: "granted" | "denied" | "revoked" | "unlicensed"; permissions: string[]; reason?: string };

export interface HcgConnectAdapter {
  readonly configuration: HcgConnectConfigState;
  readonly authentication: AuthenticationState;
  readonly appAccess: AppAccessState;
  /** True only when a reviewed, approved protocol implementation is present. */
  readonly canSignIn: boolean;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

export class HcgConnectUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "HcgConnectUnavailableError";
  }
}

export const PROTOCOL_PENDING_REASON =
  "The HCG Connect web sign-in protocol has not been agreed. HCG Store contains no sign-in implementation until the founder approves the contract.";

/**
 * The only adapter that exists today. It reports configuration honestly and refuses every
 * operation. It makes no network requests, stores no tokens and never reports a signed-in user.
 *
 * When the central contract is approved, add a reviewed implementation (e.g. Authorization Code
 * + PKCE, if that is what central HCG specifies) behind this same interface.
 */
export function createHcgConnectAdapter(configuration: HcgConnectConfigState): HcgConnectAdapter {
  const reason =
    configuration.state === "not-configured"
      ? "HCG Connect not configured."
      : configuration.state === "invalid"
        ? "HCG Connect configuration is invalid."
        : PROTOCOL_PENDING_REASON;
  const refuse = async () => {
    throw new HcgConnectUnavailableError(reason);
  };
  return {
    configuration,
    authentication: { state: "unavailable", reason },
    appAccess: { state: "unavailable", reason: "App Access can only be read for a signed-in HCG Connect user." },
    canSignIn: false,
    signIn: refuse,
    signOut: refuse,
  };
}
