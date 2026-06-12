import { defineConfig } from "vite";

const BRAIN_PORT = process.env.BRAIN_PORT || 8000;
const target = `http://localhost:${BRAIN_PORT}`;

export default defineConfig({
  root: "client",
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
      // The game + the public leaderboard page.
      input: {
        main: "client/index.html",
        leaderboard: "client/leaderboard.html",
      },
    },
  },
});
