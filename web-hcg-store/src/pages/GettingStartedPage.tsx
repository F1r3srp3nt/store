import { Link } from "react-router-dom";
import { useStoreHealth } from "../account/useStoreHealth";
import { useCatalogueState } from "../app/catalogue-context";
import { listedProducts } from "../domain/model";
import { IconInfo, IconShield } from "../components/Icons";
import { PageMeta } from "../components/PageMeta";
import { CHECKSUM_COMMANDS } from "../domain/install-guidance";

const SECTIONS = [
  ["how-downloads-work", "How downloads work"],
  ["verify", "Verify a download"],
  ["platforms", "Platform notes"],
  ["security", "Security principles"],
  ["accounts", "Accounts and access"],
] as const;

export function GettingStartedPage() {
  const health = useStoreHealth();
  const cat = useCatalogueState();
  const h = health.status === "ready" ? health.health : null;
  const anonymous =
    h && h.protectedDownloads !== "disabled" && cat.status === "ready"
      ? (h.anonymousFreeProducts ?? []).map((id) => listedProducts(cat.catalogue).find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p)
      : [];
  return (
    <>
      <PageMeta title="Getting started" description="How access and downloads work in HCG Store, how to verify a file, and platform-specific installation notes." />
      <div className="page-width page-pad">
        <header className="page-head">
          <p className="eyebrow eyebrow--accent">Guide</p>
          <h1>Getting started</h1>
          <p className="page-head__lead">How downloads work, how to check a file before you open it, and what to expect on each platform.</p>
        </header>

        <div className="doc-layout">
          <nav className="toc" aria-label="On this page">
            <p className="eyebrow">On this page</p>
            <ol>
              {SECTIONS.map(([id, label]) => (
                <li key={id}>
                  <a href={`#${id}`}>{label}</a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="doc">
            <section id="how-downloads-work" aria-labelledby="h-how">
              <h2 id="h-how">How downloads work</h2>
              <ol className="steps">
                <li>
                  <strong>Find the product.</strong> Each product page shows its development status and, separately, whether HCG has published an approved
                  release.
                </li>
                <li>
                  <strong>Check the release panel.</strong> When a release exists, you will see its version, channel, files, sizes and any published SHA-256
                  checksum. If it says <em>Coming soon</em>, there is nothing to download yet.
                </li>
                <li>
                  <strong>Sign in where needed.</strong> Free releases HCG approves for it download without an account, and the product page says so
                  {anonymous.length > 0 && (
                    <>
                      {" "}(today:{" "}
                      {anonymous.map((p, i) => (
                        <span key={p.slug}>
                          {i > 0 && ", "}
                          <Link to={`/apps/${p.slug}`}>{p.name}</Link>
                        </span>
                      ))}
                      )
                    </>
                  )}
                  . Other
                  downloads need your HCG account, and paid or licensed products also require ownership that HCG has confirmed. HCG Store checks this on
                  its server every time; files are never published at public links.
                </li>
                <li>
                  <strong>Download or install.</strong> Owners download from the product page. Jailbreak packages are installed through HCG Repo, linked from
                  the product page.
                </li>
              </ol>
              {health.status === "ready" && health.health.protectedDownloads === "disabled" && (
                <p className="notice">
                  <IconInfo className="inline-icon" /> Downloads are switched off on this site right now.
                </p>
              )}
              <p className="notice">
                <IconInfo className="inline-icon" /> Purchases are not open yet: nothing can be bought or charged in HCG Store today.
              </p>
            </section>

            <section id="verify" aria-labelledby="h-verify">
              <h2 id="h-verify">Verify a download</h2>
              <p>
                When a release lists a SHA-256 checksum, compute the checksum of the file you downloaded and compare the two. If they differ, do not open
                the file.
              </p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">System</th>
                      <th scope="col">Command (replace the file name)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CHECKSUM_COMMANDS.map((c) => (
                      <tr key={c.platform}>
                        <th scope="row">{c.label}</th>
                        <td>
                          <code className="break">{c.command("downloaded-file.zip")}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="fine">
                A matching checksum shows the file is the one HCG published. It does not show that software is safe. Signing information on a release is
                shown as HCG stated it; HCG Store does not verify signatures.
              </p>
            </section>

            <section id="platforms" aria-labelledby="h-platforms">
              <h2 id="h-platforms">Platform notes</h2>
              <div className="platform-notes">
                <article>
                  <h3>Windows</h3>
                  <p>
                    Run installers or extract archives as described on the release. Windows SmartScreen may warn about files that are unsigned or newly
                    published. If it does, stop and confirm the checksum with HCG first.
                  </p>
                </article>
                <article>
                  <h3>macOS</h3>
                  <p>
                    Disk images (.dmg) usually contain an app to drag into Applications. Gatekeeper blocks apps that are not signed and notarised for
                    direct distribution. HCG Store will not ask you to switch Gatekeeper off.
                  </p>
                </article>
                <article>
                  <h3>Linux</h3>
                  <p>Use your distribution's standard tools for the package format listed on the release, after verifying the checksum.</p>
                </article>
                <article>
                  <h3>iPhone and iPad</h3>
                  <p>
                    Downloading an <code>.ipa</code> file does not install it, and an iPhone or iPad cannot install apps from a downloaded file. iOS apps
                    reach devices through the App Store, TestFlight or organisation-managed distribution. HCG Store will point to the route HCG
                    chooses once one exists.
                  </p>
                </article>
                <article>
                  <h3>Android</h3>
                  <p>HCG has not published Android installation guidance yet. Wait for an HCG-approved distribution route.</p>
                </article>
                <article>
                  <h3>Web</h3>
                  <p>Web products open in your browser and need no download. Their entries will link to the official HCG address once it is published.</p>
                </article>
              </div>
            </section>

            <section id="security" aria-labelledby="h-security">
              <h2 id="h-security">Security principles</h2>
              <ul className="checklist">
                <li>
                  <IconShield className="inline-icon" /> HCG Store never asks you to disable operating-system security to install software.
                </li>
                <li>
                  <IconShield className="inline-icon" /> Files are delivered only through HCG Store's server after it checks your sign-in and access. A
                  hidden button or a copied link never grants access.
                </li>
                <li>
                  <IconShield className="inline-icon" /> Download counts, ratings and reviews are not shown, because HCG Store does not collect them.
                </li>
                <li>
                  <IconShield className="inline-icon" /> Prices are shown only when HCG has set them. A purchase counts only after the payment provider
                  confirms it to HCG Store; a checkout return page proves nothing by itself.
                </li>
              </ul>
            </section>

            <section id="accounts" aria-labelledby="h-accounts">
              <h2 id="h-accounts">Accounts and access</h2>
              <p>
                You do not need an account to browse the catalogue, or to download the free releases HCG has approved for download without one. Other
                downloads, your library and purchases use your HCG account through HCG Connect, the central HCG identity service. Your HCG role never implies ownership of a product. See{" "}
                <Link to="/account">Account &amp; Connections</Link> for the current status.
              </p>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
