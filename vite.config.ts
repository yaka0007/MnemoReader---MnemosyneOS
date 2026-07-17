import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standard configuration for Mnemosyne OS Cartridges.
export default defineConfig({
  plugins: [react()],
  base: './', // Vital for the custom mnemo-plugin:// protocol (relative asset paths).
  server: {
    host: '127.0.0.1', // IPv4 loopback binding for Electron compatibility.
    port: 5210,        // Unique static port — MUST match apps/dev-ports.json + mnemo-plugin.json.
    strictPort: true,  // Fail fast if the port is already taken.
    cors: true
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true
  }
});
