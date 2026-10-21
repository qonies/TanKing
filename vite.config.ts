import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true, // 局域网联机需要其他设备访问（P2-5 修复：Vite 默认只监听 localhost）
    port: 5173,
    proxy: { '/ws': { target: 'ws://localhost:3000', ws: true } },
  },
  build: { target: 'es2022' },
});
