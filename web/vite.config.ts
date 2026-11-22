import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { changelogPlugin } from '../app/plugins/changelog';

export default defineConfig({
  plugins: [react(), tailwindcss(), changelogPlugin(path.resolve(__dirname, '..'))],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../app/src'),
      react: path.resolve(__dirname, '../app/node_modules/react'),
      'react-dom': path.resolve(__dirname, '../app/node_modules/react-dom'),
      '@tanstack/react-query': path.resolve(__dirname, '../app/node_modules/@tanstack/react-query'),
      '@tanstack/react-query-devtools': path.resolve(
        __dirname,
        '../app/node_modules/@tanstack/react-query-devtools',
      ),
      zustand: path.resolve(__dirname, '../app/node_modules/zustand'),
    },
    dedupe: ['react', 'react-dom', '@tanstack/react-query', 'zustand'],
  },
  build: {
    outDir: 'dist',
  },
});
