import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['src/index.ts', 'src/authorization.ts', 'src/harness/index.ts', 'src/sync/client.ts'], format: ['esm', 'cjs'], dts: true, clean: true });
