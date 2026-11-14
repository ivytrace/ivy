import path from "node:path";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import type { IncomingMessage } from "node:http";
import { createMockHandler } from "./src/lib/mock/server.ts";

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return {};
  }
}

const mockApi = (): Plugin => ({
  name: "ivy-mock-api",
  configureServer(server) {
    const handle = createMockHandler({
      empty: process.env.VITE_MOCK_EMPTY === "1",
      noTemplate: process.env.VITE_MOCK_NO_TEMPLATE === "1",
    });
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/api/")) return next();
      void readBody(req).then((body) => {
        const result = handle(new URL(req.url!, "http://mock"), { method: req.method, body });
        res.statusCode = result.status;
        if (result.contentType) {
          res.setHeader("content-type", result.contentType);
          res.end(String(result.body));
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result.body));
        }
      });
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
    proxy: mock ? undefined : { "/api": process.env.IVY_API_URL ?? "http://localhost:3000" },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: { environment: "node" },
});
