import { toDropboxDownloadUrl } from "./dropbox";

/**
 * Download providers turn a catalogue artifact URL into a browser navigation target.
 * Providers never fetch file contents in the browser: downloads are ordinary navigations.
 */
export interface DownloadProvider {
  id: DownloadProviderId;
  label: string;
  /** Public explanation shown next to the download button. */
  disclosure: string;
  resolve(url: string): { ok: true; href: string; fileName: string } | { ok: false; reason: string };
}

export const DOWNLOAD_PROVIDER_IDS = ["dropbox"] as const;
export type DownloadProviderId = (typeof DOWNLOAD_PROVIDER_IDS)[number];

export const dropboxProvider: DownloadProvider = {
  id: "dropbox",
  label: "Dropbox",
  disclosure:
    "Served from a public Dropbox shared link. Anyone who has the link can download the file; it is not access-controlled by HCG.",
  resolve(url) {
    const r = toDropboxDownloadUrl(url);
    return r.ok ? { ok: true, href: r.url, fileName: r.fileName } : { ok: false, reason: r.message };
  },
};

export const DOWNLOAD_PROVIDERS: Record<DownloadProviderId, DownloadProvider> = {
  dropbox: dropboxProvider,
};
