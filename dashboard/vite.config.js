import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const target = "http://127.0.0.1:4317";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target },
      "/ws": { target: target.replace("http", "ws"), ws: true }
    }
  },
  build: { outDir: "dist", emptyOutDir: true }
});
