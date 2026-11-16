/**
 * Server-side validation of uploaded release artifacts. Runs on the complete, hashed file in private
 * staging BEFORE it is moved to immutable storage. Nothing in the file is executed or extracted to disk.
 *
 * - Only allow-listed (platform, format, extension) combinations are accepted.
 * - The content must match the format (magic bytes / container structure), so a renamed file is refused.
 * - ZIP-based formats (ZIP, IPA, MSIX, macOS app ZIP) are checked entry by entry: absolute paths, "..",
 *   backslashes, drive letters, control characters, symlinks, encrypted entries, decompression-bomb
 *   ratios and total size are refused.
 * - Debian packages: ar members are checked; the control file is read when control.tar is gzip.
 * - Signatures are reported as PRESENT or ABSENT only. HCG Store never claims to have verified a signature;
 *   verification results come from the uploading tool and are recorded as "reported".
 * - Every file gets a KIND decided here from its content (installer, portable app, iOS device build, iOS Simulator
 *   build, jailbreak package). Simulator builds are refused: they cannot be installed on an iPhone or iPad.
 *   installReadiness() turns kind + signature facts into the label people see; it never calls an unsigned, Simulator
 *   or jailbreak file ready for ordinary installation.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";

export const PLATFORMS = ["windows", "macos", "ios", "ipados", "linux"] as const;
export type PublishPlatform = (typeof PLATFORMS)[number];
export const FORMATS = ["exe", "msi", "msix", "zip", "dmg", "pkg", "ipa", "deb", "rpm", "appimage"] as const;
export type PublishFormat = (typeof FORMATS)[number];

/** Allowed platform → formats, with the file extension each format must have. */
export const ALLOWED: Record<PublishPlatform, Partial<Record<PublishFormat, string>>> = {
  windows: { exe: ".exe", msi: ".msi", msix: ".msix", zip: ".zip" },
  macos: { zip: ".zip", dmg: ".dmg", pkg: ".pkg" },
  // .deb on iOS/iPadOS: jailbreak packages delivered through HCG Repo (Sileo), never the App Store.
  ios: { ipa: ".ipa", deb: ".deb" },
  ipados: { ipa: ".ipa", deb: ".deb" },
  linux: { deb: ".deb", rpm: ".rpm", appimage: ".appimage" },
};

/** What a file is, decided by the Store from its content (the uploader's declaration is only compared with it). */
export const KINDS = ["installer", "portable-app", "device-build", "simulator-build", "jailbreak-package"] as const;
export type ArtifactKind = (typeof KINDS)[number];
/** iOS provisioning, read from Payload/<app>.app/embedded.mobileprovision (the signed profile is not verified here). */
export type Provisioning = "development" | "ad-hoc" | "enterprise" | "app-store" | "none" | "unreadable";

export const CONTENT_TYPES: Record<PublishFormat, string> = {
  exe: "application/vnd.microsoft.portable-executable",
  msi: "application/x-msi",
  msix: "application/msix",
  zip: "application/zip",
  dmg: "application/x-apple-diskimage",
  pkg: "application/octet-stream",
  ipa: "application/octet-stream",
  deb: "application/vnd.debian.binary-package",
  rpm: "application/x-rpm",
  appimage: "application/octet-stream",
};

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+()~-]{0,199}$/;

/** Checks of the declared metadata (before any byte is uploaded). Returns problems; empty = acceptable. */
export function checkDeclaration(d: { fileName: string; platform: string; format: string; sizeBytes: number; maxBytes: number }): string[] {
  const problems: string[] = [];
  if (!FILE_NAME.test(d.fileName) || d.fileName.includes("..")) {
    problems.push("The file name must be a plain name (letters, digits, . _ + ( ) ~ -), without folders, spaces or \"..\".");
  }
  if (!(PLATFORMS as readonly string[]).includes(d.platform)) problems.push(`Unsupported platform "${d.platform}".`);
  else {
    const ext = ALLOWED[d.platform as PublishPlatform][d.format as PublishFormat];
    if (!ext) problems.push(`${d.format} is not a supported format for ${d.platform}. Supported: ${Object.keys(ALLOWED[d.platform as PublishPlatform]).join(", ")}.`);
    else if (!d.fileName.toLowerCase().endsWith(ext)) problems.push(`A ${d.format} file must end in ${ext}.`);
  }
  if (!Number.isInteger(d.sizeBytes) || d.sizeBytes <= 0) problems.push("The file size must be a positive number of bytes.");
  else if (d.sizeBytes > d.maxBytes) problems.push(`The file is larger than the Store's limit (${d.maxBytes} bytes).`);
  return problems;
}

export interface ContentReport {
  ok: boolean;
  problems: string[];
  notes: string[];
  /** "present" when a signature structure exists in the file; never "verified". */
  signature: "present" | "absent" | "not-checked";
  /** Debian control fields, when readable. */
  debian?: { package?: string; version?: string; architecture?: string; controlReadable: boolean };
  zipEntries?: number;
  kind?: ArtifactKind;
  /** iOS IPA facts read from the bundle. */
  ios?: { simulator: boolean; provisioning: Provisioning; profileName?: string; profileExpires?: string };
}

/** Kind implied by format alone (IPAs and .debs need their content: see inspectContent). */
export function kindFromFormat(platform: string, format: string): ArtifactKind | null {
  if (format === "ipa") return "device-build";
  if (format === "deb") return platform === "ios" || platform === "ipados" ? "jailbreak-package" : "installer";
  if (format === "zip" || format === "appimage") return "portable-app";
  return ["exe", "msi", "msix", "dmg", "pkg", "rpm"].includes(format) ? "installer" : null;
}

export interface Readiness {
  /** ready · not-notarized · signature-not-verified · unsigned · registered-devices-only · enterprise-devices-only ·
   *  app-store-profile · not-installable · simulator-only · jailbroken-devices-only */
  status: string;
  /** Plain-language label for publishers, approvers and customers. */
  label: string;
  /** True only when the file can be installed on an ordinary device of its platform as it is. */
  ordinaryInstall: boolean;
}

/**
 * Install readiness from what the Store found (kind, signature structure, iOS profile) and what the uploader reported
 * (its own signature/notarisation check). Conservative: anything unsigned, Simulator-only or jailbreak-only is never
 * "ready", and a signature the Store could only see is "present, not verified" unless the uploader verified it.
 */
export function installReadiness(platform: string, kind: ArtifactKind | undefined, signature: ContentReport["signature"], reported: string, ios?: ContentReport["ios"]): Readiness {
  const r = (status: string, label: string, ordinaryInstall = false): Readiness => ({ status, label, ordinaryInstall });
  if (kind === "simulator-build") return r("simulator-only", "iOS Simulator build: runs only in the Simulator on a Mac. Cannot be installed on an iPhone or iPad.");
  if (kind === "jailbreak-package") return r("jailbroken-devices-only", "Jailbreak package: installs only on jailbroken iPhones/iPads through a package manager (Sileo). Not for ordinary devices.");
  if (kind === "device-build") {
    if (signature === "absent" || reported === "unsigned") return r("unsigned", "Unsigned iOS device build: cannot be installed on an iPhone or iPad until it is signed with a provisioning profile.");
    if (reported === "invalid") return r("unsigned", "The uploader's check found the signature INVALID: not installable.");
    switch (ios?.provisioning) {
      case "development": return r("registered-devices-only", "Development-signed: installs only on the devices registered in its provisioning profile.");
      case "ad-hoc": return r("registered-devices-only", "Ad hoc-signed: installs only on the devices listed in its provisioning profile.");
      case "enterprise": return r("enterprise-devices-only", "In-house (enterprise) signed: installs on devices that trust the organisation's certificate.");
      case "app-store": return r("app-store-profile", "Signed for App Store distribution: iPhones and iPads install it only through the App Store or TestFlight, which HCG never submits to.");
      case "none": return r("not-installable", "Signed without a provisioning profile: not installable on ordinary iPhones or iPads.");
      default: return r("signature-not-verified", "A signature is present but its provisioning profile could not be read: installability unknown.");
    }
  }
  if (platform === "linux") return r("ready", "Linux package: no platform signature is required to install it.", true);
  if (signature === "absent" || reported === "unsigned") {
    return r("unsigned", platform === "macos"
      ? "Unsigned: macOS Gatekeeper blocks it on other Macs."
      : "Unsigned: Windows SmartScreen warns before it runs; some organisations block unsigned software.");
  }
  if (reported === "invalid") return r("unsigned", "The uploader's check found the signature INVALID.");
  if (platform === "macos") {
    if (reported === "notarized") return r("ready", "Developer ID signed and notarized (reported by the uploader's macOS check).", true);
    if (reported === "signed") return r("not-notarized", "Signed but not notarized: Gatekeeper warns or blocks it on other Macs.");
    return r("signature-not-verified", "A signature structure is present; signature and notarisation were not verified.");
  }
  if (reported === "signed") return r("ready", "Signed (verified by the uploader's Windows check).", true);
  return r("signature-not-verified", signature === "present" ? "A signature is present but was not verified." : "Signature not checked.");
}

class Reader {
  readonly size: number;
  private readonly fd: number;
  constructor(file: string) {
    this.fd = openSync(file, "r");
    this.size = fstatSync(this.fd).size;
  }
  read(offset: number, length: number): Buffer {
    const len = Math.max(0, Math.min(length, this.size - offset));
    const buf = Buffer.alloc(len);
    if (len) readSync(this.fd, buf, 0, len, offset);
    return buf;
  }
  close() {
    closeSync(this.fd);
  }
}

const LIMITS = { maxEntries: 200_000, maxRatio: 200, maxTotalUncompressed: 64 * 1024 ** 3 };

interface ZipEntry {
  name: string;
  compressed: number;
  uncompressed: number;
  method: number;
  flags: number;
  unixMode: number;
  localOffset: number;
}

/** Central directory of a ZIP (ZIP64 aware). Throws with a readable reason when malformed. */
function readZip(r: Reader): ZipEntry[] {
  const tailLen = Math.min(r.size, 65_557);
  const tail = r.read(r.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record).");
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error("ZIP64 archive without a ZIP64 locator.");
    const z64 = Number(tail.readBigUInt64LE(loc + 8));
    const rec = r.read(z64, 56);
    if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error("ZIP64 end record not found.");
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  if (count > LIMITS.maxEntries) throw new Error(`too many entries (${count}).`);
  if (cdOffset + cdSize > r.size) throw new Error("central directory lies outside the file.");
  const cd = r.read(cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error("malformed central directory.");
    const madeBy = cd.readUInt16LE(p + 4) >> 8;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compressed = cd.readUInt32LE(p + 20);
    let uncompressed = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const external = cd.readUInt32LE(p + 38);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressed === 0xffffffff) { uncompressed = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (compressed === 0xffffffff) { compressed = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    entries.push({ name, compressed, uncompressed, method, flags, unixMode: madeBy === 3 ? external >>> 16 : 0, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function unsafeName(name: string): string | null {
  if (!name) return "an entry has an empty name";
  if (/[\u0000-\u001f]/.test(name)) return `"${JSON.stringify(name)}" contains control characters`;
  if (name.includes("\\")) return `"${name}" uses a backslash`;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return `"${name}" is an absolute path`;
  if (name.split("/").some((s) => s === "..")) return `"${name}" leaves the archive ("..")`;
  return null;
}

function checkZipEntries(entries: ZipEntry[], problems: string[]) {
  let total = 0;
  for (const e of entries) {
    const bad = unsafeName(e.name);
    if (bad) problems.push(`Unsafe archive entry: ${bad}.`);
    if ((e.unixMode & 0o170000) === 0o120000) problems.push(`Archive entry "${e.name}" is a symbolic link.`);
    if (e.flags & 0x1) problems.push(`Archive entry "${e.name}" is encrypted.`);
    if (e.compressed > 0 && e.uncompressed / e.compressed > LIMITS.maxRatio && e.uncompressed > 1024 * 1024) {
      problems.push(`Archive entry "${e.name}" expands ${Math.round(e.uncompressed / e.compressed)}× (possible decompression bomb).`);
    }
    total += e.uncompressed;
  }
  if (total > LIMITS.maxTotalUncompressed) problems.push("The archive expands beyond the Store's limit.");
}

/** Reads one entry's bytes (stored or deflate), for small metadata files only. */
function readZipEntry(r: Reader, e: ZipEntry, max = 4 * 1024 * 1024): Buffer | null {
  if (e.uncompressed > max) return null;
  const local = r.read(e.localOffset, 30);
  if (local.readUInt32LE(0) !== 0x04034b50) return null;
  const start = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const data = r.read(start, e.compressed);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: max });
  return null;
}

function ar(r: Reader): { name: string; offset: number; size: number }[] {
  if (r.read(0, 8).toString("latin1") !== "!<arch>\n") throw new Error("not a Debian package (no ar header).");
  const members: { name: string; offset: number; size: number }[] = [];
  let p = 8;
  while (p + 60 <= r.size && members.length < 16) {
    const h = r.read(p, 60).toString("latin1");
    const name = h.slice(0, 16).trim().replace(/\/$/, "");
    const size = Number.parseInt(h.slice(48, 58).trim(), 10);
    if (!Number.isFinite(size) || size < 0) throw new Error("malformed ar member header.");
    members.push({ name, offset: p + 60, size });
    p += 60 + size + (size % 2);
  }
  return members;
}

function tarFile(tar: Buffer, wanted: (name: string) => boolean): Buffer | null {
  for (let p = 0; p + 512 <= tar.length; ) {
    const name = tar.subarray(p, p + 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const size = Number.parseInt(tar.subarray(p + 124, p + 136).toString("latin1").replace(/\0.*$/s, "").trim() || "0", 8);
    if (wanted(name)) return tar.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Validates file content against the declared format. */
export function inspectContent(file: string, platform: PublishPlatform, format: PublishFormat): ContentReport {
  const problems: string[] = [];
  const notes: string[] = [];
  let signature: ContentReport["signature"] = "not-checked";
  const report: ContentReport = { ok: false, problems, notes, signature };
  const r = new Reader(file);
  try {
    const head = r.read(0, 64);
    switch (format) {
      case "exe": {
        if (head.subarray(0, 2).toString("latin1") !== "MZ") { problems.push("Not a Windows executable (no MZ header)."); break; }
        const pe = head.length >= 64 ? head.readUInt32LE(60) : 0;
        const peHead = r.read(pe, 24 + 240);
        if (peHead.subarray(0, 4).toString("latin1") !== "PE\0\0") { problems.push("Not a Windows executable (no PE header)."); break; }
        const magic = peHead.readUInt16LE(24);
        const dirBase = 24 + (magic === 0x20b ? 112 : 96);
        const certSize = peHead.length >= dirBase + 4 * 8 + 8 ? peHead.readUInt32LE(dirBase + 4 * 8 + 4) : 0;
        signature = certSize > 0 ? "present" : "absent";
        break;
      }
      case "msi":
        if (!head.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) problems.push("Not a Windows Installer package (no compound-file header).");
        break;
      case "dmg": {
        const trailer = r.read(r.size - 512, 4).toString("latin1");
        if (trailer !== "koly") problems.push("Not a macOS disk image (no UDIF trailer).");
        break;
      }
      case "pkg": {
        if (head.subarray(0, 4).toString("latin1") !== "xar!") { problems.push("Not a macOS installer package (no xar header)."); break; }
        const tocCompressed = Number(head.readBigUInt64LE(8));
        const toc = r.read(head.readUInt16LE(4), tocCompressed);
        try {
          const xml = inflateSync(toc, { maxOutputLength: 16 * 1024 * 1024 }).toString("utf8");
          signature = /<signature\b|<x-signature\b/.test(xml) ? "present" : "absent";
        } catch {
          notes.push("The package's table of contents could not be read; signature presence not checked.");
        }
        break;
      }
      case "rpm":
        if (!head.subarray(0, 4).equals(Buffer.from("edabeedb", "hex"))) problems.push("Not an RPM package (no lead magic).");
        break;
      case "appimage":
        if (head.subarray(0, 4).toString("latin1") !== "\x7fELF" || head.subarray(8, 11).toString("latin1") !== "AI\x02") {
          problems.push("Not a type-2 AppImage (ELF with the AppImage magic).");
        }
        break;
      case "deb": {
        const members = ar(r);
        if (members[0]?.name !== "debian-binary") problems.push("The first ar member must be debian-binary.");
        const control = members.find((m) => m.name.startsWith("control.tar"));
        const data = members.find((m) => m.name.startsWith("data.tar"));
        if (!control || !data) { problems.push("A Debian package needs control.tar.* and data.tar.* members."); break; }
        report.debian = { controlReadable: false };
        if (control.name === "control.tar.gz" && control.size < 8 * 1024 * 1024) {
          const tar = gunzipSync(r.read(control.offset, control.size), { maxOutputLength: 32 * 1024 * 1024 });
          const text = tarFile(tar, (n) => n === "./control" || n === "control")?.toString("utf8");
          if (text) {
            const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "mi").exec(text)?.[1]?.trim();
            report.debian = { package: field("Package"), version: field("Version"), architecture: field("Architecture"), controlReadable: true };
            const jailbreak = report.debian.architecture?.startsWith("iphoneos-") === true;
            const iosPlatform = platform === "ios" || platform === "ipados";
            if (jailbreak && !iosPlatform) problems.push(`Architecture ${report.debian.architecture} is a jailbreak package for iOS, not a Linux package: declare it for iOS.`);
            if (!jailbreak && iosPlatform && report.debian.architecture) problems.push(`Architecture ${report.debian.architecture} is not an iOS jailbreak architecture (iphoneos-arm, iphoneos-arm64, iphoneos-arm64e).`);
          }
        } else {
          notes.push(`The control file is in ${control.name}; HCG Store reads only gzip control archives, so Package/Version/Architecture were not verified here.`);
        }
        break;
      }
      case "zip":
      case "ipa":
      case "msix": {
        let entries: ZipEntry[];
        try { entries = readZip(r); } catch (e) { problems.push(`Not a valid ZIP-based ${format}: ${(e as Error).message}`); break; }
        report.zipEntries = entries.length;
        checkZipEntries(entries, problems);
        if (format === "ipa") {
          const app = entries.find((e) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.name));
          if (!app) problems.push("An IPA must contain Payload/<name>.app/Info.plist.");
          if (entries.some((e) => !e.name.startsWith("Payload/") && !/^(Symbols|SwiftSupport|BCSymbolMaps|META-INF)\//.test(e.name) && e.name !== "iTunesMetadata.plist" && e.name !== "iTunesArtwork")) {
            problems.push("An IPA may contain only Payload/ (and Apple's Symbols, SwiftSupport, BCSymbolMaps, META-INF).");
          }
          signature = entries.some((e) => /^Payload\/[^/]+\.app\/_CodeSignature\/CodeResources$/.test(e.name)) ? "present" : "absent";
          report.kind = "device-build";
          if (app) {
            // XML and binary plists both store ASCII strings as-is, so the platform names can be found in either.
            const info = readZipEntry(r, app)?.toString("latin1");
            const simulator = info !== undefined && /iPhoneSimulator|iphonesimulator|XRSimulator|xrsimulator/.test(info);
            const profileEntry = entries.find((e) => e.name === app.name.replace(/Info\.plist$/, "embedded.mobileprovision"));
            report.ios = { simulator, provisioning: profileEntry ? "unreadable" : "none" };
            if (profileEntry) {
              const xml = /<\?xml[\s\S]*?<\/plist>/.exec(readZipEntry(r, profileEntry, 1024 * 1024)?.toString("latin1") ?? "")?.[0];
              if (xml) {
                const flag = (k: string) => new RegExp(`<key>${k}</key>\\s*<true\\s*/>`).test(xml);
                const str = (k: string) => new RegExp(`<key>${k}</key>\\s*<(?:string|date)>([^<]*)<`).exec(xml)?.[1];
                report.ios.provisioning = flag("ProvisionsAllDevices") ? "enterprise" : xml.includes("<key>ProvisionedDevices</key>") ? (flag("get-task-allow") ? "development" : "ad-hoc") : "app-store";
                report.ios.profileName = str("Name");
                report.ios.profileExpires = str("ExpirationDate");
              }
            }
            if (simulator) {
              report.kind = "simulator-build";
              problems.push("This is an iOS Simulator build (its Info.plist names the Simulator platform). It runs only in the iOS Simulator on a Mac and cannot be installed on an iPhone or iPad, so HCG Store does not accept it. Build for a device (archive → IPA) instead.");
            }
          }
        } else if (format === "msix") {
          if (!entries.some((e) => e.name === "AppxManifest.xml")) problems.push("An MSIX package must contain AppxManifest.xml.");
          signature = entries.some((e) => e.name === "AppxSignature.p7x") ? "present" : "absent";
        } else if (platform === "macos") {
          const apps = new Set(entries.map((e) => /^([^/]+\.app)\//.exec(e.name)?.[1]).filter(Boolean));
          if (apps.size === 0) problems.push("A macOS ZIP must contain an .app bundle at its top level.");
          signature = entries.some((e) => /^[^/]+\.app\/Contents\/_CodeSignature\/CodeResources$/.test(e.name)) ? "present" : "absent";
          if (!entries.some((e) => /^[^/]+\.app\/Contents\/Info\.plist$/.test(e.name))) problems.push("The .app bundle has no Contents/Info.plist.");
          const plist = entries.find((e) => /^[^/]+\.app\/Contents\/Info\.plist$/.test(e.name));
          if (plist && readZipEntry(r, plist) === null) notes.push("Info.plist could not be read (compression method).");
        }
        break;
      }
    }
  } catch (e) {
    problems.push(`The file could not be inspected: ${(e as Error).message}`);
  } finally {
    r.close();
  }
  report.signature = signature;
  report.kind ??= kindFromFormat(platform, format) ?? undefined;
  report.ok = problems.length === 0;
  return report;
}
