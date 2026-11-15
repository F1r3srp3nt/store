import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** URL-safe random token with the given number of bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** AES-256-GCM. Used for refresh and access tokens at rest, so a copied database alone does not reveal them. */
export function seal(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(context));
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function unseal(key: Buffer, sealed: string, context: string): string | null {
  try {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    if (!iv || !tag || !body) return null;
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(Buffer.from(context));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** HMAC-signed, expiring token: base64url(payload).base64url(sig). The payload is JSON. */
export function signPayload(key: Buffer, purpose: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", key).update(`${purpose}.${body}`).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyPayload<T>(key: Buffer, purpose: string, token: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", key).update(`${purpose}.${body}`).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** PKCE S256 code challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
