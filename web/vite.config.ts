import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
  server: {
    // `npm run dev` (frontend) talks to `npm run dev:api` (Worker on :8787)
    proxy: { "/api": { target: "http://localhost:8787", ws: true } },
  },
});
