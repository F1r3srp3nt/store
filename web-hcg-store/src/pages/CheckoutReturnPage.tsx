import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { storeApi } from "../account/api";
import { PageMeta } from "../components/PageMeta";

type View =
  | { status: "checking" }
  | { status: "confirmed"; title: string | null; productId: string | null }
  | { status: "failed" }
  | { status: "cancelled" }
  | { status: "refunded" }
  | { status: "granting"; title: string | null }
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
        // HCG Payments: payment confirmed, but HCG's licensing has not recorded it yet. Keep checking.
        if (s.status === "completed" && s.fulfilment && s.fulfilment !== "granted") setView({ status: "granting", title: s.title });
        else if (s.status === "completed") return setView({ status: "confirmed", title: s.title, productId: s.productId });
        else if (s.status === "failed") return setView({ status: "failed" });
        else if (s.status === "cancelled") return setView({ status: "cancelled" });
        else if (s.status === "refunded") return setView({ status: "refunded" });
        else setView({ status: "waiting" });
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
                : view.status === "cancelled"
                  ? "Checkout cancelled"
                  : view.status === "refunded"
                    ? "Payment refunded"
                    : view.status === "granting"
                      ? "Payment confirmed"
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
              <p>
                <Link to="/library" className="button button--primary">
                  Go to your library
                </Link>
              </p>
            </>
          )}
          {view.status === "failed" && <p>The payment provider reported that the payment did not go through. Nothing was added to your account.</p>}
          {view.status === "cancelled" && <p>The checkout was cancelled or expired before payment. Nothing was charged and nothing was added to your account.</p>}
          {view.status === "refunded" && <p>This payment was refunded or reversed, so the product is no longer included in your HCG account.</p>}
          {view.status === "granting" && (
            <p>
              The payment provider confirmed your payment{view.title ? ` for ${view.title}` : ""}. HCG is adding it to your account; this page updates when
              that is done.
            </p>
          )}
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
