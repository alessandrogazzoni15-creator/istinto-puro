import { defineConfig } from 'vite';

// Su GitHub Pages il sito vive in /<nome-repo>/: il percorso arriva dal workflow
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  // Link di prova per i tester (cloudflared): Vite accetta solo gli host elencati
  preview: { allowedHosts: ['.trycloudflare.com'] },
});
