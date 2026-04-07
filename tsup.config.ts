import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    otel: 'src/otel.ts',
    fleet: 'src/fleet.ts',
    'schemas/index': 'src/schemas/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.mjs' : '.cjs',
    };
  },
  splitting: false,
  sourcemap: true,
  clean: true,
});
