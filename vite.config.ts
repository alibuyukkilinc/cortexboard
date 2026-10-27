import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The board is built into dist/web and served by `cortexboard start`. For UI work, run `npm run dev:web`
// next to `cortexboard start` (port 4747): Vite proxies API calls and login to it.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:4747", "/login": "http://localhost:4747" },
  },
});
