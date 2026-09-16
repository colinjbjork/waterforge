// Plain-text report with bordered tables.
//
// This is what a person reads in a terminal. Every table has straight-line
// borders (Unicode box drawing) with padded, aligned columns — an Excel-style
// grid — instead of a markdown pipe table, which is unreadable un-rendered.
// One recipe block per acid, after a summary table of the acid options.

import { speciesLabel } from './species'
import {
  ACID_SHORT_NAME,
  ACID_SUMMARY_HEADER,
  acidSummaryRows,
  liquidLines,
} from './report'
import type { OnsenResult, OnsenVariant } from './report'
import type { NotReplicated } from './types'

type Align = 'left' | 'right'

/** Display width of a string; the report only uses BMP characters, so length is enough. */
function width(s: string): number {
  return [...s].length
}

function pad(s: string, w: number, align: Align): string {
  const gap = ' '.repeat(Math.max(0, w - width(s)))
  return align === 'right' ? gap + s : s + gap
}

/**
 * Render a bordered table.
 *
 * ┌─────┬─────┐
 * │ a   │   b │
 * ├─────┼─────┤
 * │ ... │ ... │
 * └─────┴─────┘
 */
export function boxTable(
  header: string[],
  rows: string[][],
  align: Align[] = [],
): string {
  const cols = header.length
  const widths = header.map((h, c) =>
    Math.max(width(h), ...rows.map((r) => width(r[c] ?? ''))),
  )
  const line = (l: string, m: string, r: string): string =>
    l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r
  const row = (cells: string[]): string =>
    '│' +
    cells
      .map((cell, c) => ' ' + pad(cell, widths[c], align[c] ?? 'left') + ' ')
      .join('│') +
    '│'
  const out = [line('┌', '┬', '┐'), row(header), line('├', '┼', '┤')]
  for (const r of rows)
    out.push(row(Array.from({ length: cols }, (_, c) => r[c] ?? '')))
  out.push(line('└', '┴', '┘'))
  return out.join('\n')
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits)
}

function reasonText(n: NotReplicated): string {
  switch (n.reason) {
    case 'excluded-sulfur':
      return 'sulfur species: excluded, never replicated'
    case 'excluded-iron':
      return 'iron species: excluded, never replicated'
    case 'reference-only':
      return 'reported only, not a fit target'
    case 'no-ingredient':
      return 'no ingredient in the palette'
  }
}

function renderVariant(
  v: OnsenVariant,
  index: number,
  total: number,
  lines: string[],
): void {
  lines.push(
    `=== RECIPE ${index + 1} of ${total}: ${ACID_SHORT_NAME[v.acid].toUpperCase()} ===`,
  )
  lines.push('')
  lines.push('RECIPE')
  if (v.recipe.length === 0) {
    lines.push(
      'No salt needed: the source water already meets or exceeds every fitted ion.',
    )
  } else {
    lines.push(
      boxTable(
        ['Ingredient', 'Formula', 'Grams for bath', 'g/L'],
        v.recipe.map((x) => [
          x.purchaseName,
          x.formula,
          fmt(x.grams, 1),
          fmt(x.gramsPerLitre, 3),
        ]),
        ['left', 'left', 'right', 'right'],
      ),
    )
    for (const l of liquidLines(v.recipe)) lines.push(l)
  }
  lines.push('')

  lines.push('MATCH')
  const rows = v.match.map((m) => [
    m.label,
    fmt(m.target, 1),
    fmt(m.result, 1),
    m.diffPct === null
      ? 'n/a (not on card)'
      : `${m.diffPct >= 0 ? '+' : ''}${fmt(m.diffPct, 1)}%`,
  ])
  for (const e of v.extraIons) {
    rows.push([`${e.label} (from the acid)`, '-', fmt(e.mgPerL, 1), 'not an onsen ion'])
  }
  lines.push(
    boxTable(
      ['Ion', 'Target mg/L', 'Result mg/L', 'Difference'],
      rows,
      ['left', 'right', 'right', 'right'],
    ),
  )
  lines.push(
    `TDS of result ${fmt(v.readouts.tds, 0)} mg/L. Sulfate:chloride ${isFinite(v.readouts.sulfateChlorideRatio) ? fmt(v.readouts.sulfateChlorideRatio, 2) : 'infinite'}. Estimated pH ${fmt(v.readouts.phEstimate, 1)}${v.readouts.cardPh !== undefined ? ` (card ${v.readouts.cardPh})` : ''}.`,
  )
  lines.push('')

  lines.push('WARNINGS')
  for (const w of v.warnings) lines.push(`- ${w}`)
  lines.push('')
}

/** Render an `OnsenResult` as bordered plain text (the CLI default). */
export function renderText(r: OnsenResult): string {
  const lines: string[] = []
  const meta: string[] = []
  if (r.springType) meta.push(r.springType)
  if (r.temperatureC !== undefined) meta.push(`${r.temperatureC} °C at source`)
  if (r.readouts.cardPh !== undefined) meta.push(`card pH ${r.readouts.cardPh}`)
  const litresNote = r.batch.unit === 'gal' ? ` (${fmt(r.litres, 0)} L)` : ''

  lines.push(`ONSEN BATH RECIPE: ${r.name}`)
  lines.push(
    `Bath volume ${r.batch.volume} ${r.batch.unit}${litresNote}. Card units ${r.units}${meta.length ? '. ' + meta.join(', ') : ''}.`,
  )
  lines.push('')

  lines.push(`ACID OPTIONS (${r.variants.length} recipes below, one per acid)`)
  lines.push(
    boxTable(ACID_SUMMARY_HEADER, acidSummaryRows(r), [
      'left',
      'right',
      'right',
      'right',
      'left',
      'left',
    ]),
  )
  lines.push(
    `* suggested: ${ACID_SHORT_NAME[r.suggested]} (composition first, then precipitation, then closeness to the card pH).`,
  )
  lines.push('')

  r.variants.forEach((v, i) => renderVariant(v, i, r.variants.length, lines))

  lines.push('NOT REPLICATED (same for every recipe)')
  if (r.notReplicated.length === 0) {
    lines.push('Every component on the card is a fit target.')
  } else {
    lines.push(
      boxTable(
        ['Component', 'Card value', 'mg/L', 'Why'],
        r.notReplicated.map((n) => [
          speciesLabel(n.key),
          `${n.reported} ${n.unit}`,
          n.mgPerL !== undefined ? fmt(n.mgPerL, 2) : '-',
          reasonText(n),
        ]),
        ['left', 'right', 'right', 'left'],
      ),
    )
  }
  lines.push('')

  lines.push('GENERAL WARNINGS (apply to every recipe)')
  if (r.sharedWarnings.length === 0) lines.push('- none')
  for (const w of r.sharedWarnings) lines.push(`- ${w}`)
  lines.push('')
  return lines.join('\n')
}
