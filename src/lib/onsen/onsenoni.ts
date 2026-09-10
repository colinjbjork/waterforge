// Convert an Onsen Oni water-analysis payload into onsen CLI input.
//
// `onsenoni.com` publishes each hot spring's 温泉分析書 as structured data; the
// OpenTabs `onsenoni` plugin's `get_water_analysis` tool returns it as JSON
// (one place, one or more SOURCES, each with a full ion table). This module
// picks a source and maps it onto the canonical `OnsenInput` schema so the
// existing validate → normalise → solve → report pipeline runs unchanged.
//
// Mapping rules:
// - block CATION → cations, ANION → anions, everything else (NON_DISSOCIATED,
//   GAS, trace blocks) → undissociated. Values are mg/kg.
// - components whose qualifier is not EXACT (LESS_THAN = below detection,
//   UNKNOWN = not legible) or whose mg is null are dropped and named in notes.
// - measured.phSource → ph, measured.sourceTempC → temperature_c,
//   classification.springQualityFull (or short) → spring_type.
// - free CO2 / free H2S from `measured` are added as undissociated components
//   when the component table lacks them.
// - The extraction confidence and its notes travel along as `notes`, which
//   the report prints under Warnings — a LOW-confidence sheet is still a
//   recipe, but the reader should know the digits were hard to read.

import type { OnsenInput } from './types'

export interface OnsenOniComponent {
  block?: string
  code?: string
  mg?: number | null
  qualifier?: string
  name?: string
}

export interface OnsenOniSource {
  nameEn?: string | null
  nameJa?: string | null
  sourceId?: string
  analysis?: {
    classification?: {
      springQualityFull?: string | null
      springQualityShort?: string | null
      primaryType?: string | null
    }
    components?: OnsenOniComponent[]
    measured?: {
      phSource?: number | null
      sourceTempC?: number | null
      freeCo2Mg?: number | null
      freeH2sMg?: number | null
      totalSoluteMg?: number | null
    }
    extraction?: {
      confidence?: string | null
      lowConfidenceNotes?: string | null
    }
    certificate?: {
      labName?: string | null
      certificateNumber?: string | null
      analyzedAt?: string | null
    }
  } | null
}

export interface OnsenOniPayload {
  hasAnalysis?: boolean
  place?: { id?: string; nameEn?: string | null; nameJa?: string | null }
  sourceCount?: number
  sources?: OnsenOniSource[]
}

export interface FromOnsenOniOptions {
  /**
   * Which source to use: a 0-based index, a source id, or a case-insensitive
   * substring of the source's English/Japanese name. Omitted = the source
   * with the most EXACT components (the best-extracted sheet).
   */
  source?: number | string
  bathVolume?: OnsenInput['bath_volume']
  sourceWater?: OnsenInput['source_water']
}

export interface FromOnsenOniResult {
  input: OnsenInput
  /** Index into `payload.sources` that was used. */
  sourceIndex: number
  /** One line per source, so a caller can list the alternatives. */
  sourceSummaries: string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function exactCount(src: OnsenOniSource): number {
  return (src.analysis?.components ?? []).filter(
    (c) => c.qualifier === 'EXACT' && typeof c.mg === 'number',
  ).length
}

function summarise(src: OnsenOniSource, i: number): string {
  const a = src.analysis
  const name = src.nameEn || src.nameJa || src.sourceId || `source ${i}`
  const conf = a?.extraction?.confidence ?? 'n/a'
  const quality =
    a?.classification?.springQualityShort ||
    a?.classification?.primaryType ||
    '?'
  return `[${i}] ${name} — ${quality}, ${exactCount(src)} exact components, extraction confidence ${conf}`
}

/** Pick a source by index / id / name substring; default = most EXACT components. */
export function pickSource(
  sources: OnsenOniSource[],
  selector?: number | string,
): number {
  if (sources.length === 0) return -1
  if (typeof selector === 'number') {
    return selector >= 0 && selector < sources.length ? selector : -1
  }
  if (typeof selector === 'string' && selector.trim()) {
    const s = selector.trim()
    if (/^\d+$/.test(s)) return pickSource(sources, Number(s))
    const needle = s.toLowerCase()
    const byId = sources.findIndex((x) => x.sourceId === s)
    if (byId >= 0) return byId
    return sources.findIndex(
      (x) =>
        (x.nameEn ?? '').toLowerCase().includes(needle) ||
        (x.nameJa ?? '').includes(s),
    )
  }
  let best = -1
  let bestCount = -1
  sources.forEach((x, i) => {
    const n = exactCount(x)
    if (n > bestCount) {
      best = i
      bestCount = n
    }
  })
  return best
}

/**
 * Build canonical onsen input from an Onsen Oni `get_water_analysis` payload.
 * Throws with a plain message when the payload has no usable analysis.
 */
export function fromOnsenOni(
  raw: unknown,
  opts: FromOnsenOniOptions = {},
): FromOnsenOniResult {
  if (!isPlainObject(raw))
    throw new Error('Onsen Oni payload must be an object')
  const payload = raw as OnsenOniPayload
  const sources = Array.isArray(payload.sources) ? payload.sources : []
  if (payload.hasAnalysis === false || sources.length === 0) {
    throw new Error(
      `no water analysis recorded for ${payload.place?.nameEn ?? 'this place'} on onsenoni.com`,
    )
  }
  const sourceSummaries = sources.map(summarise)
  const idx = pickSource(sources, opts.source)
  if (idx < 0) {
    throw new Error(
      `source "${String(opts.source)}" not found; available:\n  ${sourceSummaries.join('\n  ')}`,
    )
  }
  const src = sources[idx]
  const a = src.analysis
  if (!a || !Array.isArray(a.components) || exactCount(src) === 0) {
    throw new Error(
      `source [${idx}] has no readable components; available:\n  ${sourceSummaries.join('\n  ')}`,
    )
  }

  const cations: Record<string, number> = {}
  const anions: Record<string, number> = {}
  const undissociated: Record<string, number> = {}
  const notes: string[] = []
  const dropped: string[] = []

  for (const c of a.components) {
    const code = (c.code ?? '').trim()
    if (!code) continue
    if (
      c.qualifier !== 'EXACT' ||
      typeof c.mg !== 'number' ||
      !isFinite(c.mg)
    ) {
      dropped.push(
        `${code} (${c.qualifier === 'LESS_THAN' ? 'below detection' : (c.qualifier?.toLowerCase() ?? 'no value')})`,
      )
      continue
    }
    const bucket =
      c.block === 'CATION'
        ? cations
        : c.block === 'ANION'
          ? anions
          : undissociated
    bucket[code] = (bucket[code] ?? 0) + c.mg
  }

  const m = a.measured ?? {}
  if (typeof m.freeCo2Mg === 'number' && undissociated.CO2 === undefined) {
    undissociated.CO2 = m.freeCo2Mg
  }
  if (typeof m.freeH2sMg === 'number' && undissociated.H2S === undefined) {
    undissociated.H2S = m.freeH2sMg
  }

  const placeName =
    payload.place?.nameEn || payload.place?.nameJa || 'Onsen Oni place'
  const sourceName = src.nameEn || src.nameJa || `source ${idx}`
  const input: OnsenInput = {
    name: `${placeName} — ${sourceName}`,
    units: 'mg/kg',
    cations,
    anions,
    undissociated,
  }
  if (typeof m.phSource === 'number') input.ph = m.phSource
  if (typeof m.sourceTempC === 'number') input.temperature_c = m.sourceTempC
  const quality =
    a.classification?.springQualityFull || a.classification?.springQualityShort
  if (quality) input.spring_type = quality
  if (opts.bathVolume) input.bath_volume = opts.bathVolume
  if (opts.sourceWater) input.source_water = opts.sourceWater

  const conf = a.extraction?.confidence
  if (conf && conf !== 'HIGH') {
    notes.push(
      `Onsen Oni extraction confidence for this sheet is ${conf}${a.extraction?.lowConfidenceNotes ? ': ' + a.extraction.lowConfidenceNotes : '.'}`,
    )
  }
  if (dropped.length) {
    notes.push(
      `Components on the sheet without an exact value were left out: ${dropped.join(', ')}.`,
    )
  }
  if (typeof m.totalSoluteMg === 'number') {
    notes.push(`Sheet total dissolved solids: ${m.totalSoluteMg} mg/kg.`)
  }
  const cert = a.certificate
  if (cert && (cert.labName || cert.certificateNumber || cert.analyzedAt)) {
    notes.push(
      `Certificate: ${[cert.labName, cert.certificateNumber, cert.analyzedAt?.slice(0, 10)].filter(Boolean).join(', ')}.`,
    )
  }
  if (sources.length > 1) {
    notes.push(
      `This place lists ${sources.length} sources; used [${idx}]. Others: ${sourceSummaries.filter((_, i) => i !== idx).join('; ')}.`,
    )
  }
  if (notes.length) input.notes = notes

  return { input, sourceIndex: idx, sourceSummaries }
}
