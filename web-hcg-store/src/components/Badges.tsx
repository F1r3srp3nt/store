import { AVAILABILITY_LABELS, type Availability } from "../domain/model";
import type { PlatformEntry } from "../domain/schema";
import { DEVELOPMENT_STATUS, PLATFORMS, PLATFORM_SUPPORT, RELEASE_CHANNELS, type DevelopmentStatus, type ReleaseChannel } from "../domain/taxonomy";

export function StatusBadge({ status }: { status: DevelopmentStatus }) {
  const s = DEVELOPMENT_STATUS[status];
  return (
    <span className={`badge badge--${s.tone}`}>
      <span className="badge__dot" aria-hidden="true" />
      <span className="visually-hidden">Development status: </span>
      {s.label}
    </span>
  );
}

export function AvailabilityBadge({ availability }: { availability: Availability }) {
  return (
    <span className={`badge badge--avail-${availability}`}>
      <span className="visually-hidden">Release availability: </span>
      {AVAILABILITY_LABELS[availability]}
    </span>
  );
}

export function ChannelBadge({ channel }: { channel: ReleaseChannel }) {
  return <span className={`badge badge--channel-${channel}`}>{RELEASE_CHANNELS[channel].label}</span>;
}

export function PlatformChips({ platforms, compact = false }: { platforms: PlatformEntry[]; compact?: boolean }) {
  if (!platforms.length) return <span className="platform-chip platform-chip--unknown">Platforms not stated</span>;
  return (
    <ul className="platform-chips" aria-label="Platforms">
      {platforms.map((p) => (
        <li key={p.platform} className={`platform-chip platform-chip--${p.support}`}>
          {PLATFORMS[p.platform].label}
          {!compact || p.support !== "confirmed" ? (
            <span className="platform-chip__support"> · {PLATFORM_SUPPORT[p.support].label}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * One consistent storefront status per product, combining release availability and development
 * stage: Released → Testing → In development → Planned (→ Paused / Status not stated).
 */
export function storefrontStatus(status: DevelopmentStatus, availability: Availability): { label: string; tone: string; detail: string } {
  if (availability === "released") return { label: "Released", tone: "released", detail: "An approved release exists." };
  switch (status) {
    case "testing":
      return { label: "Testing", tone: "testing", detail: "Being tested. Not released yet." };
    case "in-development":
      return { label: "In development", tone: "active", detail: "Being built. Not released yet." };
    case "planning":
      return { label: "Planned", tone: "planned", detail: "Planned. Not released yet." };
    case "paused":
      return { label: "Paused", tone: "muted", detail: "Development is paused." };
    case "maintained":
      return { label: "Maintained", tone: "released", detail: "Maintained. No release supplied to HCG Store yet." };
    default:
      return { label: "Status not stated", tone: "muted", detail: "HCG has not stated a status." };
  }
}

export function StatusPill({ status, availability }: { status: DevelopmentStatus; availability: Availability }) {
  const s = storefrontStatus(status, availability);
  return (
    <span className={`status-pill status-pill--${s.tone}`} title={s.detail}>
      <span className="status-pill__dot" aria-hidden="true" />
      {s.label}
      <span className="visually-hidden">. {s.detail}</span>
    </span>
  );
}
