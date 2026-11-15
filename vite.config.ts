import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies everything that needs the Worker to the local Cloudflare runtime
// (wrangler dev on port 8799). `npm run dev` starts wrangler with
// --local-upstream localhost:5199, so the Worker sees this page's address as its own and
// sign-in redirects and passkeys work locally.
const target = "http://127.0.0.1:8799";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
    proxy: {
      "/collab": { target, ws: true },
      "/api": { target },
      "/auth": { target },
      "/uploads": { target },
      "/mcp": { target },
      "/oauth": { target },
      "/.well-known": { target },
    },
  },
  build: { chunkSizeWarningLimit: 4000 },
});
