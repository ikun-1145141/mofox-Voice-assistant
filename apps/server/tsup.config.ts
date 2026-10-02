import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', 'speech/worker': 'src/speech/worker.ts' },
  format: ['esm'], target: 'node22', outDir: 'dist',
  noExternal: ['@mofox/protocol'], splitting: false, clean: true, sourcemap: true
});
