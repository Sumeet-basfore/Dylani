import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const backendPort = Number(process.env.PORT || 3002);
const webPort = Number(process.env.VITE_PORT || 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: true,
    proxy: {'/api': {target: `http://127.0.0.1:${backendPort}`, changeOrigin: true}}
  }
});
