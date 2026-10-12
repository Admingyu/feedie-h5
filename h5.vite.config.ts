import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/client",
    rollupOptions: { input: fileURLToPath(new URL("./h5.html", import.meta.url)) },
  },
});
