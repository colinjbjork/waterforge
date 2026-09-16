# Onsen input schema and CLI output

This fork adds an `onsen` mode to the Waterforge engine: take the mineral
analysis of a Japanese hot spring (温泉分析書) and return the best-fit recipe
of easy-to-buy salts for a home bath. This page documents the JSON the CLI
accepts and what it prints. The engine changes behind it are summarised at the
end.

```
npm run onsen -- <analysis.json>             # bordered plain-text report (default)
npm run onsen -- <analysis.json> --markdown  # same report as Markdown, for files
npm run onsen -- <analysis.json> --json      # same data as JSON
cat analysis.json | npm run onsen --         # stdin
npm run onsen -- oni.json --from-onsenoni    # input is an Onsen Oni get_water_analysis payload
npm run onsen -- oni.json --from-onsenoni --source kutani --bath 60gal
npm run onsen -- <analysis.json> --acid citric   # one acid instead of all four
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

### Onsen Oni payloads (`--from-onsenoni`)

`onsenoni.com` publishes each spring's 温泉分析書 as data, and the OpenTabs
`onsenoni` plugin's `get_water_analysis` tool returns it as JSON. Save that
JSON and pass `--from-onsenoni`; `src/lib/onsen/onsenoni.ts` converts it:

- block `CATION` → `cations`, `ANION` → `anions`, everything else
  (`NON_DISSOCIATED`, `GAS`, trace blocks) → `undissociated`; units mg/kg.
- components whose qualifier is not `EXACT` (`LESS_THAN` = below detection,
  `UNKNOWN` = illegible) are dropped and named in the notes.
- `measured.phSource` → `ph`, `measured.sourceTempC` → `temperature_c`,
  `classification.springQualityFull` → `spring_type`; free CO₂ / H₂S from
  `measured` are added when the table lacks them.
- A place can list several sources. Default = the source with the most
  `EXACT` components; `--source <index|id|name-substring>` picks another.
  The others are listed in the notes.
- The extraction confidence (`PARTIAL`, `LOW`) and the sheet's lab /
  certificate line travel along as `notes`, printed under Warnings.

`notes` is also a plain optional field on the canonical input: an array of
strings echoed verbatim under Warnings.

### Hydroxide, acid and pH — four acids, four recipes

The only retail source of the card's metasilicic acid (H₂SiO₃) is sodium
metasilicate, and it dissolves to 2 Na⁺ + silicate + **2 OH⁻**. Dosed on its
own it puts a bath at pH ≈ 11–12 and drops the calcium and magnesium out as
hydroxide / silicate solids — the opposite of a weakly acidic chloride spring.
And a bicarbonate spring's pH (typically 6.5–7) is set by the free CO₂ it
carries, which no salt supplies: baking soda alone sits at pH ≈ 8.3.

So after the fit the CLI produces **one recipe per acid** in `ACIDS`:

| id                 | product                                         | protons/mol | what it leaves behind                          |
| ------------------ | ----------------------------------------------- | ----------: | ---------------------------------------------- |
| `hydrochloricAcid` | muriatic acid, 14.5 % HCl (liquid, 1.07 g/mL)    |           1 | Cl⁻ — an onsen ion, credited to the fit        |
| `lacticAcid`       | food-grade lactic acid, 88 % (liquid, 1.20 g/mL) |           1 | lactate — not an onsen ion, reported           |
| `citricAcid`       | food-grade citric acid, anhydrous powder         |           3 | citrate — not an onsen ion, reported; binds some Ca/Mg |
| `sodiumBisulfate`  | pool "pH decreaser" NaHSO₄, anhydrous            |           1 | Na⁺ + SO₄²⁻ — onsen ions, credited to the fit  |

For each acid:

1. **Target pH** = the card `ph`; else the card's `H` / `OH` line; else
   "just cancel the hydroxide the salts release" (resolved as the pH a strong
   acid at that dose would give, so all four land in the same place).
2. **Dose by bisection** on the full proton balance until the modelled bath
   pH equals the target. The balance covers carbonate (pKa 6.35 / 10.33),
   silicic acid (9.84 / 13.2), sulfate/bisulfate (1.99), the acid's own
   anion (lactate 3.86; citrate 3.13 / 4.76 / 6.40), boron from the card's
   HBO₂ / H₃BO₃ line (9.24) and water; activity = concentration, 25 °C.
   Weak acids therefore need fewer moles per proton than their formula says
   when the target pH is near a pKa — citric at pH 6.8 delivers ~2.7 H⁺.
3. **Carbon compensation.** Protons beyond the hydroxide turn bicarbonate
   into dissolved CO₂. The bicarbonate that is lost is added back to the fit
   target and the fit re-run, so the card's bicarbonate still matches *at
   the target pH* and the bath carries the CO₂ the card's pH implies. A
   `dissolved CO₂` row in the Match table compares that to the card's free
   CO₂ line (cards are rarely self-consistent to better than ±30 % here; pH
   and bicarbonate win).
4. **Credits.** Ions the acid adds that the engine models (Cl⁻; Na⁺ + SO₄²⁻)
   are credited to the source water so the fit takes less salt. Anions it
   does not model (lactate, citrate) go into the proton balance and appear
   as "from the acid / not an onsen ion" lines. Muriatic acid therefore fits
   chloride springs best; the organic acids leave Na⁺ high and Cl⁻ low by
   ~10–15 % on a chloride spring because nothing else supplies chloride
   without sodium; bisulfate only suits sulfate-rich cards.
5. **Precipitation at the final pH**: gypsum, calcite (carbonate speciated
   at that pH), brucite Mg(OH)₂ (log Ksp −11.25), portlandite Ca(OH)₂ (−5.3),
   calcium/magnesium silicate hydrate (pH ≥ 10 with Ca or Mg and silica),
   amorphous silica at 40 °C (Gunnarsson & Arnórsson 2000). The ionic
   saturation indices use **Davies activity coefficients** at the bath's
   ionic strength; the pH estimate does not.
6. **Ranking**: composition first (largest |difference| over the card's
   fitted ions, whole-percent buckets), then the number of precipitation
   flags the acid can change, then |estimated − card pH|, then `ACIDS`
   order. The winner is marked `*` in the summary table; all four are
   printed.

pH is **never a fit variable** in the least-squares step; the acid dose is
solved afterwards. A card whose pH sits above what the salts give (a strongly
alkaline carbonate spring) gets no acid and no base — the report says so.
Acids live in `ACIDS`, never in `SALT_ORDER`, so the solver's recipe policy
and the drinking-water app never see them. Each acid line carries handling
notes; the shared "Order of addition" warning applies to all four: acid into
the tub first, then the other salts, then the metasilicate dissolved in a
bucket, poured in slowly — silica gels fastest at pH 7–9, so the bath must
already be acidic when it goes in.

## Output

The default is plain text with box-drawing bordered tables (readable in a
terminal, no rendering needed); `--markdown` gives the same sections as
Markdown tables for pasting into a file. Sections:

```
# Onsen bath recipe — <name>
Bath volume, card units, spring type, temperature, card pH.

## Acid options
| Acid | Dose for bath | Est. pH | Worst ion off | Precipitation | Extra ions |
* suggested: <acid> (composition first, then precipitation, then pH)

## Recipe N of 4 — <acid>          (repeated for each acid)
### Recipe
| Ingredient (purchaseName) | Formula | Grams for bath | g/L |
Liquid: <ingredient>: <g> g ≈ <mL> mL (density)   — one line per liquid
### Match
| Ion | Target mg/L | Result mg/L | Difference (%) |
  … plus a `dissolved CO₂` row and, for lactic/citric, a "(from the acid)" row
TDS, sulfate:chloride and estimated pH (card pH) of the result.
### Warnings — the per-acid list below

## Not replicated
| Component | Card value (as given, with unit) | mg/L | Why |

## General warnings — order of addition, sulfur/iron notice, notes

Per-acid warnings
- saturation warnings (gypsum / calcite saturation index)
- gypsum solubility-ceiling clamp, if it hit
- any fitted ion more than 10 % off the card; any ion added as a by-product
- source-water ions already above the card (salts cannot remove them)
- the acid's chloride alone exceeding the card's chloride, if it does
- ions the acid itself overshoots (its chloride / sulfate above the card)
- the acid's by-product anion (lactate / citrate), mg/L and grams
- acid accounting: mmol/L and meq/L dosed, target pH and its basis, the
  hydroxide cancelled, the CO₂ made and the extra bicarbonate fitted, the pH
  without acid; a cap notice if 500 mmol/L could not reach the target
- charge residual of the fitted ions vs the card's (meq/L)
- approximate pH from the proton balance, next to the card pH (and a note
  when they differ by more than 0.5)
- precipitation checks: gypsum, calcite, brucite, portlandite, silicate
  hydrate, amorphous silica
- handling: grams (and mL) of the acid for the bath plus its safety note
```

`--json` prints one object: `variants[]` (one per acid: `acid`, `acidLabel`,
`recipe[]` with `millilitres` on liquid lines, `match[]` including the
`CO2` row, `extraIons[]`, `readouts`, `warnings[]`, `worstDiffPct`,
`precipitationCount`), `suggested`, `sharedWarnings[]`, `notReplicated[]`,
and — mirroring `variants[0]` (muriatic) for older callers — top-level
`recipe`, `match`, `readouts` and `warnings`. `readouts` holds `tds`,
`chargeResidual`, `targetChargeResidual`, `sulfateChlorideRatio`,
`phEstimate`, `cardPh?`, `gypsumCeilingHit`, `saturation[]`,
`precipitation[]` and `acid?` = `{ saltId, mmolPerL, protonsMeqPerL,
hydroxideReleased, targetPh, basis, phWithoutAcid,
extraBicarbonateMmolPerL, dissolvedCo2MgPerL, capped }`. `--acid <name>`
trims `variants` to one.

### How the fit works

- The solver runs with the **`'relative'` weighting** option: each ion's row
  in the least-squares system is scaled by 1 / max(target mg/L, 1), so a 6 mg/L
  carbonate figure counts as much as a 1150 mg/L chloride figure in percentage
  terms. The default `'absolute'` weighting (upstream behaviour) is untouched.
- The **on-hand onsen palette** (`ONSEN_PALETTE` in `constants.ts`) is
  offered, not the full `SALT_ORDER`: gypsum, Epsom salt, table salt,
  calcium chloride dihydrate, baking soda, chalk, magnesium chloride,
  potassium bicarbonate, Arm & Hammer washing soda (anhydrous sodium
  carbonate), Glauber's salt (sodium sulfate decahydrate), potassium chloride
  and sodium metasilicate. Anhydrous calcium chloride, sodium carbonate
  decahydrate and anhydrous sodium sulfate are defined for the drinking-water app but never dosed
  here — edit the list when the shelf changes. Recipe selection keeps
  upstream's policy (ADR 0009): best fit first, then the highest-priority
  minimal salt set. The six fork salts sit at the end of `SALT_ORDER`, so
  upstream drinking-water recipes are unchanged.
- **Best fit, no tolerance.** Most cards cannot be hit exactly (charge
  balance of the card, source water above target, gypsum's 2 g/L solubility
  ceiling); the Match table and Warnings show where the recipe lands.
- **pH is never fitted.** The report shows the proton-balance estimate of the
  result (see "Hydroxide, acid and pH" above), labelled approximate, beside
  the card pH.

## Engine changes in this fork

- `src/lib/chem/constants.ts` — `Si` atomic weight; ions `CO3` (−2) and
  `H2SiO3` (0); salts `sodiumCarbonate` (Na₂CO₃), `sodiumCarbonateDecahydrate`
  (Na₂CO₃·10H₂O), `sodiumSulfateDecahydrate` (Na₂SO₄·10H₂O), `sodiumSulfate`
  (Na₂SO₄), `potassiumChloride` (KCl), `sodiumMetasilicate` (Na₂SiO₃·5H₂O),
  all with molar masses summed from atomic weights; `purchaseName` on every
  salt; `netCharge` = water's counter-ion per mole (+2 OH⁻ on sodium
  metasilicate, −1 H⁺ on hydrochloric / lactic acid and sodium bisulfate,
  −3 on citric acid); `ACIDS` = `hydrochloricAcid` (14.5 % muriatic,
  `densityGPerMl`), `lacticAcid` (88 %, `densityGPerMl`), `citricAcid`
  (anhydrous) and `sodiumBisulfate`, all outside `SALT_ORDER`; `acidAnion`
  (key, label, molar mass, charge, pKas) on the two organic acids;
  `handling` notes; `ONSEN_PALETTE`, the on-hand subset the onsen layer
  fits over.
- `src/lib/solver/solve.ts` — fifth `solve()` argument `{ weighting }`;
  `estimatePh()`; `Readouts.phEstimate`.
- `src/lib/solver/oracle.ts` — driver ions for the new salts.
- `src/lib/onsen/` — input types, validation, normalisation, species table,
  `chemistry.ts` (hydroxide accounting, proton balance with polyprotic
  organic acids / sulfate / borate, `acidDoseForPh` bisection, Davies
  activity coefficients, precipitation checks), `report.ts` (per-acid
  fit-and-dose loop with carbon compensation, ranking, Markdown),
  `text.ts` (bordered text with the acid summary and one block per acid).
- `src/cli/onsen.ts` + `scripts/onsen.mjs` — the CLI, executed through
  Vite's `runnerImport` (no new dependency).
