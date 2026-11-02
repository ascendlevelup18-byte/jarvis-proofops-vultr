import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 43123,
    strictPort: true,
    proxy: {
      // Operator-only live AI Team endpoints on the local Node server.
      "/team": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
      "/cases": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
      // Netlify exposes /api/health via function; local API may 404 — UI handles that.
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
});
