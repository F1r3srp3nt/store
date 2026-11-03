import { useMemo } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { CatalogueStateProvider } from "./app/catalogue-context";
import { Layout } from "./components/Layout";
import { AccountPage } from "./pages/AccountPage";
import { BrowsePage } from "./pages/BrowsePage";
import { GettingStartedPage } from "./pages/GettingStartedPage";
import { HomePage } from "./pages/HomePage";
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
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App({ provider }: { provider?: CatalogueProvider }) {
  const p = useMemo(() => provider ?? selectCatalogueProvider(), [provider]);
  return (
    <CatalogueStateProvider provider={p}>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"}>
        <AppRoutes />
      </BrowserRouter>
    </CatalogueStateProvider>
  );
}
