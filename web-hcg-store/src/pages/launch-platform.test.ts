import { describe, expect, it } from "vitest";
import { orderFiles, visitorPlatform } from "./ProductLaunch";

describe("launch page: visitor platform and download order", () => {
  it("recognises Mac and Windows browsers, and not an iPad asking for the desktop site", () => {
    expect(visitorPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 0 })).toBe("macos");
    expect(visitorPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 })).toBeNull();
    expect(visitorPlatform({ userAgent: "x", userAgentData: { platform: "macOS" } })).toBe("macos");
    expect(visitorPlatform({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" })).toBe("windows");
    expect(visitorPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64" })).toBeNull();
    expect(visitorPlatform(undefined)).toBeNull();
  });

  it("orders the visitor's platform first and, on macOS, the installer before the ZIP; nothing is dropped", () => {
    const f = (platform: string, format: string) => ({ id: `${platform}-${format}`, details: { platform, format } });
    const files = [f("windows", "exe"), f("macos", "zip"), f("macos", "pkg")];
    expect(orderFiles(files, "macos").map((x) => x.id)).toEqual(["macos-pkg", "macos-zip", "windows-exe"]);
    expect(orderFiles(files, "windows").map((x) => x.id)).toEqual(["windows-exe", "macos-pkg", "macos-zip"]);
    expect(orderFiles(files, null).map((x) => x.id)).toEqual(["windows-exe", "macos-pkg", "macos-zip"]);
  });
});
