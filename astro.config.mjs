import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://andrewhy.de',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
