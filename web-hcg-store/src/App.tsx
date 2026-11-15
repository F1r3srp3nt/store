import { useMemo } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AccountProvider } from "./account/account-context";
import { CatalogueStateProvider } from "./app/catalogue-context";
import { Layout } from "./components/Layout";
import { AccountPage } from "./pages/AccountPage";
import { BrowsePage } from "./pages/BrowsePage";
import { CheckoutReturnPage } from "./pages/CheckoutReturnPage";
import { GettingStartedPage } from "./pages/GettingStartedPage";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProductPage } from "./pages/ProductPage";
import { ReleaseHistoryPage } from "./pages/ReleaseHistoryPage";
import { selectCatalogueProvider, type CatalogueProvider } from "./providers";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="apps" element={<BrowsePage />} />
        <Route path="apps/:slug" element={<ProductPage />} />
        <Route path="apps/:slug/releases" element={<ReleaseHistoryPage />} />
        <Route path="getting-started" element={<GettingStartedPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="checkout/return" element={<CheckoutReturnPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App({ provider }: { provider?: CatalogueProvider }) {
  const p = useMemo(() => provider ?? selectCatalogueProvider(), [provider]);
  return (
    <CatalogueStateProvider provider={p}>
      <AccountProvider>
        {/*
          useTransitions={false}: render location changes as urgent updates, not React transitions.
          With transitions the URL changes at once but the new location can render much later on a
          busy device, so the page on screen disagrees with the URL, and useSearchParams' functional
          setter merges into the last *rendered* params: clearing the search and then ticking a filter
          before that render lands silently restores the cleared search. No route here suspends, so
          transitions bought nothing.
        */}
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"} useTransitions={false}>
          <AppRoutes />
        </BrowserRouter>
      </AccountProvider>
    </CatalogueStateProvider>
  );
}
