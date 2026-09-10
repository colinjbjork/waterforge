// Plain-text report with bordered tables.
//
// This is what a person reads in a terminal. Every table has straight-line
// borders (Unicode box drawing) with padded, aligned columns — an Excel-style
// grid — instead of a markdown pipe table, which is unreadable un-rendered.

import { speciesLabel } from './species'
import type { NotReplicated, OnsenResult } from './report'

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

  lines.push('RECIPE')
  if (r.recipe.length === 0) {
    lines.push(
      'No salt needed: the source water already meets or exceeds every fitted ion.',
    )
  } else {
    lines.push(
      boxTable(
        ['Ingredient', 'Formula', 'Grams for bath', 'g/L'],
        r.recipe.map((x) => [
          x.purchaseName,
          x.formula,
          fmt(x.grams, 1),
          fmt(x.gramsPerLitre, 3),
        ]),
        ['left', 'left', 'right', 'right'],
      ),
    )
  }
  lines.push('')

  lines.push('MATCH')
  lines.push(
    boxTable(
      ['Ion', 'Target mg/L', 'Result mg/L', 'Difference'],
      r.match.map((m) => [
        m.label,
        fmt(m.target, 1),
        fmt(m.result, 1),
        m.diffPct === null
          ? 'n/a (not on card)'
          : `${m.diffPct >= 0 ? '+' : ''}${fmt(m.diffPct, 1)}%`,
      ]),
      ['left', 'right', 'right', 'right'],
    ),
  )
  lines.push(
    `TDS of result ${fmt(r.readouts.tds, 0)} mg/L. Sulfate:chloride ${isFinite(r.readouts.sulfateChlorideRatio) ? fmt(r.readouts.sulfateChlorideRatio, 2) : 'infinite'}.`,
  )
  lines.push('')

  lines.push('NOT REPLICATED')
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

  lines.push('WARNINGS')
  for (const w of r.warnings) lines.push(`- ${w}`)
  lines.push('')
  return lines.join('\n')
}
