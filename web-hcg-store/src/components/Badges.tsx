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
