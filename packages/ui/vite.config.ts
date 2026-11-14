import path from "node:path";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { handleMockRequest } from "./src/lib/mock/server.ts";

const mockApi = (): Plugin => ({
  name: "ivy-mock-api",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/api/")) return next();
      const { status, body } = handleMockRequest(new URL(req.url, "http://mock"));
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
  },
});

const mock = process.env.VITE_MOCK === "1";

export default defineConfig({
  plugins: [react(), ...(mock ? [mockApi()] : [])],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    port: 5173,
    proxy: mock ? undefined : { "/api": "http://localhost:3000" },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: { environment: "node" },
});
