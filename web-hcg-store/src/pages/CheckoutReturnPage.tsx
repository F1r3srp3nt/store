import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { storeApi } from "../account/api";
import { PageMeta } from "../components/PageMeta";

type View =
  | { status: "checking" }
  | { status: "confirmed"; title: string | null; productId: string | null }
  | { status: "failed" }
  | { status: "waiting" }
  | { status: "unknown" };

const POLL_MS = 3000;
const MAX_POLLS = 40;

/**
 * Where the payment provider sends people back. Arriving here proves nothing: the page only reports
 * what HCG Store's server has recorded from the provider's verified events.
 */
export function CheckoutReturnPage() {
  const [params] = useSearchParams();
  const id = params.get("checkout") ?? "";
  const [view, setView] = useState<View>({ status: "checking" });
  // Started in Sileo or Zebra: their web-authentication session closes when the Store answers sileo://payment_completed
  // (the Store checks the purchase itself first).
  const [packageManager] = useState(() => {
    try {
      const v = sessionStorage.getItem("hcg-store.package-manager-purchase");
      return v && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v) ? v : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (view.status !== "confirmed" || !packageManager) return;
    try { sessionStorage.removeItem("hcg-store.package-manager-purchase"); } catch { /* ignore */ }
    window.location.assign(`/repo-api/v1/sileo/checkout/${packageManager}/return`);
  }, [view.status, packageManager]);

  useEffect(() => {
    if (!/^chk_[A-Za-z0-9_-]+$/.test(id)) {
      setView({ status: "unknown" });
      return;
    }
    let polls = 0;
    let timer: number | undefined;
    let live = true;
    const tick = async () => {
      try {
        const s = await storeApi.checkoutStatus(id);
        if (!live) return;
        if (s.status === "completed") return setView({ status: "confirmed", title: s.title, productId: s.productId });
        if (s.status === "failed") return setView({ status: "failed" });
        setView({ status: "waiting" });
      } catch {
        if (!live) return;
        return setView({ status: "unknown" });
      }
      if (++polls < MAX_POLLS) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [id]);

  return (
    <>
      <PageMeta title="Checkout" />
      <div className="page-width page-pad">
        <header className="page-head">
          <p className="eyebrow eyebrow--accent">Checkout</p>
          <h1>
            {view.status === "confirmed"
              ? "Purchase confirmed"
              : view.status === "failed"
                ? "Payment not completed"
                : view.status === "unknown"
                  ? "Checkout not found"
                  : "Waiting for payment confirmation"}
          </h1>
        </header>
        <div className="panel" role="status" aria-live="polite">
          {view.status === "confirmed" && (
            <>
              <p>
                The payment provider confirmed your payment{view.title ? ` for ${view.title}` : ""}, and it has been added to your HCG account.
              </p>
              {packageManager ? (
                <p>
                  <a href={`/repo-api/v1/sileo/checkout/${packageManager}/return`} className="button button--primary" data-testid="return-to-package-manager">
                    Return to the package manager
                  </a>
                </p>
              ) : (
                <p>
                  <Link to="/library" className="button button--primary">
                    Go to your library
                  </Link>
                </p>
              )}
            </>
          )}
          {view.status === "failed" && <p>The payment provider reported that the payment did not go through. Nothing was added to your account.</p>}
          {(view.status === "waiting" || view.status === "checking") && (
            <p>
              HCG Store has not received confirmation from the payment provider yet. Access is added only after that confirmation. You can leave this
              page; your library updates when the payment is confirmed.
            </p>
          )}
          {view.status === "unknown" && <p>This checkout could not be found for your account. Nothing was added to your account.</p>}
        </div>
      </div>
    </>
  );
}
