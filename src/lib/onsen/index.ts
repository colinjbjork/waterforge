// Barrel for the onsen (hot-spring analysis) layer: input types, validation,
// normalisation to the solver's mg/L profile, the relative-weighted run, and
// the Markdown report. Pure TypeScript, no DOM — the CLI in `src/cli/onsen.ts`
// is the only consumer today.
export * from './types'
export * from './species'
export * from './validate'
export * from './normalize'
export * from './report'
