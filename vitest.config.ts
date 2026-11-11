import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      "cloudflare:sockets": path.resolve(__dirname, "test/cloudflare-sockets-stub.ts"),
    },
  },
  test: {
    environment: "jsdom",
    exclude: ["e2e/**", "node_modules/**", "dist/**", ".next/**", ".worktrees/**"],
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
