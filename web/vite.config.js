import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const single = process.env.SINGLEFILE === '1';

export default defineConfig({
  base: './',
  define: {
    __CF_SINGLEFILE__: JSON.stringify(single),
  },
  build: {
    target: 'es2019',
    // The CF-BOOT sentinel lives in index.html (never minify-renamed): the
    // server's serveApp_, ping's appVersion regex and the exe OTA all key on it.
    minify: 'esbuild',
    rollupOptions: single ? {} : undefined,
  },
  plugins: single ? [viteSingleFile()] : [],
});
