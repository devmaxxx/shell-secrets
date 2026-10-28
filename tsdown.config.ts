import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  dts: true,
  exports: true,
  publint: true,
  // A global install runs a copy of dist with no node_modules beside it, so
  // agent-base-kit is bundled in and the output may import no package.
  deps: {
    alwaysBundle: ['agent-base-kit'],
    onlyImport: [],
  },
})
