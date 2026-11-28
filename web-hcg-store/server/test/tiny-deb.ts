/**
 * TEST ONLY. Builds a minimal, harmless Debian package (ar archive: debian-binary, control.tar.gz, data.tar.gz) with
 * no dependency on dpkg, so the device test kit runs on a Mac. The package installs one text file and runs no scripts.
 */
import { gzipSync } from "node:zlib";

type Entry = { path: string; data?: Buffer; dir?: boolean };

function tarHeader(name: string, size: number, type: "0" | "5", mode: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii"); // uid
  h.write("0000000\0", 116, 8, "ascii"); // gid
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write(Math.floor(Date.UTC(2026, 10, 27) / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii"); // checksum placeholder
  h.write(type, 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write("root", 265, 32, "ascii");
  h.write("wheel", 297, 32, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

function tarGz(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (e.dir) parts.push(tarHeader(e.path.endsWith("/") ? e.path : `${e.path}/`, 0, "5", 0o755));
    else {
      const data = e.data ?? Buffer.alloc(0);
      parts.push(tarHeader(e.path, data.length, "0", 0o644), data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function arMember(name: string, data: Buffer): Buffer {
  const h = Buffer.alloc(60, " ");
  h.write(name.padEnd(16, " "), 0, 16, "ascii");
  h.write(String(Math.floor(Date.UTC(2026, 10, 27) / 1000)).padEnd(12, " "), 16, 12, "ascii");
  h.write("0".padEnd(6, " "), 28, 6, "ascii");
  h.write("0".padEnd(6, " "), 34, 6, "ascii");
  h.write("100644".padEnd(8, " "), 40, 8, "ascii");
  h.write(String(data.length).padEnd(10, " "), 48, 10, "ascii");
  h.write("`\n", 58, 2, "ascii");
  return Buffer.concat([h, data, data.length % 2 ? Buffer.from("\n") : Buffer.alloc(0)]);
}

/** A rootless (iphoneos-arm64) TEST package that installs /var/jb/usr/share/doc/<package>/README.txt and nothing else. */
export function buildTestDeb(opts: { pkg: string; version: string; name: string; architecture?: string }): Buffer {
  const arch = opts.architecture ?? "iphoneos-arm64";
  const prefix = arch === "iphoneos-arm64" ? "./var/jb/usr/share/doc" : "./usr/share/doc";
  const control = [
    `Package: ${opts.pkg}`,
    `Version: ${opts.version}`,
    `Architecture: ${arch}`,
    "Maintainer: Hakmi Capital Group",
    "Author: Hakmi Capital Group",
    `Name: ${opts.name}`,
    "Section: Tweaks",
    "Description: TEST PACKAGE for HCG Store's Sileo payment-provider qualification. Installs one text file; safe to remove.",
    "",
  ].join("\n");
  const readme = Buffer.from(
    `${opts.name} ${opts.version}\n\nTEST package installed through HCG Store's payment provider (TEST mode, no money moved).\nIt contains only this file. Remove it in Sileo whenever you like.\n`,
  );
  const dirs = prefix.split("/").slice(1).map((_, i, a) => `./${a.slice(0, i + 1).join("/")}`);
  const data = tarGz([{ path: "./", dir: true }, ...dirs.map((d) => ({ path: d, dir: true })), { path: `${prefix}/${opts.pkg}`, dir: true }, { path: `${prefix}/${opts.pkg}/README.txt`, data: readme }]);
  const ctl = tarGz([{ path: "./", dir: true }, { path: "./control", data: Buffer.from(control) }]);
  return Buffer.concat([Buffer.from("!<arch>\n"), arMember("debian-binary", Buffer.from("2.0\n")), arMember("control.tar.gz", ctl), arMember("data.tar.gz", data)]);
}
