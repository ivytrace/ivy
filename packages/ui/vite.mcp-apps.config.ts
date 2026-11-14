import path from "node:path";
import react from "@vitejs/plugin-react";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { serviceIcons } from "./mcp-apps/icons-plugin.ts";

/**
 * MCP Apps views (docs/implementation/mcp.md): each view is one self-contained HTML file with scripts,
 * styles and icons inlined, built into dist/mcp-apps/ after the dashboard. vite-plugin-singlefile
 * takes one entry per build, so `build:mcp-apps` runs this once per view (MCP_APP=waterfall|graph).
 * `vite -c vite.mcp-apps.config.ts` serves the local test host at /mcp-apps/host.html instead.
 */
const here = import.meta.dirname;
const view = process.env.MCP_APP ?? "waterfall";

export default defineConfig(({ command }) => ({
  // Build from mcp-apps/ so the output is dist/mcp-apps/<view>.html; serve from the package (pages under /mcp-apps/).
  root: command === "build" ? path.resolve(here, "mcp-apps") : here,
  plugins: [
    react(),
    serviceIcons(path.resolve(here, "public"), { large: command === "serve" || view === "graph" }),
    ...(command === "build" ? [viteSingleFile({ removeViteModuleLoader: true })] : []),
  ],
  resolve: {
    alias: [
      { find: "@/lib/spans/icon-url", replacement: path.resolve(here, "src/mcp-apps/icon-url.ts") },
      { find: "@", replacement: path.resolve(here, "src") },
    ],
  },
  css: { postcss: { plugins: [tailwindcss({ config: path.resolve(here, "tailwind.config.ts") }), autoprefixer()] } },
  server: {
    port: Number(process.env.PORT ?? 5180),
    proxy: { "^/mcp$": process.env.IVY_API_URL ?? "http://localhost:3000" },
  },
  build: {
    outDir: path.resolve(here, "dist/mcp-apps"),
    emptyOutDir: false,
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: path.resolve(here, `mcp-apps/${view}.html`) },
  },
}));
