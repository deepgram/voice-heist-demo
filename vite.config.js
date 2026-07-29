import { defineConfig } from "vite";

const BRAIN_PORT = process.env.BRAIN_PORT || 8000;
const target = `http://localhost:${BRAIN_PORT}`;

// Dev-only: mirror production routing, where the game is the landing page at
// /game and "/" redirects there. Registration stays at /register — it's
// optional, for players who want their codename on the leaderboard.
function gameRoutes() {
  return {
    name: "game-routes",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || "").split("?")[0];
        if (path === "/" || path === "/booth") {
          // "/booth" is the old name — old links still land in the game.
          res.statusCode = 302;
          res.setHeader("Location", "/game");
          res.end();
          return;
        }
        if (path === "/game") req.url = "/index.html";
        if (path === "/register") req.url = "/register.html";
        if (path === "/leaderboard") req.url = "/leaderboard.html";
        if (path === "/admin") req.url = "/admin.html";
        if (path === "/rules") req.url = "/rules.html";
        next();
      });
    },
  };
}

export default defineConfig({
  root: "client",
  plugins: [gameRoutes()],
  server: {
    port: 5173,
    proxy: {
      // Token endpoint -> Python brain.
      "/api": target,
      // Game-brain control WebSocket -> Python brain.
      "/ws": { target, ws: true },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      // Multi-page: the game + the phone registration page + the admin portal.
      input: {
        main: "client/index.html",
        register: "client/register.html",
        admin: "client/admin.html",
        leaderboard: "client/leaderboard.html",
        rules: "client/rules.html",
      },
    },
  },
});
