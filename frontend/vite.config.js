import { defineConfig, loadEnv } from "vite";

// In production the signer runs as a Vercel function (api/sign.js). In `npm run dev` this
// plugin mounts the same handler at /api/sign so local and deployed behaviour match.
function localApi() {
  return {
    name: "apostille-local-api",
    configureServer(server) {
      server.middlewares.use("/api/sign", async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        req.body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
        res.status = (code) => ((res.statusCode = code), res);
        res.json = (obj) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(obj)));
        try {
          const { default: handler } = await server.ssrLoadModule("/api/sign.js");
          await handler(req, res);
        } catch (err) {
          server.config.logger.error(String(err?.stack || err));
          res.status(500).json({ error: "local signer crashed" });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Expose server-only PRIMUS_* vars to the local handler (never to client code).
  const env = loadEnv(mode, process.cwd(), "PRIMUS_");
  Object.assign(process.env, env);

  return {
    plugins: [localApi()],
    // The Primus SDK is CommonJS and expects a Node-style `global`.
    optimizeDeps: { include: ["@primuslabs/zktls-js-sdk", "ethers"] },
    define: { global: "globalThis" },
    build: {
      target: "es2022",
      rollupOptions: { input: { main: "index.html", deploy: "deploy.html", perp: "perp.html" } },
    },
  };
});
