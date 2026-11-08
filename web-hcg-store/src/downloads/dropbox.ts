/**
 * Dropbox shared-file links → direct-download links.
 *
 * Only HTTPS links to explicitly supported Dropbox hosts and shared-FILE paths are accepted.
 * The result keeps every query parameter Dropbox needs (notably `rlkey`, plus `st`, `e`, …),
 * forces `dl=1`, removes `raw` and drops any fragment.
 */

export const DROPBOX_HOSTS = ["www.dropbox.com", "dropbox.com"] as const;
const MAX_URL_LENGTH = 2048;
const ID_SEGMENT = /^[A-Za-z0-9_-]+$/;

export type DropboxRejection =
  | "empty"
  | "too-long"
  | "invalid-characters"
  | "malformed"
  | "unsupported-protocol"
  | "credentials"
  | "port"
  | "unsupported-host"
  | "unsupported-link-type"
  | "missing-rlkey";

export type DropboxResult =
  | { ok: true; url: string; fileName: string; linkType: "scl-file" | "legacy-file" }
  | { ok: false; code: DropboxRejection; message: string };

const reject = (code: DropboxRejection, message: string): DropboxResult => ({ ok: false, code, message });

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.trim() === "" ? null : decoded;
  } catch {
    return null;
  }
}

export function toDropboxDownloadUrl(input: unknown): DropboxResult {
  if (typeof input !== "string" || input.trim() === "") return reject("empty", "No Dropbox link was supplied.");
  const raw = input.trim();
  if (raw.length > MAX_URL_LENGTH) return reject("too-long", "The link is longer than 2048 characters.");
  // Whitespace, control characters and backslashes are never part of a genuine shared link and
  // are common in deceptive URLs (they are silently "repaired" by URL parsers).
  if (/[\s\u0000-\u001f\u007f\\]/.test(raw)) {
    return reject("invalid-characters", "The link contains whitespace, control characters or backslashes.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject("malformed", "The link is not a valid absolute URL.");
  }

  if (url.protocol !== "https:") return reject("unsupported-protocol", "Only https:// Dropbox links are accepted.");
  if (url.username || url.password) return reject("credentials", "Links containing user names or passwords are rejected.");
  if (url.port) return reject("port", "Links with an explicit port are rejected.");
  if (!(DROPBOX_HOSTS as readonly string[]).includes(url.hostname)) {
    return reject("unsupported-host", `Host "${url.hostname}" is not a supported Dropbox host (${DROPBOX_HOSTS.join(", ")}).`);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  let linkType: "scl-file" | "legacy-file";
  let fileSegment: string | undefined;

  if (segments.length === 4 && segments[0] === "scl" && segments[1] === "fi" && ID_SEGMENT.test(segments[2] ?? "")) {
    linkType = "scl-file";
    fileSegment = segments[3];
    if (!url.searchParams.get("rlkey")) {
      return reject("missing-rlkey", "Dropbox /scl/fi/ links need their rlkey parameter. Copy the full shared link.");
    }
  } else if (segments.length === 3 && segments[0] === "s" && ID_SEGMENT.test(segments[1] ?? "")) {
    linkType = "legacy-file";
    fileSegment = segments[2];
  } else {
    return reject(
      "unsupported-link-type",
      "Only Dropbox shared-file links (/scl/fi/… or /s/…) are supported. Folder links and other Dropbox pages are rejected.",
    );
  }

  const fileName = fileSegment ? decodeSegment(fileSegment) : null;
  if (!fileName || fileName.includes("/")) return reject("malformed", "The link does not contain a usable file name.");

  url.searchParams.delete("raw");
  url.searchParams.set("dl", "1");
  url.hash = "";
  return { ok: true, url: url.toString(), fileName, linkType };
}
