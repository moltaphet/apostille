import { defineConfig } from "vite";

export default defineConfig({
  // The Primus SDK is CommonJS and expects a Node-style `global`.
  optimizeDeps: { include: ["@primuslabs/zktls-js-sdk", "ethers"] },
  define: { global: "globalThis" },
  build: { target: "es2022" },
});
