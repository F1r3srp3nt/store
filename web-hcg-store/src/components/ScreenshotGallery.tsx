import { useState } from "react";
import type { Media } from "../domain/schema";
import { PLATFORMS } from "../domain/taxonomy";
import { MediaImage } from "./MediaImage";

const HEADLESS = "headless-render";

/**
 * Genuine screenshots, grouped by the platform each capture ran on. With captures from more than one platform the
 * visitor picks one; a headless render that is not a capture of a particular operating system is listed as such.
 * Illustrations are never mixed in here (the product page labels them separately).
 */
export function ScreenshotGallery({ screenshots, eagerLead }: { screenshots: Media[]; eagerLead: boolean }) {
  const groups: string[] = [...new Set<string>(screenshots.map((m) => m.platform ?? HEADLESS))];
  const [selected, setSelected] = useState<string>(groups[0] ?? HEADLESS);
  if (screenshots.length === 0) return null;
  const active = groups.includes(selected) ? selected : groups[0]!;
  const shown = screenshots.filter((m) => (m.platform ?? HEADLESS) === active);
  const label = (g: string) => (g === HEADLESS ? "Headless render" : PLATFORMS[g as keyof typeof PLATFORMS].label);
  const [lead, ...rest] = shown;
  return (
    <>
      {groups.length > 1 && (
        <div className="gallery-platforms" role="group" aria-label="Screenshots by platform">
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              className="gallery-platforms__button"
              aria-pressed={g === active}
              onClick={() => setSelected(g)}
            >
              {label(g)} <span className="gallery-platforms__count">{screenshots.filter((m) => (m.platform ?? HEADLESS) === g).length}</span>
            </button>
          ))}
        </div>
      )}
      {lead && (
        <figure className="gallery-lead" key={lead.src}>
          <div className="product-cover product-cover--shot">
            <div className="screen-frame">
              <MediaImage media={lead} sizes="(max-width: 1000px) 92vw, 760px" eager={eagerLead} />
            </div>
            <span className="art-label">Screenshot</span>
          </div>
          <figcaption>
            {lead.caption}
            <ShotFacts media={lead} />
          </figcaption>
        </figure>
      )}
      {rest.length > 0 && (
        <ul className="gallery-strip">
          {rest.map((m) => (
            <li key={m.src}>
              <figure className="gallery-strip__item">
                <div className="screen-frame">
                  <MediaImage media={m} sizes="(max-width: 700px) 92vw, 360px" />
                </div>
                <figcaption>
                  {m.caption}
                  <ShotFacts media={m} />
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ShotFacts({ media }: { media: Media }) {
  if (!media.platform && !media.appVersion) return null;
  return (
    <span className="shot-facts">
      {media.platform ? PLATFORMS[media.platform].label : null}
      {media.platform && media.appVersion ? " · " : null}
      {media.appVersion ? `version ${media.appVersion}` : null}
    </span>
  );
}
