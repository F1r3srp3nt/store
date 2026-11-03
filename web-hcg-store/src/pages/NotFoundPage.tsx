import { Link } from "react-router-dom";
import { PageMeta } from "../components/PageMeta";

export function NotFoundContent({ what = "page" }: { what?: "page" | "product" }) {
  return (
    <>
      <PageMeta title={what === "product" ? "Product not found" : "Page not found"} noindex />
      <div className="page-width page-pad">
        <div className="empty empty--large">
          <p className="eyebrow eyebrow--accent">404</p>
          <h1>{what === "product" ? "Product not found" : "Page not found"}</h1>
          <p>{what === "product" ? "There is no product with this address in the HCG Store catalogue." : "This address does not exist in HCG Store."}</p>
          <div className="hero__actions">
            <Link to="/apps" className="button button--primary">
              Browse apps
            </Link>
            <Link to="/" className="button button--ghost">
              Store home
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}

export const NotFoundPage = () => <NotFoundContent />;
