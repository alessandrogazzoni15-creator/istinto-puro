import { defineConfig } from 'vite';

// Su GitHub Pages il sito vive in /<nome-repo>/: il percorso arriva dal workflow
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
});
