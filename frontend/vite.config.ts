import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  // ✅ 上线挂载在 /wc/ （影响 build 后静态资源路径）
  base: "/wc/",

  // ✅ 本地开发用 proxy（只在 npm run dev 生效）
  server: {
    proxy: {
      // 让本地 dev 访问 /wc/token 也能通
      "/wc/token": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wc/, ""),
      },
      "/wc/messages": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wc/, ""),
      },
      "/wc/events": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        ws: false, // SSE 不是 websocket
        rewrite: (path) => path.replace(/^\/wc/, ""),
      },
    },
  },
});
