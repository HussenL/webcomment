import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/token": "http://127.0.0.1:8000",
      "/messages": "http://127.0.0.1:8000",
      "/events": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
