import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: ".",
  base: "./",
  define: {
    __SRL_BUILD_VERSION__: JSON.stringify(process.env.SRL_BUILD_VERSION ?? "srl-dev")
  },
  build: {
    outDir: "dist/desktop-renderer",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false
  }
});
