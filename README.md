# CARIAD OTA Performance Dashboard — Prototype

A working React prototype of the "KPI Dashboard on OTA Performance" (see
`KPI Dashboard.jpeg` for the reference design). All data is deterministic
mock data — no backend required.

## Run it

```
npm install
npm run dev        # → http://localhost:5173
```

`npm run build` produces a static bundle in `dist/`, servable from any web server
(`npm run preview` to test it).

## Pages

| Route | Content |
|---|---|
| `#/` | Overview — primary/secondary KPI cards, AI insights, DLCM links |
| `#/detail/<kpi>` | Per-KPI detail: trend (7/30/90d), brand/region breakdowns, anomalies. KPI ids: `updates`, `quality`, `liegenbleiber`, `adoption`, `duration`, `cost`, `co2` |
| `#/dlcm/statistics` | Release register, volume + error-rate per release |
| `#/dlcm/comparison` | Release-vs-release adoption ramp and quality stats |

Routes are hash-based, so deep links are shareable and the browser back button works.

## Behaviour worth knowing

- **Filters are live.** Selecting a Region/Brand/Platform/Recall rescales the
  volume KPIs (updates, cost, CO₂) by mock fleet shares, reseeds the detail
  charts, and highlights the selected slice in the breakdowns. Rate KPIs
  (quality, adoption, duration) are scope-invariant by design. The "To" date
  shifts the trend window.
- **Chart series palette** (`CHART` in `src/App.jsx`) is validated for the dark
  surface: OKLCH lightness band, chroma floor, colour-vision-deficiency
  separation between adjacent hues, and 3:1 contrast.
- `cariad-ota-dashboard.jsx` in the repo root is the original single-file
  component kept as reference; the app source of truth is `src/App.jsx`.

## Stack

Vite 7 · React 19 · Tailwind CSS 4 · Recharts 3 · lucide-react
