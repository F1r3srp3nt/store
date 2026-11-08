import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { runtimeConfig } from "../config/runtime";

interface Props {
  title: string;
  description?: string;
  /** Force noindex (e.g. not-found pages) even in an indexable production build. */
  noindex?: boolean;
}

const DEFAULT_DESCRIPTION = "HCG Store: applications and developer tools from Hakmi Capital Group.";

/**
 * Sets the document title, description, robots and canonical tags. A canonical URL is emitted
 * ONLY for an explicit production build that allows indexing and has a configured public origin.
 */
export function PageMeta({ title, description, noindex }: Props) {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = title === "HCG Store" ? title : `${title} · HCG Store`;
    setMeta("description", description ?? DEFAULT_DESCRIPTION);

    const { indexingAllowed, publicOrigin } = runtimeConfig.deployment;
    if (!indexingAllowed || noindex) setMeta("robots", "noindex, nofollow");
    else removeMeta("robots");

    let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (indexingAllowed && publicOrigin && !noindex) {
      if (!link) {
        link = document.createElement("link");
        link.rel = "canonical";
        document.head.appendChild(link);
      }
      link.href = `${publicOrigin}${import.meta.env.BASE_URL.replace(/\/$/, "")}${pathname}`;
    } else {
      link?.remove();
    }
  }, [title, description, noindex, pathname]);
  return null;
}

function setMeta(name: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

function removeMeta(name: string) {
  document.head.querySelector(`meta[name="${name}"]`)?.remove();
}
