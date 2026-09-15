# Prompt: turn an onsen analysis into `onsen` CLI JSON

Copy everything below the line into any capable model (ChatGPT, Gemini,
Claude, a local model) together with ONE of: a URL to the spring's page
(onsenoni.com, the ryokan's own site, a prefecture PDF), the pasted text of
its 温泉分析書, or a photo/scan of the card. The model's reply is the JSON;
save it as `<name>.json` and drag it onto `onsen-calculator.bat` (or run
`node scripts/onsen.mjs <name>.json` in this repo).

If the model cannot open URLs, open the page yourself, copy the analysis
table (or screenshot it) and paste that instead of the link.

---

You are converting a Japanese hot-spring mineral analysis (温泉分析書, "onsen
analysis sheet") into a strict JSON document for a bath-recipe calculator.
Output ONLY the JSON, in one fenced code block, then a short bullet list of
anything you dropped or were unsure about. No other prose.

## What you are given

A URL, pasted text, or an image of the analysis. If it is a URL, open it and
find the section that lists the ions with numbers — on onsenoni.com it is the
"Water analysis" / 温泉分析 table; on Japanese sites look for 試料1kg中の成分,
陽イオン, 陰イオン, 遊離成分 / 非解離成分. If the page lists several sources
(源泉), use the one with the most complete table and name it in the notes.

## Output shape

```json
{
  "name": "<spring / source name, e.g. 'Hotel Fugetsu, Source No. 2'>",
  "units": "mg/kg",
  "ph": 6.8,
  "temperature_c": 52.0,
  "spring_type": "<泉質 string as printed, e.g. ナトリウム-塩化物泉 or Sodium-Chloride>",
  "cations": { "Na": 964.6, "K": 147.4, "Ca": 40.0, "Mg": 5.5 },
  "anions": { "Cl": 1446.0, "SO4": 454.0, "HCO3": 12.3 },
  "undissociated": { "H2SiO3": 387.3, "HBO2": 21.0, "CO2": 45.0 },
  "bath_volume": { "value": 250, "unit": "L" }
}
```

Field rules:

- `units` — the unit of the cation/anion numbers you copied: `"mg/kg"`,
  `"mg/L"` or `"mval"`. Cards usually print mg/kg, mval and mval% side by
  side: **use the mg/kg column** when it exists. Use `"mval"` only if the
  card gives no mg column at all. Never mix units inside one JSON. Ignore
  the mval% (ミリバル%) column entirely.
- `cations`, `anions` — `{ key: number }`, numbers only, no strings, no
  units, no negatives. Include every ion the card lists, even ones the
  calculator does not fit (it reports them as "not replicated").
- `undissociated` (遊離成分 / 非解離成分: metasilicic acid, metaboric acid,
  free CO₂, free H₂S) — **always the mg figure**, whatever `units` says.
- `ph`, `temperature_c`, `spring_type`, `name` — optional, copied from the
  header of the card (pH 0–14; temperature in °C at the source 泉温).
- `bath_volume` — optional. Include only if the person told you a tub size;
  units `"L"` or `"gal"`. Otherwise omit it (default is 250 L).
- No other top-level keys. Do not add `notes`, `source`, `url` or comments
  inside the JSON — put those in the bullet list after the code block.

## Key map (use exactly these keys)

Cations: ナトリウム Na⁺ → `Na` · カリウム K⁺ → `K` · カルシウム Ca²⁺ → `Ca` ·
マグネシウム Mg²⁺ → `Mg` · 鉄(II) Fe²⁺ → `Fe2` · 鉄(III) Fe³⁺ → `Fe3` ·
リチウム Li⁺ → `Li` · ストロンチウム Sr²⁺ → `Sr` · バリウム Ba²⁺ → `Ba` ·
アルミニウム Al³⁺ → `Al` · マンガン Mn²⁺ → `Mn` · 亜鉛 Zn²⁺ → `Zn` ·
銅 Cu²⁺ → `Cu` · アンモニウム NH₄⁺ → `NH4` · 水素イオン H⁺ → `H`.

Anions: 塩化物 Cl⁻ → `Cl` · 硫酸 SO₄²⁻ → `SO4` · 炭酸水素 HCO₃⁻ → `HCO3` ·
炭酸 CO₃²⁻ → `CO3` · 水酸化物 OH⁻ → `OH` · 硫化水素イオン HS⁻ → `HS` ·
チオ硫酸 S₂O₃²⁻ → `S2O3` · 硫酸水素 HSO₄⁻ → `HSO4` · 臭化物 Br⁻ → `Br` ·
ヨウ化物 I⁻ → `I` · フッ化物 F⁻ → `F` · 硝酸 NO₃⁻ → `NO3` · 亜硝酸 NO₂⁻ →
`NO2` · リン酸水素 HPO₄²⁻ → `HPO4` · リン酸二水素 H₂PO₄⁻ → `H2PO4`.

Undissociated (always mg): メタケイ酸 H₂SiO₃ → `H2SiO3` · メタホウ酸 HBO₂ →
`HBO2` (if printed as ホウ酸 H₃BO₃ use `H3BO3`) · 遊離二酸化炭素 CO₂ → `CO2`
· 遊離硫化水素 H₂S → `H2S` · メタ亜ヒ酸 HAsO₂ → `HAsO2`.

Anything else on the card: keep it under the right group with a short
chemical-formula key (e.g. `Rb`, `Cs`); the calculator will list it as not
replicated.

## Things that are NOT components — drop them

- Totals: 陽イオン計, 陰イオン計, 溶存物質総量, 成分総計, 蒸発残留物.
- Detection-limit entries: `<0.1`, `0.1未満`, `不検出`, `n.d.`, `—`. Treat
  as absent; name them in the bullet list.
- Radioactivity (ラドン Rn, ラジウム Ra), and the sampling / lab metadata.
- Percent columns and any "per 1 kg" header text.

## Checks before you answer

1. Every number is copied digit-for-digit from the mg/kg column (OCR: watch
   for 1/7, 0/6, decimal points).
2. Sodium and chloride are usually the two largest numbers on a chloride
   spring; sulfate on a 硫酸塩泉; bicarbonate on a 炭酸水素塩泉. If the
   spring type and the largest numbers disagree, re-read the columns.
3. `units` matches the column you used; `undissociated` is mg regardless.
4. The JSON parses (no trailing commas, quotes around keys, `.` decimals).

Then output the JSON block, followed by bullets like:
- Source: <URL or "pasted card">, source No. X of Y
- Dropped: HS⁻ (<0.1), Rn (radioactivity), totals
- Unsure: Mg 5.5 vs 5.6 — image blurry
