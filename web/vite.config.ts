import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.OPEN_RUNNER_API ?? "http://127.0.0.1:8790";

// Dev server proxies /api to the Express backend so the SCX key stays server-side.
// Ports 5190/8790 avoid clashing with common local apps (5173/8787).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    strictPort: true,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
});
