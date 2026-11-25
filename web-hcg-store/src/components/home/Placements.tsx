import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { loadAnnouncements, loadPlacements, type Announcement, type Placement, type Slot } from "../../storefront/placements";
import { IconArrowRight } from "../Icons";

/** True for links on this site (client-side routing); everything else is an approved https link. */
const internal = (href: string) => href.startsWith("/") && !href.startsWith("//");

/**
 * An HCG ADS slot. Renders only creatives the central HCG ADS service approved for this slot and that are running
 * now; with none (the case until HCG ADS exists) it renders nothing at all, so the section collapses.
 */
export function PromotionSlot({ slot, heading }: { slot: Slot; heading?: string }) {
  const [items, setItems] = useState<Placement[]>([]);
  useEffect(() => {
    let live = true;
    loadPlacements(slot).then((x) => live && setItems(x));
    return () => {
      live = false;
    };
  }, [slot]);
  if (!items.length) return null;
  return (
    <section className="section page-width promo" aria-label={heading ?? "Promotions"} data-reveal>
      {heading && <h2 className="section__title">{heading}</h2>}
      <ul className="promo__list">
        {items.map((p) => (
          <li key={p.id} className="promo__item holo-border">
            {p.media.video ? (
              <video className="promo__media" src={p.media.video.src} poster={p.media.video.poster ?? undefined} muted playsInline preload="none" controls />
            ) : p.media.image ? (
              <img className="promo__media" src={p.media.image.src} srcSet={p.media.image.srcset ?? undefined} alt={p.media.image.alt} width={p.media.image.width} height={p.media.image.height} loading="lazy" decoding="async" />
            ) : null}
            <div className="promo__body">
              <span className={`promo__label${p.sponsored ? " promo__label--sponsored" : ""}`}>{p.sponsored ? "Sponsored" : "HCG"}</span>
              <h3 className="promo__title">{p.title}</h3>
              {p.body && <p>{p.body}</p>}
              {internal(p.cta.href) ? (
                <Link to={p.cta.href} className="text-link">
                  {p.cta.label} <IconArrowRight />
                </Link>
              ) : (
                <a href={p.cta.href} className="text-link" rel="noopener">
                  {p.cta.label} <IconArrowRight />
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** HCG News announcements, from HCG News only. Nothing is shown until HCG News publishes through the contract. */
export function NewsAnnouncements() {
  const [items, setItems] = useState<Announcement[]>([]);
  useEffect(() => {
    let live = true;
    loadAnnouncements().then((x) => live && setItems(x));
    return () => {
      live = false;
    };
  }, []);
  if (!items.length) return null;
  return (
    <section className="section page-width news" aria-labelledby="news-title" data-reveal>
      <p className="eyebrow">HCG News</p>
      <h2 id="news-title" className="section__title">
        Announcements
      </h2>
      <ul className="news__list">
        {items.map((a) => (
          <li key={a.id} className="news__item">
            <time dateTime={a.publishedAt}>{new Date(a.publishedAt).toLocaleDateString("en-GB", { dateStyle: "medium" })}</time>
            <h3>{internal(a.href) ? <Link to={a.href}>{a.title}</Link> : <a href={a.href}>{a.title}</a>}</h3>
            <p>{a.summary}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
