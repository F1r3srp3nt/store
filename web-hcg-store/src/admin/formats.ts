/**
 * What a file probably is, from its name, to pre-fill the upload form. Only a suggestion: the person confirms the
 * platform and architectures, and HCG Store decides from the bytes (a renamed file is refused).
 */
export const PLATFORM_NAMES: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux", ios: "iOS", ipados: "iPadOS", android: "Android" };
export const ARCHITECTURES = ["x64", "arm64", "x86", "universal"] as const;

const BY_EXTENSION: Record<string, { format: string; platforms: string[] }> = {
  ".exe": { format: "exe", platforms: ["windows"] },
  ".msi": { format: "msi", platforms: ["windows"] },
  ".msix": { format: "msix", platforms: ["windows"] },
  ".zip": { format: "zip", platforms: ["windows", "macos"] },
  ".dmg": { format: "dmg", platforms: ["macos"] },
  ".pkg": { format: "pkg", platforms: ["macos"] },
  ".ipa": { format: "ipa", platforms: ["ios", "ipados"] },
  ".apk": { format: "apk", platforms: ["android"] },
  ".aab": { format: "aab", platforms: ["android"] },
  ".appimage": { format: "appimage", platforms: ["linux"] },
  ".rpm": { format: "rpm", platforms: ["linux"] },
  ".deb": { format: "deb", platforms: ["linux", "ios"] },
};

export interface Guess { format: string | null; platforms: string[]; platform: string | null; architectures: string[]; note: string | null }

export function guessFile(name: string): Guess {
  const lower = name.toLowerCase();
  const ext = Object.keys(BY_EXTENSION).find((x) => lower.endsWith(x));
  if (!ext) return { format: null, platforms: [], platform: null, architectures: [], note: "Not a format HCG Store distributes. A macOS .app bundle must be packaged first (ZIP, DMG or PKG)." };
  const { format, platforms } = BY_EXTENSION[ext]!;
  let platform = platforms[0]!;
  if (format === "zip" && /(mac|darwin|osx|\.app\b|universal)/.test(lower)) platform = "macos";
  if (format === "deb" && /(iphoneos|ios|jailbreak|rootless|arm64e?\b)/.test(lower)) platform = "ios";
  const architectures = /universal/.test(lower) ? ["arm64", "x64"]
    : /(arm64|aarch64)/.test(lower) ? ["arm64"]
    : /(x64|x86_64|amd64|win64)/.test(lower) ? ["x64"]
    : /(x86|win32|i386|i686)/.test(lower) ? ["x86"]
    : [];
  const note = format === "deb" && platform === "ios" ? "Jailbreak packages are distributed through HCG Repo (Sileo); the release must include HCG Repo as a destination."
    : format === "aab" ? "Android App Bundles are for authorised distribution only and are never offered to customers."
    : null;
  return { format, platforms, platform, architectures, note };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export function formatDuration(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.ceil(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.ceil(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.ceil((s % 3600) / 60)} min`;
}
