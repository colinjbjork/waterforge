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
  normalizeOnsen,
  renderMarkdown,
  renderText,
  runOnsen,
  validateOnsenInput,
} from '../lib/onsen'

export interface CliOutcome {
  code: number
  stdout: string
  stderr: string
}

const USAGE = `usage: onsen [<analysis.json> | -] [--json | --markdown]
  Reads the onsen analysis JSON from the given file (or stdin when omitted or
  "-") and prints a home-bath recipe as a bordered text report (default),
  as Markdown with --markdown, or as JSON with --json.
  Schema: docs/onsen-input.md`

/** Pure entry point: argv (without node/script) + a stdin reader → outcome. */
export function runCli(argv: string[], readStdin: () => string): CliOutcome {
  let json = false
  let markdown = false
  let path: string | undefined
  for (const arg of argv) {
    if (arg === '--json') json = true
    else if (arg === '--markdown') markdown = true
    else if (arg === '--help' || arg === '-h') {
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
