// Onsen recipe CLI.
//
//   npm run onsen -- <analysis.json> [--json | --markdown]
//   cat analysis.json | npm run onsen -- [--json | --markdown]
//
// Reads the canonical onsen JSON (docs/onsen-input.md) from a file path or
// stdin, validates + normalises it, runs the solver with relative weighting
// over the full salt palette, and prints a bordered plain-text report
// (default — box-drawing tables a person can read in a terminal), Markdown
// (--markdown, for files), or JSON (--json).
// Exit codes: 0 ok, 1 invalid input, 2 usage / read error.
//
// Launched through `scripts/onsen.mjs`, which uses Vite's own module runner to
// execute this TypeScript directly — no extra runner dependency.

/// <reference types="node" />
import { readFileSync } from 'node:fs'
import {
  fromOnsenOni,
  normalizeOnsen,
  renderMarkdown,
  renderText,
  runOnsen,
  validateOnsenInput,
} from '../lib/onsen'
import type { OnsenInput } from '../lib/onsen'
import type { SaltId } from '../lib/chem/constants'

export interface CliOutcome {
  code: number
  stdout: string
  stderr: string
}

const USAGE = `usage: onsen [<analysis.json> | -] [--json | --markdown]
             [--from-onsenoni [--source <n|id|name>]] [--bath <litres>[L|gal]]
             [--acid muriatic|lactic|citric|bisulfate]
  Reads the onsen analysis JSON from the given file (or stdin when omitted or
  "-") and prints a home-bath recipe as a bordered text report (default),
  as Markdown with --markdown, or as JSON with --json.
  --from-onsenoni  the input is an Onsen Oni get_water_analysis payload
                   (onsenoni.com via the OpenTabs plugin); --source picks
                   which spring source when the place lists several.
  --bath           override the bath volume, e.g. --bath 200 or --bath 60gal.
  --acid           print only the recipe for that acid (default: all four).
  Schema: docs/onsen-input.md`

const ACID_FLAGS: Record<string, SaltId> = {
  muriatic: 'hydrochloricAcid',
  hcl: 'hydrochloricAcid',
  lactic: 'lacticAcid',
  citric: 'citricAcid',
  bisulfate: 'sodiumBisulfate',
}

/** Pure entry point: argv (without node/script) + a stdin reader → outcome. */
export function runCli(argv: string[], readStdin: () => string): CliOutcome {
  let json = false
  let markdown = false
  let oniMode = false
  let source: string | undefined
  let bath: OnsenInput['bath_volume'] | undefined
  let acid: SaltId | undefined
  let path: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--markdown') markdown = true
    else if (arg === '--from-onsenoni') oniMode = true
    else if (arg === '--source') {
      source = argv[++i]
      if (source === undefined) {
        return {
          code: 2,
          stdout: '',
          stderr: `--source needs a value\n${USAGE}\n`,
        }
      }
    } else if (arg === '--bath') {
      const v = argv[++i] ?? ''
      const m = /^(\d+(?:\.\d+)?)\s*(l|L|gal|GAL)?$/.exec(v)
      if (!m) {
        return {
          code: 2,
          stdout: '',
          stderr: `--bath needs a number like 250 or 60gal\n${USAGE}\n`,
        }
      }
      bath = {
        value: Number(m[1]),
        unit: m[2]?.toLowerCase() === 'gal' ? 'gal' : 'L',
      }
    } else if (arg === '--acid') {
      const v = (argv[++i] ?? '').toLowerCase()
      acid = ACID_FLAGS[v]
      if (acid === undefined) {
        return {
          code: 2,
          stdout: '',
          stderr: `--acid needs one of ${Object.keys(ACID_FLAGS).join(', ')}
${USAGE}
`,
        }
      }
    } else if (arg === '--help' || arg === '-h') {
      return { code: 0, stdout: USAGE + '\n', stderr: '' }
    } else if (arg.startsWith('--')) {
      return {
        code: 2,
        stdout: '',
        stderr: `unknown option ${arg}\n${USAGE}\n`,
      }
    } else if (path === undefined) path = arg
    else
      return {
        code: 2,
        stdout: '',
        stderr: `unexpected argument ${arg}\n${USAGE}\n`,
      }
  }

  let text: string
  try {
    text =
      path === undefined || path === '-'
        ? readStdin()
        : readFileSync(path, 'utf8')
  } catch (e) {
    return {
      code: 2,
      stdout: '',
      stderr: `could not read ${path ?? 'stdin'}: ${(e as Error).message}\n`,
    }
  }
  if (text.trim().length === 0) {
    return {
      code: 2,
      stdout: '',
      stderr: `no input on ${path ?? 'stdin'}\n${USAGE}\n`,
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return {
      code: 1,
      stdout: '',
      stderr: `input is not valid JSON: ${(e as Error).message}\n`,
    }
  }

  if (oniMode) {
    try {
      const converted = fromOnsenOni(raw, {
        ...(source !== undefined ? { source } : {}),
        ...(bath ? { bathVolume: bath } : {}),
      })
      raw = converted.input
    } catch (e) {
      return {
        code: 1,
        stdout: '',
        stderr: `onsenoni: ${(e as Error).message}\n`,
      }
    }
  } else if (bath && typeof raw === 'object' && raw !== null) {
    raw = { ...(raw as Record<string, unknown>), bath_volume: bath }
  }

  const validated = validateOnsenInput(raw)
  if (!validated.ok) {
    const lines = validated.errors.map(
      (e) => `  ${e.path || '(root)'}: ${e.message}`,
    )
    return {
      code: 1,
      stdout: '',
      stderr: `invalid onsen input:\n${lines.join('\n')}\n`,
    }
  }

  const result = runOnsen(normalizeOnsen(validated.value))
  if (acid !== undefined) {
    result.variants = result.variants.filter((v) => v.acid === acid)
  }
  const stdout = json
    ? JSON.stringify(result, null, 2) + '\n'
    : markdown
      ? renderMarkdown(result)
      : renderText(result)
  return { code: 0, stdout, stderr: '' }
}

/** Process-level wrapper used by the launcher script. */
export function main(argv: string[]): number {
  const outcome = runCli(argv, () => readFileSync(0, 'utf8'))
  if (outcome.stdout) process.stdout.write(outcome.stdout)
  if (outcome.stderr) process.stderr.write(outcome.stderr)
  return outcome.code
}
