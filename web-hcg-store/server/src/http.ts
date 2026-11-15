import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Every dynamic response is private and never stored by a browser, proxy or CDN. Combined with
 * `Vary: Cookie, Authorization`, a shared cache can never hand one person's response to another.
 */
export const PRIVATE_NO_STORE = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  vary: "Cookie, Authorization, Origin",
} as const;

const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
} as const;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string>) {
  res.writeHead(status, { ...BASE_HEADERS, ...PRIVATE_NO_STORE, ...headers });
  res.end(body);
}

export function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  send(res, status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8", ...headers });
}

export function errorJson(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}) {
  json(res, status, { error: { code, message } }, headers);
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}) {
  send(res, 302, "", { location, ...headers });
}

export function html(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  send(res, status, body, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...headers,
  });
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "too_large", "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const type = req.headers["content-type"] ?? "";
  const raw = await readBody(req);
  if (type.startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw)) as T;
  if (!type.startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Send JSON.");
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as T;
  } catch {
    throw new HttpError(400, "bad_json", "Malformed JSON.");
  }
}

/**
 * CSRF protection for cookie-authenticated state changes: the request must come from the Store's
 * own origin. Browsers always send Origin on cross-site POSTs, so a missing or foreign Origin is
 * refused. (The session cookie is also SameSite=Lax.)
 */
export function assertSameOrigin(req: IncomingMessage, publicOrigin: string) {
  const origin = req.headers.origin;
  const site = req.headers["sec-fetch-site"];
  if (origin !== publicOrigin || (site !== undefined && site !== "same-origin")) {
    throw new HttpError(403, "cross_site_request", "This request must come from HCG Store itself.");
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Accepts only a relative in-site path ("/apps/x?edition=y"); everything else becomes "/". */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return "/";
  try {
    const u = new URL(value, "http://store.invalid");
    if (u.origin !== "http://store.invalid") return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}
