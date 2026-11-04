import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { hcgHostingPlugin, securityHeaders } from "./build/hosting-plugin";
import { parseDeploymentConfig } from "./src/config/deployment";

export default defineConfig(({ mode }) => {
  // loadEnv merges .env files with VITE_* variables from the process environment.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  // Build-time only settings (never embedded in the bundle).
  const catalogueDir = resolve(__dirname, process.env.HCG_CATALOGUE_DIR ?? "catalogue");
  const basePath = process.env.HCG_BASE_PATH ?? "/";
  const outDir = process.env.HCG_OUT_DIR ?? "dist";
  const previewHeaders = securityHeaders(parseDeploymentConfig(env), env);

  return {
    base: basePath,
    plugins: [react(), hcgHostingPlugin({ env, catalogueDir, basePath })],
    resolve: {
      alias: { "@catalogue": catalogueDir },
    },
    build: {
      outDir,
      sourcemap: false,
      target: "es2022",
      assetsInlineLimit: 0,
    },
    server: { port: 5173, strictPort: false },
    // `vite preview` serves the same security headers as the generated `_headers` file,
    // so local production previews and end-to-end tests run under the real CSP.
    preview: { port: 4173, headers: previewHeaders },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
      css: false,
    },
  };
});
