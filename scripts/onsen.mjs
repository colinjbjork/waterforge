// Launcher for the onsen CLI (`npm run onsen -- <analysis.json> [--json]`).
//
// The repo has no standalone TypeScript runner (no tsx / vite-node), and the
// engine's extension-less relative imports rule out Node's native type
// stripping. Vite is already a dependency, and it exposes `runnerImport`, the
// same module runner it uses to load its own TS config files — so we use that
// to execute `src/cli/onsen.ts` directly without adding a dev dependency.
import { fileURLToPath } from 'node:url'
import { runnerImport } from 'vite'

const entry = fileURLToPath(new URL('../src/cli/onsen.ts', import.meta.url))

const { module } = await runnerImport(entry, {
  // Do not load vite.config.ts: the Svelte/Tailwind/PWA plugins are for the
  // browser bundle and only slow this down.
  configFile: false,
  logLevel: 'silent',
  server: { hmr: false, watch: null },
})

process.exitCode = module.main(process.argv.slice(2))
