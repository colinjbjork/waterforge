# Onsen input schema and CLI output

This fork adds an `onsen` mode to the Waterforge engine: take the mineral
analysis of a Japanese hot spring (温泉分析書) and return the best-fit recipe
of easy-to-buy salts for a home bath. This page documents the JSON the CLI
accepts and what it prints. The engine changes behind it are summarised at the
end.

```
npm run onsen -- <analysis.json>          # Markdown report
npm run onsen -- <analysis.json> --json   # same data as JSON
cat analysis.json | npm run onsen --      # stdin
```

Exit codes: `0` success, `1` invalid input (each problem listed on stderr with
its field path), `2` usage or file-read error.

## Input

```json
{
  "name": "Example Onsen, Source No. 1",
  "units": "mg/kg",
  "ph": 8.4,
  "temperature_c": 52.0,
  "spring_type": "Sodium-Chloride",
  "cations": { "Na": 820.0, "K": 35.0, "Ca": 60.0, "Mg": 4.2, "Fe2": 0.3 },
  "anions": {
    "Cl": 1150.0,
    "SO4": 210.0,
    "HCO3": 180.0,
    "CO3": 6.0,
    "OH": 0.1,
    "HS": 1.2
  },
  "undissociated": { "H2SiO3": 95.0, "HBO2": 12.0, "CO2": 3.0, "H2S": 0.8 },
  "bath_volume": { "value": 250, "unit": "L" },
  "source_water": {
    "Ca": 8.0,
    "Mg": 2.0,
    "Na": 5.0,
    "HCO3": 30.0,
    "Cl": 4.0,
    "SO4": 3.0
  }
}
```

(Also at [`docs/onsen-example.json`](onsen-example.json).)

| Field                                        | Required | Meaning                                                                                                                                                                                         |
| -------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `units`                                      | yes      | `"mg/kg"`, `"mg/L"` or `"mval"` — the unit of the cation/anion figures. mg/kg is treated as mg/L (dilute-solution approximation). `mval` converts per ion: mg = mval × molar mass ÷ \|charge\|. |
| `cations`                                    | one of   | `{ key: number }`, non-negative.                                                                                                                                                                |
| `anions`                                     | these    | `{ key: number }`, non-negative.                                                                                                                                                                |
| `undissociated`                              | three    | `{ key: number }`, **always mg** whatever `units` says (these species carry no charge, so mval is meaningless).                                                                                 |
| `bath_volume`                                | no       | `{ "value": n, "unit": "L" \| "gal" }`. Default **250 L**.                                                                                                                                      |
| `source_water`                               | no       | Ions already in the tap/starting water, **always mg/L**, same keys as the card. Omitted = distilled water.                                                                                      |
| `name`, `ph`, `temperature_c`, `spring_type` | no       | Reference only — echoed in the report header, never fitted. `ph` must be 0–14 when present.                                                                                                     |

Validation rejects negative or non-numeric values, an unknown `units`, a
non-positive or wrongly-united `bath_volume`, a duplicate key across groups, an
unknown top-level field, a card with no components at all, and (in `mval`
mode) a charge-neutral species listed under `cations`/`anions` instead of
`undissociated`.

### Component keys

**Fitted** (the solver targets these): `Ca`, `Mg`, `Na`, `K`, `HCO3`, `SO4`,
`Cl` (the original seven), plus the fork's `CO3` (carbonate, −2) and `H2SiO3`
(metasilicic acid, neutral, tracked by mass).

**Accepted, reported, never fitted.** Any other key is kept with its value and
listed under "Not replicated" with a reason:

- `OH` — hydroxide, reference-only.
- `HS`, `S2O3`, `H2S`, `S` — reduced-sulfur species, **excluded by policy**. No
  sulfur ingredient is ever suggested for them.
- `Fe2`, `Fe3`, `Fe` — iron, **excluded by policy**. No iron ingredient is ever
  suggested.
- `HBO2`, `H3BO3`, `CO2`, `Li`, `Sr`, `Ba`, `Al`, `Mn`, `Zn`, `Cu`, `NH4`, `Br`,
  `I`, `F`, `NO3`, `NO2`, `HPO4`, `H2PO4`, `HAsO2` — known, convertible from
  mval, no ingredient in the palette.
- Anything else — accepted; shown in its card unit (mval cannot be converted to
  mg/L without a molar mass, so that column shows "—").

Note `SO4` is fitted (gypsum, Epsom, Glauber's salt are sulfates); the
exclusion is for the reduced-sulfur species that give sulfur springs their
smell, which no bath-safe retail ingredient reproduces.

## Output (Markdown)

```
# Onsen bath recipe — <name>
Bath volume, card units, spring type, temperature, card pH.

## Recipe
| Ingredient (purchaseName) | Formula | Grams for bath | g/L |

## Match
| Ion | Target mg/L | Result mg/L | Difference (%) |
TDS and sulfate:chloride of the result.

## Not replicated
| Component | Card value (as given, with unit) | mg/L | Why |

## Warnings
- saturation warnings (gypsum / calcite saturation index)
- gypsum solubility-ceiling clamp, if it hit
- any fitted ion more than 10 % off the card; any ion added as a by-product
- source-water ions already above the card (salts cannot remove them)
- charge residual of the result vs the card's fitted ions (meq/L)
- approximate pH from the CO₃²⁻/HCO₃⁻ ratio, next to the card pH
- the sulfur/iron exclusion notice, when those species are on the card
```

`--json` prints the same data as one object: `recipe[]`, `match[]`,
`notReplicated[]`, `readouts` (`tds`, `chargeResidual`,
`targetChargeResidual`, `sulfateChlorideRatio`, `phEstimate?`, `cardPh?`,
`gypsumCeilingHit`, `saturation[]`) and `warnings[]`.

### How the fit works

- The solver runs with the **`'relative'` weighting** option: each ion's row
  in the least-squares system is scaled by 1 / max(target mg/L, 1), so a 6 mg/L
  carbonate figure counts as much as a 1150 mg/L chloride figure in percentage
  terms. The default `'absolute'` weighting (upstream behaviour) is untouched.
- The **full salt palette** is offered. Recipe selection keeps upstream's
  policy (ADR 0009): best fit first, then the highest-priority minimal salt
  set. The six fork salts sit at the end of the priority order, so upstream
  drinking-water recipes are unchanged.
- **Best fit, no tolerance.** Most cards cannot be hit exactly (charge
  balance of the card, source water above target, gypsum's 2 g/L solubility
  ceiling); the Match table and Warnings show where the recipe lands.
- **pH is never fitted.** When the result contains both HCO₃⁻ and CO₃²⁻ the
  report shows pH ≈ 10.33 + log₁₀(mol CO₃²⁻ / mol HCO₃⁻), labelled
  approximate, beside the card pH.

## Engine changes in this fork

- `src/lib/chem/constants.ts` — `Si` atomic weight; ions `CO3` (−2) and
  `H2SiO3` (0); salts `sodiumCarbonate` (Na₂CO₃), `sodiumCarbonateDecahydrate`
  (Na₂CO₃·10H₂O), `sodiumSulfateDecahydrate` (Na₂SO₄·10H₂O), `sodiumSulfate`
  (Na₂SO₄), `potassiumChloride` (KCl), `sodiumMetasilicate` (Na₂SiO₃·5H₂O),
  all with molar masses summed from atomic weights; `purchaseName` on every
  salt; `netCharge` on sodium metasilicate (+2 — its hydroxide is not
  modelled, so the imbalance shows in the charge-residual readout).
- `src/lib/solver/solve.ts` — fifth `solve()` argument `{ weighting }`;
  `estimatePh()`; `Readouts.phEstimate`.
- `src/lib/solver/oracle.ts` — driver ions for the new salts.
- `src/lib/onsen/` — input types, validation, normalisation, species table,
  run + Markdown report.
- `src/cli/onsen.ts` + `scripts/onsen.mjs` — the CLI, executed through
  Vite's `runnerImport` (no new dependency).
