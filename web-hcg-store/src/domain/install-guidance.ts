import type { ArtifactFormat, PlatformId } from "./taxonomy";

/**
 * Installation guidance per artifact format. Statements are deliberately conservative:
 * they never tell people to disable operating-system security.
 */
export interface InstallGuidance {
  title: string;
  steps: string[];
  cautions: string[];
}

const DO_NOT_BYPASS =
  "If your operating system blocks or warns about the file, stop. Do not disable security features. Contact HCG and confirm the checksum first.";

export function installGuidance(format: ArtifactFormat): InstallGuidance {
  switch (format) {
    case "zip":
      return {
        title: "ZIP archive",
        steps: ["Verify the SHA-256 checksum if one is published.", "Extract the archive to a folder you control.", "Follow the README or instructions included in the archive."],
        cautions: [DO_NOT_BYPASS],
      };
    case "exe":
    case "msi":
    case "msix":
      return {
        title: "Windows package",
        steps: ["Verify the SHA-256 checksum if one is published.", "Open the downloaded file and follow the installer."],
        cautions: [
          "Windows SmartScreen may warn about unsigned or newly published files.",
          DO_NOT_BYPASS,
        ],
      };
    case "dmg":
    case "pkg":
      return {
        title: "macOS package",
        steps: [
          "Verify the SHA-256 checksum if one is published.",
          format === "dmg" ? "Open the disk image and drag the app to Applications." : "Open the package and follow the installer.",
        ],
        cautions: ["macOS Gatekeeper blocks apps that are not signed and notarised for direct distribution.", DO_NOT_BYPASS],
      };
    case "ipa":
      return {
        title: "iOS app archive (.ipa)",
        steps: [
          "Downloading an .ipa file does not install it. An iPhone or iPad cannot install an app from a downloaded file.",
          "iOS apps are installed through the App Store, TestFlight, or a distribution method managed by your organisation.",
          "Use the distribution route HCG announces for this app. HCG Store will link to it when one exists.",
        ],
        cautions: ["Do not use tools or profiles that bypass iOS security to install apps."],
      };
    case "apk":
      return {
        title: "Android package (.apk)",
        steps: ["HCG Store does not yet provide Android installation guidance. Wait for an HCG-approved distribution route."],
        cautions: [DO_NOT_BYPASS],
      };
    case "appimage":
    case "deb":
    case "rpm":
    case "tar.gz":
      return {
        title: "Linux package",
        steps: ["Verify the SHA-256 checksum if one is published.", "Install or run the package using your distribution's standard tools."],
        cautions: [DO_NOT_BYPASS],
      };
  }
}

/** Accurate, built-in commands for computing a SHA-256 checksum. */
export const CHECKSUM_COMMANDS: { platform: PlatformId; label: string; command: (file: string) => string }[] = [
  { platform: "windows", label: "Windows (PowerShell)", command: (f) => `Get-FileHash -Algorithm SHA256 ".\\${f}"` },
  { platform: "macos", label: "macOS (Terminal)", command: (f) => `shasum -a 256 "${f}"` },
  { platform: "linux", label: "Linux", command: (f) => `sha256sum "${f}"` },
];
