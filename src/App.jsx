import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  CloudUpload, ShieldAlert, CarFront, Users, Timer, Euro, Leaf,
  ArrowLeft, Sparkles, Info, RotateCcw, ChevronRight, BarChart3,
  LineChart as LineChartIcon, FileText, TrendingUp, TrendingDown,
  AlertTriangle, Home, BookOpen, Mail, CircleDot, Filter, Sun, Moon, Menu, ChevronLeft
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip,
  CartesianGrid, BarChart, Bar, PieChart, Pie, Cell, ReferenceLine, Legend,
  LineChart, Line
} from "recharts";

/* ------------------------------------------------------------------ */
/* Design tokens — CARIAD analytics theme, dark and light variants.    */
/* `C` and `CHART` are swapped per theme at the top of <App>'s render, */
/* before any child reads them.                                        */
/* ------------------------------------------------------------------ */
const DARK = {
  bg: "#05080f",
  panel: "#0a111f",
  cardTop: "#132441",
  cardBottom: "#0a1526",
  cardBorder: "#1f3a63",
  cardBorderSoft: "#16263f",
  text: "#eaf1fb",
  dim: "#8fa3c2",
  faint: "#5a6d8c",
  accent: "#4da3ff",
  cyan: "#39d0d8",
  good: "#35d07f",
  bad: "#ff5a6a",
  amber: "#ffb547",
  topbar: "#070c16",
  inputBg: "#101a2e",
  tooltipBg: "#0d1830",
  hlTop: "#1a3a6b",
  hlBorder: "#2f5793",
  disabledBg: "#3a4252",
  disabledText: "#9aa3b5",
  disabledBorder: "#4a5266",
  onAccent: "#04122b",
};

const LIGHT = {
  bg: "#e8edf5",
  panel: "#f6f8fc",
  cardTop: "#ffffff",
  cardBottom: "#edf2fa",
  cardBorder: "#b4c5de",
  cardBorderSoft: "#d4deec",
  text: "#16233a",
  dim: "#4b5e7d",
  faint: "#7c8ca6",
  accent: "#1f6fd0",
  cyan: "#0e8b93",
  good: "#1c8f57",
  bad: "#cf3345",
  amber: "#9a6a00",
  topbar: "#ffffff",
  inputBg: "#ffffff",
  tooltipBg: "#ffffff",
  hlTop: "#d8e6fa",
  hlBorder: "#9fbce3",
  disabledBg: "#dfe4ec",
  disabledText: "#8d97a8",
  disabledBorder: "#c6cdd9",
  onAccent: "#ffffff",
};

let C = DARK;

// Categorical series palettes, each validated against its own surface
// (OKLCH lightness band, chroma floor, CVD adjacent-pair separation, 3:1 contrast).
const CHART_DARK = ["#2f7fd9", "#bd8100", "#7c6bff", "#279a59", "#199aa6", "#e04858"];
const CHART_LIGHT = ["#2a6fc0", "#8f6400", "#6b53e0", "#1f7a4d", "#00879c", "#c43a4b"];
let CHART = CHART_DARK;

const cardStyle = (highlight) => ({
  background: highlight
    ? `linear-gradient(160deg, ${C.hlTop} 0%, ${C.cardTop} 35%, ${C.cardBottom} 100%)`
    : `linear-gradient(160deg, ${C.cardTop} 0%, ${C.cardBottom} 100%)`,
  border: `1px solid ${highlight ? C.hlBorder : C.cardBorderSoft}`,
  borderRadius: 14,
});

/* ------------------------------------------------------------------ */
/* Mock data                                                           */
/* ------------------------------------------------------------------ */
const BRANDS = ["VW", "Audi", "Porsche", "Škoda", "CUPRA", "MAN"];
const REGIONS = ["Europe", "North America", "China", "South America", "RoW"];
const PLATFORMS = ["MQB", "MLB", "MEB", "PPE"];

// Empty array = "All" (no constraint on that dimension)
const DEFAULT_FILTERS = {
  region: [], country: [], brand: [], platform: [], recall: [],
  from: "2021-01-01", to: "2026-07-07",
};

function normalizeCampaignValue(row) {
  return row.campaign ?? row.Campaign ?? row.campaign_id ?? row.id ?? row.name ?? "";
}

function normalizeCountryValue(row) {
  return row.country_name ?? row.country ?? row.country_iso ?? row.iso ?? row.id ?? row.name ?? "";
}

function normalizeRegionValue(row) {
  return row.region_name ?? row.region ?? row.Region ?? "";
}

function normalizeBrandValue(row) {
  return (row.brand || row.Brand || "").toString();
}

function normalizePlatformValue(row) {
  return row.platform || row.Platform || "";
}

function normalizeRecallValue(row) {
  // recall_id is the campaign column itself (dim_campaign.campaign) unless
  // an explicit recall/recall_id column is present — each campaign IS a recall.
  return row.recall || row.Recall || row.recall_id || row.Recall_ID || normalizeCampaignValue(row);
}

function makeRowId(row) {
  // Row grain is campaign × country × date; all three must be in the key or
  // rows of the same campaign collapse into one entry when merging deltas.
  const campaign = (row.campaign || row.Campaign || row.campaign_id || row.id || row.name || "").toString();
  const country = (row.country_iso || row.iso || row.country || "").toString();
  const date = (row.date || row.Date || "").toString();
  if (campaign) return `campaign:${campaign}|${country}|${date}`;
  const recall = (row.recall || row.Recall || row.recall_id || row.Recall_ID || "").toString();
  const tech = (row.updated_technology || row.Update_Technology || row.update_technology || "").toString();
  const platform = (row.platform || row.Platform || "").toString();
  return `fallback:${country}||${recall}||${tech}||${platform}||${date}`;
}

function buildCountryLookup(rows) {
  const lookup = new Map();
  for (const row of rows) {
    const iso = row.country_iso ?? row.iso ?? row.id;
    if (!iso) continue;
    lookup.set(iso, {
      country: normalizeCountryValue(row),
      region: normalizeRegionValue(row),
    });
  }
  return lookup;
}

function buildCampaignLookup(rows) {
  const lookup = new Map();
  for (const row of rows) {
    const campaign = normalizeCampaignValue(row);
    if (!campaign) continue;
    lookup.set(campaign, {
      brand: normalizeBrandValue(row),
      platform: normalizePlatformValue(row),
      recall: normalizeRecallValue(row),
    });
  }
  return lookup;
}

function uniqueDimValues(rows, getter) {
  return [...new Set(rows.map(getter).filter(Boolean))].sort();
}

// Every fact table joins to dim_campaign via `campaign` and to dim_country
// via `country_iso` — those are the two primary keys. This resolves a raw
// fact row's brand/platform/recall_id (from dim_campaign) and country_name/
// region (from dim_country) once, so every downstream consumer (filtering,
// cascading, breakdown charts) can read plain fields instead of re-joining.
function enrichRow(row, campaignLookup, countryLookup) {
  const campaign = normalizeCampaignValue(row);
  const dimCampaign = campaignLookup.get(campaign) || {};
  const countryIso = row.country_iso ?? row.country ?? row.iso ?? "";
  const dimCountry = countryLookup.get(countryIso) || {};
  return {
    ...row,
    brand: row.brand || row.Brand || dimCampaign.brand || "",
    platform: row.platform || row.Platform || dimCampaign.platform || "",
    recall: row.recall || row.Recall || dimCampaign.recall || campaign,
    country_name: dimCountry.country || row.country_name || row.country || "",
    region: dimCountry.region || row.region || row.Region || "",
  };
}

// Some Databricks exports emit a malformed timestamp with a comma or a colon
// instead of a dot before milliseconds (e.g. "2026-04-12T22:16:49:806Z" or
// "...49,806Z" instead of the valid "...49.806Z"), which `Date` cannot parse
// — it silently returns Invalid Date, dropping the row from every date-based
// calculation. The backend now repairs this at the source (transformRow),
// but this stays as a defensive fallback for already-exported CSVs. Normalize
// before parsing.
function normalizeDateString(raw) {
  if (typeof raw !== "string") return raw;
  return raw.replace(/(T\d{2}:\d{2}:\d{2})[,:](\d{3})(Z|[+-]\d{2}:?\d{2})?$/, "$1.$2$3");
}

function parseBackendDate(raw) {
  if (!raw) return null;
  const d = new Date(normalizeDateString(raw));
  return Number.isNaN(d.valueOf()) ? null : d;
}

// filters.from/filters.to bound whichever date-like column a row carries
// (fact_main/fact_adoption_rate use `date`, fact_release uses `rollout_start`).
// Rows without any date column are never excluded by the date filter.
function dateInRange(row, filters) {
  const raw = row.date ?? row.Date ?? row.rollout_start;
  if (!raw) return true;
  const d = parseBackendDate(raw);
  if (!d) return true;
  if (filters.from && d < new Date(filters.from + "T00:00:00")) return false;
  if (filters.to && d > new Date(filters.to + "T23:59:59")) return false;
  return true;
}

// Rows must already be enriched (see enrichRow) so brand/platform/recall/
// country_name/region are plain fields here.
function matchesRowFilters(row, filters) {
  if (filters.brand.length && !filters.brand.includes(row.brand)) return false;
  if (filters.platform.length && !filters.platform.includes(row.platform)) return false;
  if (filters.recall.length && !filters.recall.includes(row.recall)) return false;
  if (filters.region.length && !filters.region.includes(row.region)) return false;
  if (filters.country.length && !filters.country.includes(row.country_name)) return false;
  if (!dateInRange(row, filters)) return false;
  return true;
}

const FILTER_DIMS = ["region", "country", "brand", "platform", "recall"];
const FIELD_FOR_DIM = { region: "region", country: "country_name", brand: "brand", platform: "platform", recall: "recall" };

// Cascading (cross-filter) availability, computed from enriched FACT rows —
// the fact table is the only place `campaign` and `country_iso` appear
// together, so it's the only place that can answer "which regions/countries
// does this brand actually ship to" and vice versa. A dimension's own
// options are computed from the OTHER active filters only, never from its
// own current selection — otherwise picking one Brand would filter every
// row down to that brand and lock out every other brand checkbox, making
// multi-select within a dimension impossible.
function getAvailableDimensionOptions(filters, enrichedRows) {
  const available = Object.fromEntries(FILTER_DIMS.map((d) => [d, new Set()]));
  for (const row of enrichedRows) {
    for (const dim of FILTER_DIMS) {
      const matchesOthers = FILTER_DIMS.every((otherDim) => {
        if (otherDim === dim) return true;
        const sel = filters[otherDim];
        return !sel.length || sel.includes(row[FIELD_FOR_DIM[otherDim]]);
      });
      const v = row[FIELD_FOR_DIM[dim]];
      if (matchesOthers && v) available[dim].add(v);
    }
  }
  return available;
}

function cascadeFilters(filters, available) {
  const out = { ...filters };
  for (const dim of FILTER_DIMS) out[dim] = out[dim].filter((v) => available[dim].has(v));
  return out;
}

// Derive a deterministic scope from the filters: a seed shift so every
// scope draws a different (but stable) series, and the list of active
// selections for display.
function filterScope(filters) {
  const active = [
    ...filters.brand,
    ...filters.region,
    ...filters.country,
    ...filters.platform,
    ...filters.recall,
  ];
  const seedShift = active.join("").split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 89 * 0.37;
  return { seedShift, active };
}

/* ------------------------------------------------------------------ */
/* DLCM release data                                                   */
/* ------------------------------------------------------------------ */
const RELEASES = [
  { id: "15.6.0", date: "12 Jun 2026", vehiclesM: 2.41, success: 96.1, errPer1k: 3.9, avgMin: 64.8, rollout: 78, adoptionCap: 64, tau: 11 },
  { id: "15.5.2", date: "30 Apr 2026", vehiclesM: 3.86, success: 95.8, errPer1k: 4.2, avgMin: 65.9, rollout: 100, adoptionCap: 71, tau: 12 },
  { id: "15.5.0", date: "12 Mar 2026", vehiclesM: 4.52, success: 95.2, errPer1k: 4.8, avgMin: 66.4, rollout: 100, adoptionCap: 69, tau: 13 },
  { id: "15.4.1", date: "28 Jan 2026", vehiclesM: 1.98, success: 96.6, errPer1k: 3.4, avgMin: 67.1, rollout: 100, adoptionCap: 58, tau: 9 },
  { id: "15.4.0", date: "03 Dec 2025", vehiclesM: 4.11, success: 94.7, errPer1k: 5.3, avgMin: 68.0, rollout: 100, adoptionCap: 66, tau: 14 },
  { id: "15.3.0", date: "17 Sep 2025", vehiclesM: 4.63, success: 94.1, errPer1k: 5.9, avgMin: 69.2, rollout: 100, adoptionCap: 67, tau: 15 },
];

// Adoption ramp after release day 0..days: saturating curve + stable noise
function adoptionCurve(release, days = 42) {
  const seed = release.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const out = [];
  for (let d = 0; d <= days; d++) {
    const noise = Math.sin(seed + d * 0.9) * 0.6;
    const v = release.adoptionCap * (1 - Math.exp(-d / release.tau)) + noise;
    out.push(+Math.max(0, v).toFixed(1));
  }
  return out;
}

// Map backend fact_release rows onto the release-register shape; the static
// RELEASES scaffold is only used when the backend has no release data.
function releasesFromRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return RELEASES;
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const id = String(r.release ?? r.version ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      campaign: r.campaign,
      date: (() => {
        const raw = r.rollout_start ?? r.date ?? "";
        const parsed = parseBackendDate(raw);
        return parsed ? parsed.toISOString().slice(0, 10) : String(raw);
      })(),
      vehiclesM: (Number(r.vehicles ?? 0) || 0) / 1e6,
      success: Number(r.success_rate ?? r.success ?? 0) || 0,
      errPer1k: Number(r.err_per_1k ?? r.errPer1k ?? 0) || 0,
      avgMin: Number(r.avg_duration_min ?? r.avgMin ?? 0) || 0,
      rollout: Number(r.rollout_pct ?? r.rollout ?? 0) || 0,
    });
  }
  return out.length ? out : RELEASES;
}

// Adoption ramp for a release from backend fact_adoption_rate rows; falls
// back to the synthetic curve only for the static scaffold entries (which
// carry adoptionCap/tau), otherwise an empty series.
function adoptionSeriesFor(release, adoptionRows) {
  const rows = (adoptionRows || []).filter((r) => release.campaign && (r.campaign ?? "") === release.campaign);
  if (rows.length) {
    return rows
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((r) => Number(r.adoption_rate) || 0);
  }
  return release.adoptionCap != null ? adoptionCurve(release) : [];
}

/* ------------------------------------------------------------------ */
/* KPI registry — single source of truth driving cards + detail pages */
/* ------------------------------------------------------------------ */
const KPIS = [
  {
    id: "updates",
    tier: "primary",
    title: "Successful Vehicle Updates",
    unitLabel: "",
    value: "17.7M",
    d7: "+29.1K", d30: "+179.6K",
    goodWhen: "up",
    icon: CloudUpload,
    insight:
      "MAN shatters its monthly update record: +415% above average, +37% above prior all-time high.",
    insightMeta: "Region: Europe | Brand: MAN | Platform: MQB/MLB",
    seed: 11, base: 240, vol: 18, drift: 2.5,
    detailNote: "Daily successful update completions across the fleet",
    anomalies: [
      { sev: "info", text: "MAN campaign 26-B pushed daily volume +415% above trailing average on 02 Jul." },
      { sev: "info", text: "MEB platform overtook MQB in weekly volume for the first time (w/c 29 Jun)." },
    ],
  },
  {
    id: "quality",
    tier: "primary",
    title: "Quality",
    unitLabel: "errors per 1k successful updates",
    value: "3.9",
    d7: "+0.0", d30: "+0.2",
    goodWhen: "down",
    icon: ShieldAlert,
    insight: null,
    seed: 23, base: 3.7, vol: 0.18, drift: 0.008,
    detailNote: "Error rate normalised per 1,000 successful updates",
    threshold: 4.5,
    anomalies: [
      { sev: "warn", text: "30-day error rate up +0.2 — driven by download timeouts on PPE in China (error code E-4102)." },
      { sev: "info", text: "Rollback rate stable at 0.3/1k; no regression linked to release 15.6.0." },
    ],
  },
  {
    id: "liegenbleiber",
    tier: "primary",
    title: "Liegenbleiber",
    unitLabel: "errors per 1k successful updates",
    value: "0.6",
    d7: "+0.0", d30: "+0.0",
    goodWhen: "down",
    icon: CarFront,
    insight: null,
    seed: 31, base: 0.6, vol: 0.05, drift: 0,
    detailNote: "Vehicles immobilised after an update, per 1,000 successful updates",
    threshold: 1.0,
    anomalies: [
      { sev: "info", text: "No immobilisation cluster detected in the last 30 days. All incidents isolated and recovered < 4h." },
    ],
  },
  {
    id: "adoption",
    tier: "secondary",
    title: "Adoption Rate",
    unitLabel: "vehicles updated within 60 days of target",
    value: "0",
    d7: "+0", d30: "+0",
    goodWhen: "up",
    icon: Users,
    seed: 41, base: 34.2, vol: 0.5, drift: 0.02,
    detailNote: "Successful updates completed within 60 days of the targeted date",
    anomalies: [
      { sev: "warn", text: "Adoption flat for 30 days — consent-screen drop-off at 41% suggests UX friction in the in-car prompt." },
    ],
  },
  {
    id: "duration",
    tier: "secondary",
    title: "Installation Duration",
    unitLabel: "in min",
    value: "65.2",
    d7: "-0.1", d30: "-0.4",
    goodWhen: "down",
    icon: Timer,
    seed: 53, base: 66, vol: 0.6, drift: -0.02,
    detailNote: "Mean end-to-end installation time per update",
    anomalies: [
      { sev: "info", text: "p90 duration improved 3.1 min after delta-package rollout on MEB." },
    ],
  },
  {
    id: "cost",
    tier: "secondary",
    title: "Cost Savings",
    unitLabel: "in €",
    value: "2.0bn",
    d7: "+3.9M", d30: "+25.5M",
    goodWhen: "up",
    icon: Euro,
    seed: 61, base: 1.1, vol: 0.15, drift: 0.03,
    detailNote: "Cumulative avoided workshop, recall and logistics cost (€, daily increment in M)",
    anomalies: [
      { sev: "info", text: "Recall ID R-2214 fully resolved OTA — est. €14.2M workshop cost avoided." },
    ],
  },
  {
    id: "co2",
    tier: "secondary",
    title: "CO₂ Savings",
    unitLabel: "in tonnes",
    value: "66.5M",
    d7: "+83", d30: "+523",
    goodWhen: "up",
    icon: Leaf,
    seed: 71, base: 18, vol: 2.2, drift: 0.15,
    detailNote: "Avoided emissions from workshop trips (daily increment, tonnes)",
    anomalies: [
      { sev: "info", text: "Cumulative savings equivalent to ~14,700 average EU passenger-car years." },
    ],
  },
];

// Maps each KPI to the fact_ai_summaries_facts_v3_int.metric_domains value
// it corresponds to, so the AI Insights panel can prioritize the summary
// row that's actually about the KPI being viewed. Casing matches the real
// export (`Co2_savings` is capitalized there; the rest are snake_case).
const KPI_METRIC_DOMAIN = {
  updates: "successful_updates",
  quality: "quality",
  liegenbleiber: "liegenbleiber",
  adoption: "adoption_rate",
  duration: "installation_duration",
  cost: "cost_savings",
  co2: "Co2_savings",
};

// Summaries for this KPI whose brand/platform/region are compatible with
// the currently active filters. An unset filter dimension imposes no
// constraint; a summary's region: "ALL" always counts as a match since that
// value means "not region-scoped". Returns [] rather than falling back to
// an unrelated summary — a mismatched filter selection should show nothing,
// not a misleading insight for a different scope.
function summariesMatchingScope(aiSummaries, kpiId, filters) {
  if (!aiSummaries || !aiSummaries.length) return [];
  const domain = (KPI_METRIC_DOMAIN[kpiId] || "").toLowerCase();
  return aiSummaries
    .filter((s) => {
      if ((s.metric_domains || "").toLowerCase() !== domain) return false;
      if (filters.region.length && s.region !== "ALL" && !filters.region.includes(s.region)) return false;
      if (filters.brand.length && !filters.brand.includes(s.brand)) return false;
      if (filters.platform.length && !filters.platform.includes(s.platform)) return false;
      return true;
    })
    .sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99));
}

// Matches the static registry's scope-label style ("Region: Europe | Brand:
// MAN | Platform: MQB/MLB") so live and fallback insight meta lines read the
// same — Region/Brand/Platform only, nothing else.
function formatInsightMeta(s) {
  const region = s.region === "ALL" ? "All regions" : s.region;
  return `Region: ${region} | Brand: ${s.brand} | Platform: ${s.platform}`;
}

const deltaColor = (raw, goodWhen) => {
  const num = parseFloat(String(raw).replace(/[^\d.-]/g, ""));
  if (!num) return C.bad; // flat deltas render red, matching the source Power BI dashboard
  const positive = num > 0;
  const good = goodWhen === "up" ? positive : !positive;
  return good ? C.good : C.bad;
};

// No usable backend data for this KPI — show a real zero instead of a
// plausible-looking sample number, so an empty/broken data source never
// reads as an actual result.
function zeroedKpi(kpi) {
  return {
    ...kpi,
    value: formatKpiValue(0, kpi.id),
    d7: formatKpiDelta(0, kpi.id),
    d30: formatKpiDelta(0, kpi.id),
  };
}

function getNumericField(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null || value === "") continue;
    const num = Number(value);
    if (!Number.isNaN(num)) return num;
  }
  return 0;
}

function sumField(rows, keys) {
  return rows.reduce((sum, row) => sum + getNumericField(row, keys), 0);
}

function averageField(rows, keys) {
  if (!rows.length) return null;
  const total = rows.reduce((sum, row) => sum + getNumericField(row, keys), 0);
  return total / rows.length;
}

function formatLargeNumber(value) {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}bn`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return `${value.toFixed(1)}`;
}

// In local mode the backend ships fact_main pre-aggregated into a cube whose
// rows carry summed components (marked `_agg`) rather than raw per-event
// fields. Because every KPI is a sum or a ratio-of-sums, the exact
// whole-dataset value, per-day series value and windowed delta all
// reconstruct from those sums — so this branch produces identical numbers to
// the raw-row path below, over a dataset ~1000x smaller.
function valueForKpiAgg(rows, kpiId) {
  const sum = (key) => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
  switch (kpiId) {
    case "updates":
      return sum("successful_updates");
    case "quality": {
      // (SUM(quality) / SUM(successful_updates)) * 1000
      const totalUpdates = sum("successful_updates");
      return totalUpdates ? (sum("_quality_sum") / totalUpdates) * 1000 : null;
    }
    case "liegenbleiber": {
      // ((SUM(lb_common+lb_backend+lb_aftersales)) / SUM(successful_updates)) * 1000
      const totalUpdates = sum("successful_updates");
      const lb = sum("lb_common_vehicles") + sum("lb_backend_vehicles") + sum("lb_aftersales_vehicles");
      return totalUpdates ? (lb / totalUpdates) * 1000 : null;
    }
    case "adoption":
      // SUM(successful_updates) from fact_adoption_rate, already pre-filtered
      // server-side to rows where (successful_update_date - targeted_date)
      // <= 60 days — see buildAdoptionRateAggregate in server.js. `rows` here
      // is the adoption cube, not the fact_main cube (see rowsForKpi).
      return sum("successful_updates");
    case "duration": {
      // SUM(installation_duration i.e. downtime_minutes) / SUM(update_operations)
      const installs = sum("update_operations");
      return installs ? sum("downtime_minutes") / installs : null;
    }
    case "cost":
      return sum("cost_savings");
    case "co2":
      return sum("co2_savings");
    default:
      return null;
  }
}

function valueForKpi(rows, kpiId) {
  if (!rows || !rows.length) return null;
  if (rows[0] && rows[0]._agg) return valueForKpiAgg(rows, kpiId);
  switch (kpiId) {
    case "updates":
      return sumField(rows, ["successful_updates"]);
    case "quality": {
      // (SUM(quality) / SUM(successful_updates)) * 1000
      const totalUpdates = sumField(rows, ["successful_updates"]);
      const totalQuality = sumField(rows, ["quality"]);
      return totalUpdates ? (totalQuality / totalUpdates) * 1000 : null;
    }
    case "liegenbleiber": {
      // ((SUM(lb_common+lb_backend+lb_aftersales)) / SUM(successful_updates)) * 1000
      const totalUpdates = sumField(rows, ["successful_updates"]);
      const lb = sumField(rows, ["lb_common_vehicles", "lb_backend_vehicles", "lb_aftersales_vehicles"]);
      return totalUpdates ? (lb / totalUpdates) * 1000 : null;
    }
    case "adoption":
      // SUM(successful_updates) from fact_adoption_rate rows already
      // pre-filtered to the 60-day eligibility window (see rowsForKpi).
      return sumField(rows, ["successful_updates"]);
    case "duration": {
      // SUM(installation_duration i.e. downtime_minutes) / SUM(update_operations)
      const installs = sumField(rows, ["update_operations"]);
      const duration = sumField(rows, ["downtime_minutes"]);
      return installs ? duration / installs : null;
    }
    case "cost":
      return sumField(rows, ["cost_savings"]);
    case "co2":
      return sumField(rows, ["co2_savings"]);
    default:
      return null;
  }
}

function formatKpiValue(value, kpiId) {
  if (value == null || Number.isNaN(value)) return "N/A";
  switch (kpiId) {
    case "updates":
      return formatLargeNumber(value);
    case "quality":
    case "liegenbleiber":
    case "duration":
      return `${value.toFixed(1)}`;
    case "adoption":
    case "cost":
    case "co2":
      return formatLargeNumber(value);
    default:
      return `${value}`;
  }
}

function formatKpiDelta(delta, kpiId) {
  if (delta == null || Number.isNaN(delta)) return null;
  const sign = delta < 0 ? "-" : "+";
  const abs = Math.abs(delta);
  switch (kpiId) {
    case "updates":
    case "cost":
    case "co2":
    case "adoption":
      return `${sign}${formatLargeNumber(abs)}`;
    default:
      return `${sign}${abs.toFixed(1)}`;
  }
}

// KPI change over the trailing window vs the window before it.
function deltaForKpi(rows, kpiId, days) {
  if (!rows || !rows.length) return null;
  const DAY = 24 * 60 * 60 * 1000;
  const dated = [];
  for (const row of rows) {
    const raw = row.date ?? row.Date;
    const parsed = parseBackendDate(raw);
    if (parsed) dated.push({ row, time: parsed.valueOf() });
  }
  if (!dated.length) return null;
  // Not Math.max(...dated.map(...)) — spreading one argument per array
  // element blows V8's call-stack argument limit once rows are in the
  // hundreds of thousands (real dataset scale), throwing "Maximum call
  // stack size exceeded" and crashing the whole render.
  let end = -Infinity;
  for (const d of dated) if (d.time > end) end = d.time;
  const currStart = end - days * DAY;
  const prevStart = end - 2 * days * DAY;
  const curr = dated.filter((d) => d.time > currStart).map((d) => d.row);
  const prev = dated.filter((d) => d.time > prevStart && d.time <= currStart).map((d) => d.row);
  if (!curr.length || !prev.length) return null;
  const a = valueForKpi(curr, kpiId);
  const b = valueForKpi(prev, kpiId);
  if (a == null || b == null) return null;
  return a - b;
}

// Adoption Rate is computed from fact_adoption_rate's own cube, not
// fact_main — every other KPI here uses fact_main's.
function rowsForKpi(kpiId, factMainRows, adoptionRows) {
  return kpiId === "adoption" ? adoptionRows : factMainRows;
}

function runtimeKpi(kpi, rows) {
  const actualValue = valueForKpi(rows, kpi.id);
  // No usable backend data: show zero rather than the static registry
  // sample values — a plausible-looking number with no real data behind it
  // would mislead whoever's reading the dashboard.
  if (actualValue == null) return zeroedKpi(kpi);
  const d7 = formatKpiDelta(deltaForKpi(rows, kpi.id, 7), kpi.id);
  const d30 = formatKpiDelta(deltaForKpi(rows, kpi.id, 30), kpi.id);
  return {
    ...kpi,
    value: formatKpiValue(actualValue, kpi.id),
    d7: d7 ?? kpi.d7,
    d30: d30 ?? kpi.d30,
  };
}

function buildKpiSeries(rows, kpiId, range) {
  if (!rows || !rows.length) return [];
  const dateMap = new Map();
  for (const row of rows) {
    const rawDate = row.date ?? row.Date;
    const parsed = parseBackendDate(rawDate);
    if (!parsed) continue;
    const key = parsed.toISOString().slice(0, 10);
    const bucket = dateMap.get(key) || [];
    bucket.push(row);
    dateMap.set(key, bucket);
  }
  const series = Array.from(dateMap.entries())
    .map(([key, bucket]) => ({
      date: new Date(key),
      value: valueForKpi(bucket, kpiId) ?? 0,
    }))
    .sort((a, b) => a.date - b.date);
  const trimmed = range && series.length > range ? series.slice(-range) : series;
  return trimmed.map((item) => ({
    date: item.date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
    value: Number(item.value.toFixed(2)),
  }));
}

function buildKpiBreakdown(rows, kpiId, dimension) {
  if (!rows || !rows.length) return [];
  // Ratio-based KPIs (quality, liegenbleiber, duration) must be computed once
  // over each group's rows, not per-row-then-summed — summing per-row ratios
  // is not the same as the group's true ratio-of-sums.
  const groups = new Map();
  for (const row of rows) {
    const key = row[dimension] ?? row[dimension.charAt(0).toUpperCase() + dimension.slice(1)] ?? "Unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Array.from(groups.entries())
    .map(([name, groupRows]) => ({ name, value: valueForKpi(groupRows, kpiId) ?? 0 }))
    .sort((a, b) => b.value - a.value);
}

/* ------------------------------------------------------------------ */
/* Shared chrome                                                       */
/* ------------------------------------------------------------------ */
// Sun/moon pill switch; the active side is highlighted
function ThemeToggle({ theme, onToggle }) {
  const seg = (active) => ({
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 22, height: 18, borderRadius: 9,
    background: active ? C.accent : "transparent",
    color: active ? C.onAccent : C.dim,
    transition: "background 0.15s",
  });
  return (
    <button
      onClick={onToggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      className="flex items-center gap-0.5 p-0.5 rounded-full cursor-pointer"
      style={{ background: C.inputBg, border: `1px solid ${C.cardBorderSoft}` }}
    >
      <span style={seg(theme === "light")}><Sun size={12} /></span>
      <span style={seg(theme === "dark")}><Moon size={12} /></span>
    </button>
  );
}

function TopBar({ theme, onToggleTheme, navOpen, onToggleNav }) {
  return (
    <div
      className="flex items-center justify-between px-4 py-2 shrink-0"
      style={{ background: C.topbar, borderBottom: `1px solid ${C.cardBorderSoft}` }}
    >
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleNav}
          aria-pressed={navOpen}
          title={navOpen ? "Hide navigation" : "Show navigation"}
          className="flex items-center justify-center p-1.5 rounded-md hover:opacity-80"
          style={{ background: navOpen ? C.inputBg : "transparent", border: `1px solid ${C.cardBorderSoft}` }}
        >
          <Menu size={15} color={C.text} />
        </button>
        <Home size={18} color={C.text} />
        <span className="tracking-widest font-semibold" style={{ color: C.text, letterSpacing: "0.35em" }}>
          CARIAD
        </span>
        <span style={{ color: C.faint }}>|</span>
        <span className="font-semibold text-lg" style={{ color: C.text }}>
          KPI Dashboard on OTA Performance
        </span>
      </div>
      <div className="hidden md:flex items-center gap-5 text-xs" style={{ color: C.dim }}>
        <span>Sensitivity: <b style={{ color: C.text }}>Internal</b></span>
        <span>Last Refresh: <b style={{ color: C.text }}>07/07/2026</b></span>
        <span>Version: <b style={{ color: C.text }}>15.6.0</b></span>
        <BookOpen size={16} /> <Info size={16} /> <Mail size={16} />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
    </div>
  );
}

/* Left-hand KPI page navigation. Order is the sequence the user asked for,
   independent of the primary/secondary grouping used on the Overview grid. */
const NAV_ORDER = ["updates", "co2", "cost", "adoption", "quality", "liegenbleiber", "duration"];
const NAV_WIDTH = 230;

// Blinking green dot + "Live" when the backend is querying Databricks;
// a static dot + "Connected — Local data" when it's serving data/*.csv.
function ConnectionStatus({ loading, error, dataMode }) {
  if (loading) return <span className="text-xs" style={{ color: C.dim }}>Loading backend…</span>;
  if (error) return <span className="text-xs truncate" style={{ color: C.bad }}>Backend error: {error}</span>;
  if (!dataMode) return null;
  const isLive = dataMode === "live";
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span
        className={isLive ? "animate-pulse" : ""}
        style={{ width: 8, height: 8, borderRadius: 9999, background: isLive ? C.good : C.accent, flexShrink: 0 }}
      />
      <span className="text-xs truncate" style={{ color: C.dim }}>
        {isLive ? "Live" : "Connected — Local data"}
      </span>
    </div>
  );
}

function SideNav({ open, onClose, route, onNavigate, backendLoading, backendError, dataMode }) {
  const activeId = route.page === "detail" ? route.kpiId : null;
  const item = (active, onClick, icon, label, key) => (
    <button
      key={key}
      onClick={onClick}
      className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-left w-full shrink-0"
      style={{
        color: active ? C.text : C.dim,
        background: active ? `${C.accent}1f` : "transparent",
        borderLeft: `3px solid ${active ? C.accent : "transparent"}`,
        fontWeight: active ? 700 : 500,
      }}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
  return (
    <div
      className="shrink-0 overflow-hidden flex flex-col"
      style={{ width: open ? NAV_WIDTH : 0, transition: "width 0.2s ease", background: C.panel, borderRight: open ? `1px solid ${C.cardBorderSoft}` : "none" }}
    >
      <div style={{ width: NAV_WIDTH }} className="flex flex-col h-full">
        <div className="flex items-center justify-between px-3 py-2 shrink-0" style={{ borderBottom: `1px solid ${C.cardBorderSoft}` }}>
          <span className="text-xs font-bold tracking-widest" style={{ color: C.accent }}>KPI PAGES</span>
          <button onClick={onClose} aria-label="Hide navigation" className="p-1 rounded hover:opacity-70" style={{ color: C.dim }}>
            <ChevronLeft size={15} />
          </button>
        </div>
        {item(route.page === "overview", () => onNavigate({ page: "overview" }), <Home size={15} color={route.page === "overview" ? C.accent : C.dim} />, "Dashboard Overview", "overview")}
        <div className="flex-1 overflow-auto py-1" style={{ borderTop: `1px solid ${C.cardBorderSoft}` }}>
          {NAV_ORDER.map((id) => {
            const kpi = KPIS.find((k) => k.id === id);
            const Icon = kpi.icon;
            const active = activeId === id;
            return item(active, () => onNavigate({ page: "detail", kpiId: id }), <Icon size={15} color={active ? C.accent : C.dim} />, kpi.title, id);
          })}
        </div>
        <div className="px-3 py-2 shrink-0" style={{ borderTop: `1px solid ${C.cardBorderSoft}`, background: C.panel }}>
          <ConnectionStatus loading={backendLoading} error={backendError} dataMode={dataMode} />
        </div>
      </div>
    </div>
  );
}

// Vertical section label (reads bottom-to-top, as in the Power BI original)
function VLabel({ children }) {
  return (
    <span
      className="text-xs font-bold self-center"
      style={{ color: C.accent, writingMode: "vertical-rl", transform: "rotate(180deg)", letterSpacing: "0.2em" }}
    >
      {children}
    </span>
  );
}

/* Date range slider: maps the filter window onto day offsets 0..TOTAL_DAYS */
const RANGE_MIN = new Date("2021-01-01T00:00:00");
const RANGE_MAX = new Date("2026-07-07T00:00:00");
const DAY_MS = 86400000;
const TOTAL_DAYS = Math.round((RANGE_MAX - RANGE_MIN) / DAY_MS);

const dateToDays = (s) => {
  const d = Math.round((new Date(s + "T00:00:00") - RANGE_MIN) / DAY_MS);
  return Number.isFinite(d) ? Math.min(TOTAL_DAYS, Math.max(0, d)) : 0;
};
const daysToDate = (n) => {
  const d = new Date(RANGE_MIN.getTime() + n * DAY_MS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function DateRangeSlider({ from, to, onChange }) {
  const f = dateToDays(from);
  const t = dateToDays(to);
  const pf = (f / TOTAL_DAYS) * 100;
  const pt = (t / TOTAL_DAYS) * 100;
  return (
    <div className="range-slider relative" style={{ height: 18 }}>
      <div className="absolute rounded-full" style={{ top: 7, left: 0, right: 0, height: 4, background: C.inputBg, border: `1px solid ${C.cardBorderSoft}` }} />
      <div className="absolute rounded-full" style={{ top: 7, left: `${pf}%`, width: `${Math.max(pt - pf, 0)}%`, height: 4, background: C.accent }} />
      <input
        type="range" min={0} max={TOTAL_DAYS} value={f} aria-label="From date"
        onChange={(e) => onChange(daysToDate(Math.min(+e.target.value, t)), to)}
      />
      <input
        type="range" min={0} max={TOTAL_DAYS} value={t} aria-label="To date"
        onChange={(e) => onChange(from, daysToDate(Math.max(+e.target.value, f)))}
      />
    </div>
  );
}

/* Multi-select dropdown with checkboxes. `options` is a plain list of
   values already cascaded down to what's relevant given the other active
   filters — values cascaded away by other filters simply aren't listed. */
function MultiSelect({ label, values, options, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = (v) =>
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  const summary =
    values.length === 0 ? "All" : values.length <= 2 ? values.join(", ") : `${values.length} selected`;

  return (
    <div className="flex flex-col gap-1 min-w-0 relative" ref={ref}>
      <label className="text-xs font-semibold" style={{ color: C.dim }}>{label}</label>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded px-2 py-1.5 text-sm w-full flex items-center justify-between gap-1"
        style={{ background: C.inputBg, color: C.text, border: `1px solid ${open ? C.accent : C.cardBorderSoft}` }}
      >
        <span className="truncate">{summary}</span>
        <ChevronRight size={13} style={{ transform: `rotate(${open ? -90 : 90}deg)`, flexShrink: 0 }} color={C.dim} />
      </button>
      {open && (
        <div
          className="absolute left-0 right-0 rounded-lg py-1 z-50 shadow-xl"
          style={{ top: "100%", marginTop: 4, background: C.tooltipBg, border: `1px solid ${C.cardBorder}`, minWidth: 150 }}
        >
          <button
            type="button"
            onClick={() => { onChange([]); setOpen(false); }}
            className="w-full text-left px-2 py-1 text-xs font-semibold hover:opacity-80"
            style={{ color: C.accent }}
          >
            All ({label})
          </button>
          {options.length === 0 && (
            <div className="px-2 py-1 text-xs" style={{ color: C.faint }}>No matching options</div>
          )}
          {options.map((v) => (
            <label key={v} className="flex items-center gap-2 px-2 py-1 text-sm" style={{ color: C.text, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={values.includes(v)}
                onChange={() => toggle(v)}
                style={{ accentColor: C.accent }}
              />
              {v}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/* Region filter with countries nested inside, each region expandable to
   reveal its countries (Power BI hierarchy-slicer style). The region
   checkbox drives `filters.region`; a country checkbox under an expanded
   region drives `filters.country` independently — you don't need to check
   the region to pick one of its countries. */
function RegionCountryFilter({ label, regionValues, countryValues, regionCountryMap, regionAvailable, countryAvailable, onRegionChange, onCountryChange }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggleRegion = (r) => onRegionChange(regionValues.includes(r) ? regionValues.filter((x) => x !== r) : [...regionValues, r]);
  const toggleCountry = (c) => onCountryChange(countryValues.includes(c) ? countryValues.filter((x) => x !== c) : [...countryValues, c]);
  const toggleExpand = (r) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(r)) next.delete(r); else next.add(r);
    return next;
  });

  const regions = [...regionCountryMap.keys()].filter((r) => regionAvailable.has(r)).sort();
  const summaryParts = [];
  if (regionValues.length) summaryParts.push(regionValues.length <= 2 ? regionValues.join(", ") : `${regionValues.length} regions`);
  if (countryValues.length) summaryParts.push(countryValues.length <= 2 ? countryValues.join(", ") : `${countryValues.length} countries`);
  const summary = summaryParts.length ? summaryParts.join(" · ") : "All";

  return (
    <div className="flex flex-col gap-1 min-w-0 relative" ref={ref}>
      <label className="text-xs font-semibold" style={{ color: C.dim }}>{label}</label>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded px-2 py-1.5 text-sm w-full flex items-center justify-between gap-1"
        style={{ background: C.inputBg, color: C.text, border: `1px solid ${open ? C.accent : C.cardBorderSoft}` }}
      >
        <span className="truncate">{summary}</span>
        <ChevronRight size={13} style={{ transform: `rotate(${open ? -90 : 90}deg)`, flexShrink: 0 }} color={C.dim} />
      </button>
      {open && (
        <div
          className="absolute left-0 right-0 rounded-lg py-1 z-50 shadow-xl overflow-y-auto"
          style={{ top: "100%", marginTop: 4, background: C.tooltipBg, border: `1px solid ${C.cardBorder}`, minWidth: 220, maxHeight: 320 }}
        >
          <button
            type="button"
            onClick={() => { onRegionChange([]); onCountryChange([]); setOpen(false); }}
            className="w-full text-left px-2 py-1 text-xs font-semibold hover:opacity-80"
            style={{ color: C.accent }}
          >
            All ({label})
          </button>
          {regions.length === 0 && (
            <div className="px-2 py-1 text-xs" style={{ color: C.faint }}>No matching options</div>
          )}
          {regions.map((region) => {
            const countries = (regionCountryMap.get(region) || []).filter((c) => countryAvailable.has(c));
            const isExpanded = expanded.has(region);
            return (
              <div key={region}>
                <div className="flex items-center gap-1 px-1 py-0.5">
                  <button
                    type="button"
                    onClick={() => toggleExpand(region)}
                    className="p-0.5 rounded hover:opacity-70 shrink-0"
                    style={{ color: C.dim }}
                    aria-label={isExpanded ? `Collapse ${region}` : `Expand ${region}`}
                    aria-expanded={isExpanded}
                  >
                    <ChevronRight size={12} style={{ transform: `rotate(${isExpanded ? 90 : 0}deg)`, transition: "transform 0.15s" }} />
                  </button>
                  <label className="flex items-center gap-2 px-1 py-0.5 text-sm flex-1 min-w-0" style={{ color: C.text, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={regionValues.includes(region)}
                      onChange={() => toggleRegion(region)}
                      style={{ accentColor: C.accent }}
                    />
                    <span className="truncate">{region}</span>
                  </label>
                </div>
                {isExpanded && (
                  <div className="flex flex-col" style={{ marginLeft: 26 }}>
                    {countries.map((country) => (
                      <label key={country} className="flex items-center gap-2 px-2 py-0.5 text-sm" style={{ color: C.text, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={countryValues.includes(country)}
                          onChange={() => toggleCountry(country)}
                          style={{ accentColor: C.accent }}
                        />
                        <span className="truncate">{country}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Select({ label, value, options, onChange }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label className="text-xs font-semibold" style={{ color: C.dim }}>{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded px-2 py-1.5 text-sm w-full"
        style={{ background: C.inputBg, color: C.text, border: `1px solid ${C.cardBorderSoft}` }}
      >
        <option>All</option>
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </div>
  );
}

function FilterBar({ filters, setFilters, regionCountryMap, brandOptions, platformOptions, recallOptions, enrichedRows, filterCatalog }) {
  // Cascading availability must be recomputed from the actual rows on every
  // filter change — the server's filterCatalog is a single whole-dataset
  // snapshot fetched once, so using it directly here made every dimension
  // always show its full, un-narrowed option list regardless of what else
  // was selected. Only fall back to it before any rows have loaded yet, so
  // the dropdowns aren't empty during the initial fetch.
  const available = useMemo(() => {
    if (enrichedRows && enrichedRows.length) {
      return getAvailableDimensionOptions(filters, enrichedRows);
    }
    if (filterCatalog) {
      return {
        region: new Set(filterCatalog.regions || []),
        country: new Set(filterCatalog.countries || []),
        brand: new Set(filterCatalog.brands || []),
        platform: new Set(filterCatalog.platforms || []),
        recall: new Set(filterCatalog.recalls || []),
      };
    }
    return getAvailableDimensionOptions(filters, enrichedRows);
  }, [filterCatalog, filters, enrichedRows]);
  const set = (k) => (v) => setFilters((f) => ({ ...f, [k]: v }));
  // A change in one dimension re-cascades the others using actual dimension availability.
  const setDim = (dim) => (vals) => setFilters((f) => {
    const next = { ...f, [dim]: vals };
    const nextAvailable = getAvailableDimensionOptions(next, enrichedRows);
    return cascadeFilters(next, nextAvailable);
  });
  const reset = () => setFilters(DEFAULT_FILTERS);
  const scope = filterScope(filters);
  const optsFor = (dim, all) => all.filter((v) => available[dim].has(v));
  return (
    <div
      className="flex flex-wrap items-end gap-3 px-4 py-2 shrink-0"
      style={{ background: C.panel, borderBottom: `1px solid ${C.cardBorderSoft}` }}
    >
      <VLabel>SCOPE</VLabel>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-1 min-w-0" style={{ maxWidth: 960 }}>
        <RegionCountryFilter
          label="Region"
          regionValues={filters.region}
          countryValues={filters.country}
          regionCountryMap={regionCountryMap}
          regionAvailable={available.region}
          countryAvailable={available.country}
          onRegionChange={setDim("region")}
          onCountryChange={setDim("country")}
        />
        <MultiSelect label="Brand" values={filters.brand} options={optsFor("brand", brandOptions)} onChange={setDim("brand")} />
        <MultiSelect label="Platform" values={filters.platform} options={optsFor("platform", platformOptions)} onChange={setDim("platform")} />
        <MultiSelect label="Recall ID" values={filters.recall} options={optsFor("recall", recallOptions)} onChange={setDim("recall")} />
      </div>
      <div className="flex items-stretch gap-2">
        <VLabel>TIME</VLabel>
        <div className="flex flex-col justify-center gap-1.5" style={{ width: 270 }}>
          <div className="flex items-center gap-2">
            <input type="date" value={filters.from} min="2021-01-01" max="2026-07-07"
              onChange={(e) => set("from")(e.target.value)}
              className="rounded px-2 py-1 text-xs flex-1 min-w-0"
              style={{ background: C.inputBg, color: C.text, border: `1px solid ${C.cardBorderSoft}`, colorScheme: "dark" }} />
            <span style={{ color: C.faint }}>–</span>
            <input type="date" value={filters.to} min="2021-01-01" max="2026-07-07"
              onChange={(e) => set("to")(e.target.value)}
              className="rounded px-2 py-1 text-xs flex-1 min-w-0"
              style={{ background: C.inputBg, color: C.text, border: `1px solid ${C.cardBorderSoft}`, colorScheme: "dark" }} />
          </div>
          <DateRangeSlider from={filters.from} to={filters.to}
            onChange={(nf, nt) => setFilters((f) => ({ ...f, from: nf, to: nt }))} />
        </div>
        <button onClick={reset}
          className="flex flex-col items-center justify-center gap-0.5 px-2 py-1 rounded text-xs hover:opacity-80"
          style={{ color: C.dim }}>
          <RotateCcw size={16} color={C.accent} />
          Clear filters
        </button>
      </div>
      {scope.active.length > 0 && (
        <div className="w-full flex items-center gap-2 flex-wrap pt-1">
          <Filter size={13} color={C.accent} />
          <span className="text-xs" style={{ color: C.dim }}>Active scope:</span>
          {scope.active.map((a) => (
            <span key={a} className="text-xs px-2 py-0.5 rounded-full font-semibold"
              style={{ background: "rgba(77,163,255,0.12)", border: "1px solid rgba(77,163,255,0.35)", color: C.accent }}>
              {a}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DeltaPair({ kpi, size = "sm" }) {
  const cls = size === "sm" ? "text-xs" : "text-sm";
  return (
    <div className="flex items-stretch mt-1">
      <div className="flex-1 flex flex-col items-center gap-0.5 px-1">
        <span className={cls + " font-semibold"} style={{ color: C.text }}>Last 7 Days</span>
        <span className={cls + " font-bold"} style={{ color: deltaColor(kpi.d7, kpi.goodWhen) }}>{kpi.d7}</span>
      </div>
      <div style={{ width: 1, background: C.cardBorderSoft }} />
      <div className="flex-1 flex flex-col items-center gap-0.5 px-1">
        <span className={cls + " font-semibold"} style={{ color: C.text }}>Last 30 Days</span>
        <span className={cls + " font-bold"} style={{ color: deltaColor(kpi.d30, kpi.goodWhen) }}>{kpi.d30}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview page                                                       */
/* ------------------------------------------------------------------ */
function KpiCard({ kpi, onOpen, primary }) {
  const Icon = kpi.icon;
  const focused = kpi.id === "updates"; // the dashboard's focus KPI
  const [spinning, setSpinning] = useState(false);

  // Spin the card around its Y axis, then navigate once the effect lands
  const handleOpen = () => {
    if (spinning) return;
    setSpinning(true);
    setTimeout(() => onOpen(kpi.id), 480);
  };

  return (
    <button
      onClick={handleOpen}
      className="text-left p-2.5 hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 w-full h-full flex flex-col"
      style={{
        ...cardStyle(primary && focused),
        cursor: "pointer",
        boxShadow: focused
          ? `0 0 0 1.5px ${C.accent}, 0 6px 26px ${C.accent}55`
          : "0 4px 18px rgba(0,0,0,0.35)",
        transform: spinning ? "rotateY(360deg) scale(0.95)" : undefined,
        transition: "transform 0.48s cubic-bezier(0.45, 0, 0.2, 1), translate 0.15s ease",
        transformStyle: "preserve-3d",
        minHeight: 0,
      }}
      aria-label={`Open ${kpi.title} details`}
    >
      <div className="flex items-start justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex items-center justify-center rounded-full shrink-0"
            style={{ width: 30, height: 30, border: `1.5px solid ${C.text}` }}>
            <Icon size={15} color={C.text} />
          </span>
          <span className="font-bold truncate" style={{ color: C.text }}>
            {kpi.title}{" "}
            {kpi.unitLabel && <span className="font-normal text-xs" style={{ color: C.dim }}>{kpi.unitLabel}</span>}
          </span>
        </div>
        <span className="flex items-center gap-1.5 shrink-0">
          {focused && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
              style={{ background: C.accent, color: C.onAccent, letterSpacing: "0.08em" }}>
              FOCUS KPI
            </span>
          )}
          <Info size={15} color={C.dim} />
        </span>
      </div>

      <div className="flex-1 flex items-center justify-center font-extrabold"
        style={{ color: C.text, fontSize: primary ? "clamp(1.2rem, 3.4vh, 2.5rem)" : "clamp(1.1rem, 3vh, 2rem)", minHeight: 0 }}>
        {kpi.value}
      </div>

      <DeltaPair kpi={kpi} size={primary ? "md" : "sm"} />

      {primary && (
        <div className="pt-1.5 mt-1.5 shrink-0" style={{ borderTop: `1px solid ${C.cardBorderSoft}` }}>
          <div className="flex items-center gap-1 text-xs font-bold" style={{ color: C.amber }}>
            <Sparkles size={12} /> AI Insight
          </div>
          {kpi.insight && (
            <>
              <p className="text-xs mt-0.5 text-center font-medium" style={{
                color: C.text, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
              }}>{kpi.insight}</p>
              <p className="text-xs mt-0.5 text-center truncate" style={{ color: C.dim }}>{kpi.insightMeta}</p>
            </>
          )}
        </div>
      )}
    </button>
  );
}

function DlcmLink({ icon: Icon, l1, l2, disabled, onClick }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl"
      style={{
        background: disabled ? C.disabledBg : `linear-gradient(160deg, ${C.cardTop}, ${C.cardBottom})`,
        border: `1px solid ${disabled ? C.disabledBorder : C.cardBorder}`,
        color: disabled ? C.disabledText : C.text,
        opacity: disabled ? 0.7 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <Icon size={20} color={disabled ? C.disabledText : C.accent} />
      <span className="text-left text-sm leading-tight">
        {l1}<br /><b>{l2}</b>
      </span>
      <ChevronRight size={18} />
    </button>
  );
}

function Overview({ onOpen, onDlcm, filters, filteredRows, filteredAdoptionAggRows, aiSummaries }) {
  // Each primary card's insight is the top-ranked AI summary compatible with
  // this KPI and the active region/brand/platform filters. No match (e.g. a
  // filter combination the AI summaries don't cover) means no insight —
  // the card shows nothing rather than an unrelated or stale one.
  const withLiveInsight = (k) => {
    const s = summariesMatchingScope(aiSummaries, k.id, filters)[0];
    return { ...k, insight: s ? (s.headline || s.fact) : "", insightMeta: s ? formatInsightMeta(s) : "" };
  };
  const primaries = KPIS.filter((k) => k.tier === "primary").map((k) => withLiveInsight(runtimeKpi(k, rowsForKpi(k.id, filteredRows, filteredAdoptionAggRows))));
  const secondaries = KPIS.filter((k) => k.tier === "secondary").map((k) => runtimeKpi(k, rowsForKpi(k.id, filteredRows, filteredAdoptionAggRows)));
  return (
    <div className="px-4 py-1.5 flex flex-col gap-1.5" style={{ minHeight: "100%" }}>
      <section className="flex-[4] min-h-0 flex flex-col">
        <h2 className="text-sm font-extrabold tracking-wide mb-1 shrink-0" style={{ color: C.text }}>PRIMARY KPIs</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 flex-1 min-h-0" style={{ perspective: 1400 }}>
          {primaries.map((k) => <KpiCard key={k.id} kpi={k} onOpen={onOpen} primary />)}
        </div>
      </section>
      <section className="flex-[4] min-h-0 flex flex-col">
        <h2 className="text-sm font-extrabold tracking-wide mb-1 shrink-0" style={{ color: C.text }}>SECONDARY KPIs</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 flex-1 min-h-0" style={{ perspective: 1400 }}>
          {secondaries.map((k) => <KpiCard key={k.id} kpi={k} onOpen={onOpen} />)}
        </div>
      </section>
      <div className="flex flex-wrap gap-3 justify-end shrink-0">
        <DlcmLink icon={BarChart3} l1="DLCM Release" l2="Statistics" onClick={() => onDlcm("Statistics")} />
        <DlcmLink icon={LineChartIcon} l1="DLCM Release" l2="Comparison" onClick={() => onDlcm("Comparison")} />
        <DlcmLink icon={FileText} l1="DLCM Release" l2="Content" disabled />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Detail page                                                         */
/* ------------------------------------------------------------------ */
function Panel({ title, children, right }) {
  return (
    <div className="p-3 rounded-xl" style={{ ...cardStyle(false) }}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold" style={{ color: C.text }}>{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

// Function, not a constant: must pick up the active theme's tokens on each render
const tooltipStyle = () => ({
  background: C.tooltipBg,
  border: `1px solid ${C.cardBorder}`,
  borderRadius: 8,
  color: C.text,
  fontSize: 12,
});

function BackButton({ onBack }) {
  return (
    <button onClick={onBack}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold hover:opacity-80"
      style={{ background: C.inputBg, color: C.text, border: `1px solid ${C.cardBorder}` }}>
      <ArrowLeft size={16} /> Back to Overview
    </button>
  );
}

function NoData({ label = "No data for the current filter selection" }) {
  return (
    <div className="flex items-center justify-center h-full text-sm" style={{ color: C.dim }}>
      {label}
    </div>
  );
}

function Detail({ kpiId, onBack, filters, filteredRows, filteredAdoptionAggRows, aiSummaries }) {
  const scope = filterScope(filters);
  const kpiRows = rowsForKpi(kpiId, filteredRows, filteredAdoptionAggRows);
  const kpi = runtimeKpi(KPIS.find((k) => k.id === kpiId), kpiRows);
  const [range, setRange] = useState(30);
  // Charts render backend rows only — an empty result shows an empty state,
  // never a synthetic series.
  const series = useMemo(() => buildKpiSeries(kpiRows, kpiId, range), [kpiRows, kpiId, range]);
  const byBrand = useMemo(() => buildKpiBreakdown(kpiRows, kpiId, "brand"), [kpiRows, kpiId]);
  const byRegion = useMemo(() => buildKpiBreakdown(kpiRows, kpiId, "region"), [kpiRows, kpiId]);
  // Only summaries compatible with this KPI and the active region/brand/
  // platform filters — a mismatched selection yields [], not a fallback.
  const summaries = useMemo(
    () => summariesMatchingScope(aiSummaries, kpiId, filters),
    [aiSummaries, kpiId, filters]
  );
  const Icon = kpi.icon;
  const trendUp = series.length > 1 ? series[series.length - 1].value >= series[0].value : true;
  const trendGood = kpi.goodWhen === "up" ? trendUp : !trendUp;
  const dimIf = (name, sel) => (sel.length === 0 || sel.includes(name) ? 1 : 0.3);

  return (
    <div className="px-4 py-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackButton onBack={onBack} />
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center rounded-full"
            style={{ width: 40, height: 40, border: `1.5px solid ${C.accent}` }}>
            <Icon size={20} color={C.accent} />
          </span>
          <div>
            <h1 className="text-xl font-extrabold" style={{ color: C.text }}>
              {kpi.title} {kpi.unitLabel && <span className="text-sm font-normal" style={{ color: C.dim }}>({kpi.unitLabel})</span>}
            </h1>
            <p className="text-xs" style={{ color: C.dim }}>
              {kpi.detailNote}
              {scope.active.length > 0 && (
                <span style={{ color: C.accent }}> · scoped to {scope.active.join(" / ")}</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-3xl font-extrabold" style={{ color: C.text }}>{kpi.value}</span>
          <span className="flex items-center gap-1 text-sm font-bold"
            style={{ color: trendGood ? C.good : C.bad }}>
            {trendUp ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
            {kpi.d30} <span className="font-normal text-xs" style={{ color: C.dim }}>/ 30d</span>
          </span>
        </div>
      </div>

      {/* Trend */}
      <Panel
        title="Historical Trend"
        right={
          <div className="flex gap-1">
            {[7, 30, 90].map((r) => (
              <button key={r} onClick={() => setRange(r)}
                className="px-2 py-0.5 rounded text-xs font-semibold"
                style={{
                  background: range === r ? C.accent : C.inputBg,
                  color: range === r ? C.onAccent : C.dim,
                  border: `1px solid ${range === r ? C.accent : C.cardBorderSoft}`,
                }}>
                {r}d
              </button>
            ))}
          </div>
        }
      >
        <div style={{ height: "clamp(140px, 21vh, 320px)" }}>
        {series.length === 0 ? <NoData /> : (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.accent} stopOpacity={0.45} />
                <stop offset="100%" stopColor={C.accent} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={C.cardBorderSoft} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: C.faint, fontSize: 11 }} tickLine={false} axisLine={false}
              interval="preserveStartEnd" minTickGap={28} />
            <YAxis tick={{ fill: C.faint, fontSize: 11 }} tickLine={false} axisLine={false} width={48} domain={["auto", "auto"]} />
            <Tooltip contentStyle={tooltipStyle()} />
            {kpi.threshold && (
              <ReferenceLine y={kpi.threshold} stroke={C.bad} strokeDasharray="6 4"
                label={{ value: `target ceiling ${kpi.threshold}`, fill: C.bad, fontSize: 11, position: "insideTopRight" }} />
            )}
            <Area type="monotone" dataKey="value" stroke={C.accent} strokeWidth={2} fill="url(#g1)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
        )}
        </div>
      </Panel>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Breakdown by Brand">
          <div style={{ height: "clamp(120px, 16vh, 280px)" }}>
          {byBrand.length === 0 ? <NoData /> : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byBrand} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid stroke={C.cardBorderSoft} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: C.faint, fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
              <Tooltip contentStyle={tooltipStyle()} cursor={{ fill: "rgba(77,163,255,0.08)" }} />
              <Bar dataKey="value" radius={[5, 5, 0, 0]} isAnimationActive={false}>
                {byBrand.map((b, i) => (
                  <Cell key={i} fill={CHART[0]} fillOpacity={dimIf(b.name, filters.brand)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          )}
          </div>
        </Panel>
        <Panel title="Breakdown by Region">
          <div style={{ height: "clamp(120px, 16vh, 280px)" }}>
          {byRegion.length === 0 ? <NoData /> : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={byRegion} dataKey="value" nameKey="name" innerRadius="48%" outerRadius="78%"
                paddingAngle={3} stroke={C.panel} isAnimationActive={false}>
                {byRegion.map((r, i) => (
                  <Cell key={i} fill={CHART[i % CHART.length]} fillOpacity={dimIf(r.name, filters.region)} />
                ))}
              </Pie>
              <Tooltip contentStyle={tooltipStyle()} />
              <Legend wrapperStyle={{ fontSize: 12, color: C.dim }} />
            </PieChart>
          </ResponsiveContainer>
          )}
          </div>
        </Panel>
      </div>

      {/* AI insights & anomalies — hidden entirely when the active filters
          don't match any AI summary, rather than showing an empty panel
          or an unrelated one. */}
      {summaries.length > 0 && (
        <Panel title={
          <span className="flex items-center gap-2" style={{ color: C.amber }}>
            <Sparkles size={15} /> AI Insights & Anomalies
          </span>
        }>
          <div className="flex flex-col gap-2">
            {summaries.slice(0, 5).map((s, i) => (
              <div key={i} className="flex items-start gap-2 p-2 rounded-lg"
                style={{ background: "rgba(255,181,71,0.08)", border: "1px solid rgba(255,181,71,0.25)" }}>
                <Sparkles size={15} color={C.amber} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold" style={{ color: C.text }}>{s.headline}</p>
                  <p className="text-sm" style={{ color: C.text }}>{s.fact}</p>
                  <p className="text-xs mt-0.5" style={{ color: C.dim }}>{formatInsightMeta(s)}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DLCM Release Statistics                                             */
/* ------------------------------------------------------------------ */
function DlcmStatistics({ onBack, releaseRows }) {
  const releases = useMemo(() => releasesFromRows(releaseRows), [releaseRows]);
  return (
    <div className="px-4 py-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackButton onBack={onBack} />
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center rounded-full"
            style={{ width: 40, height: 40, border: `1.5px solid ${C.accent}` }}>
            <BarChart3 size={20} color={C.accent} />
          </span>
          <div>
            <h1 className="text-xl font-extrabold" style={{ color: C.text }}>DLCM Release Statistics</h1>
            <p className="text-xs" style={{ color: C.dim }}>Rollout volume and quality per software release</p>
          </div>
        </div>
        <span />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Vehicles Updated per Release (millions)">
          <div style={{ height: "clamp(140px, 24vh, 280px)" }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={releases} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid stroke={C.cardBorderSoft} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="id" tick={{ fill: C.dim, fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: C.faint, fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
              <Tooltip contentStyle={tooltipStyle()} cursor={{ fill: "rgba(77,163,255,0.08)" }}
                formatter={(v) => [`${v}M vehicles`, "Updated"]} />
              <Bar dataKey="vehiclesM" radius={[5, 5, 0, 0]} fill={CHART[0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="Error Rate per Release (per 1k successful updates)">
          <div style={{ height: "clamp(140px, 24vh, 280px)" }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={releases} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid stroke={C.cardBorderSoft} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="id" tick={{ fill: C.dim, fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: C.faint, fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
              <Tooltip contentStyle={tooltipStyle()} cursor={{ fill: "rgba(77,163,255,0.08)" }}
                formatter={(v) => [`${v} / 1k`, "Errors"]} />
              <ReferenceLine y={4.5} stroke={C.bad} strokeDasharray="6 4"
                label={{ value: "target ceiling 4.5", fill: C.bad, fontSize: 11, position: "insideTopLeft" }} />
              <Bar dataKey="errPer1k" radius={[5, 5, 0, 0]} fill={CHART[1]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <Panel title="Release Register">
        <div style={{ overflowX: "auto" }}>
          <table className="w-full text-sm" style={{ color: C.text, borderCollapse: "collapse" }}>
            <thead>
              <tr className="text-xs" style={{ color: C.dim }}>
                {["Release", "GA Date", "Vehicles Updated", "Success Rate", "Errors / 1k", "Avg Duration", "Rollout"].map((h) => (
                  <th key={h} className="text-left font-semibold px-3 py-2"
                    style={{ borderBottom: `1px solid ${C.cardBorder}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={r.id} style={{ borderBottom: `1px solid ${C.cardBorderSoft}` }}>
                  <td className="px-3 py-2 font-bold">{r.id}</td>
                  <td className="px-3 py-2" style={{ color: C.dim }}>{r.date}</td>
                  <td className="px-3 py-2">{r.vehiclesM.toFixed(2)}M</td>
                  <td className="px-3 py-2" style={{ color: r.success >= 95.5 ? C.good : C.amber }}>{r.success}%</td>
                  <td className="px-3 py-2" style={{ color: r.errPer1k <= 4.5 ? C.text : C.bad }}>{r.errPer1k}</td>
                  <td className="px-3 py-2">{r.avgMin} min</td>
                  <td className="px-3 py-2" style={{ minWidth: 140 }}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 rounded-full" style={{ height: 6, background: C.inputBg }}>
                        <div className="rounded-full" style={{ height: 6, width: `${r.rollout}%`, background: r.rollout === 100 ? C.good : C.accent }} />
                      </div>
                      <span className="text-xs" style={{ color: C.dim }}>{r.rollout}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DLCM Release Comparison                                             */
/* ------------------------------------------------------------------ */
function CompareStat({ label, unit, a, b, relA, relB, goodWhen }) {
  const better =
    goodWhen === "up" ? (a === b ? null : a > b ? "A" : "B") : (a === b ? null : a < b ? "A" : "B");
  const cell = (val, tag) => (
    <div className="flex-1 text-center">
      <div className="text-xs font-semibold" style={{ color: C.dim }}>{tag}</div>
      <div className="text-lg font-extrabold"
        style={{ color: better === null ? C.text : (tag === relA ? better === "A" : better === "B") ? C.good : C.text }}>
        {val}{unit}
      </div>
    </div>
  );
  return (
    <div className="p-3 rounded-xl flex flex-col gap-1" style={cardStyle(false)}>
      <div className="text-xs font-bold" style={{ color: C.text }}>{label}</div>
      <div className="flex items-center">
        {cell(a, relA)}
        <div style={{ width: 1, alignSelf: "stretch", background: C.cardBorderSoft }} />
        {cell(b, relB)}
      </div>
    </div>
  );
}

function DlcmComparison({ onBack, releaseRows, adoptionRows }) {
  const releases = useMemo(() => releasesFromRows(releaseRows), [releaseRows]);
  const [relA, setRelA] = useState(null);
  const [relB, setRelB] = useState(null);
  // Selections must survive the switch from scaffold to live release ids.
  const ids = releases.map((r) => r.id);
  const idA = relA && ids.includes(relA) ? relA : ids[0];
  const idB = relB && ids.includes(relB) && relB !== idA ? relB : ids.find((id) => id !== idA) ?? ids[0];
  const A = releases.find((r) => r.id === idA);
  const B = releases.find((r) => r.id === idB);

  const curveA = useMemo(() => (A ? adoptionSeriesFor(A, adoptionRows) : []), [A, adoptionRows]);
  const curveB = useMemo(() => (B ? adoptionSeriesFor(B, adoptionRows) : []), [B, adoptionRows]);
  const data = useMemo(() => {
    const len = Math.max(curveA.length, curveB.length);
    return Array.from({ length: len }, (_, i) => ({ day: i, [A.id]: curveA[i], [B.id]: curveB[i] }));
  }, [curveA, curveB, A, B]);
  const endValue = (curve) => (curve.length ? curve[Math.min(30, curve.length - 1)] : 0);

  const endLabel = (name, color) => (props) => {
    const { x, y, index } = props;
    if (index !== data.length - 1) return null;
    return (
      <text x={x + 6} y={y + 4} fill={color} fontSize={11} fontWeight={700}>{name}</text>
    );
  };

  return (
    <div className="px-4 py-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackButton onBack={onBack} />
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center rounded-full"
            style={{ width: 40, height: 40, border: `1.5px solid ${C.accent}` }}>
            <LineChartIcon size={20} color={C.accent} />
          </span>
          <div>
            <h1 className="text-xl font-extrabold" style={{ color: C.text }}>DLCM Release Comparison</h1>
            <p className="text-xs" style={{ color: C.dim }}>Adoption ramp and quality, release vs release</p>
          </div>
        </div>
        <div className="flex items-end gap-2">
          <Select label="Release A" value={idA} options={ids.filter((id) => id !== idB)}
            onChange={(v) => v !== "All" && setRelA(v)} />
          <Select label="Release B" value={idB} options={ids.filter((id) => id !== idA)}
            onChange={(v) => v !== "All" && setRelB(v)} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <CompareStat label="Adoption after 30 days" unit="%" goodWhen="up"
          a={+endValue(curveA).toFixed(1)} b={+endValue(curveB).toFixed(1)} relA={A.id} relB={B.id} />
        <CompareStat label="Errors per 1k updates" unit="" goodWhen="down"
          a={A.errPer1k} b={B.errPer1k} relA={A.id} relB={B.id} />
        <CompareStat label="Avg installation duration" unit=" min" goodWhen="down"
          a={A.avgMin} b={B.avgMin} relA={A.id} relB={B.id} />
      </div>

      <Panel title="Adoption Ramp — % of eligible fleet vs days since GA">
        <div style={{ height: "clamp(200px, 42vh, 460px)" }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 60, left: -10, bottom: 0 }}>
            <CartesianGrid stroke={C.cardBorderSoft} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" tick={{ fill: C.faint, fontSize: 11 }} tickLine={false} axisLine={false}
              label={{ value: "days since GA", fill: C.faint, fontSize: 11, position: "insideBottomRight", dy: 8 }} />
            <YAxis tick={{ fill: C.faint, fontSize: 11 }} tickLine={false} axisLine={false} width={40} unit="%" />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v) => `${v}%`} labelFormatter={(d) => `Day ${d}`} />
            <Legend wrapperStyle={{ fontSize: 12, color: C.dim }} />
            <Line type="monotone" dataKey={A.id} stroke={CHART[0]} strokeWidth={2} dot={false}
              label={endLabel(A.id, CHART[0])} isAnimationActive={false} />
            <Line type="monotone" dataKey={B.id} stroke={CHART[1]} strokeWidth={2} dot={false}
              label={endLabel(B.id, CHART[1])} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App shell + hash routing (deep-linkable: #/detail/quality,          */
/* #/dlcm/statistics, #/dlcm/comparison; back button works)            */
/* ------------------------------------------------------------------ */
function routeToHash(r) {
  if (r.page === "detail") return `#/detail/${r.kpiId}`;
  if (r.page === "dlcm") return `#/dlcm/${r.name.toLowerCase()}`;
  return "#/";
}

function hashToRoute(hash) {
  const [head, tail] = hash.replace(/^#\/?/, "").split("/");
  if (head === "detail" && KPIS.some((k) => k.id === tail)) return { page: "detail", kpiId: tail };
  if (head === "dlcm" && ["statistics", "comparison"].includes(tail))
    return { page: "dlcm", name: tail[0].toUpperCase() + tail.slice(1) };
  return { page: "overview" };
}

export default function App() {
  const [route, setRouteState] = useState(() => hashToRoute(window.location.hash));
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [theme, setTheme] = useState(() =>
    new URLSearchParams(window.location.search).get("theme") ||
    localStorage.getItem("ota-theme") || "dark"
  );
  const [navOpen, setNavOpen] = useState(() => localStorage.getItem("ota-nav-open") !== "false");
  const [backendRows, setBackendRows] = useState([]);
  const [campaignRows, setCampaignRows] = useState([]);
  const [countryRows, setCountryRows] = useState([]);
  const [releaseRows, setReleaseRows] = useState([]);
  const [adoptionRows, setAdoptionRows] = useState([]);
  const [adoptionAggRows, setAdoptionAggRows] = useState([]);
  const [aiSummaries, setAiSummaries] = useState([]);
  const [dataMode, setDataMode] = useState(null); // "live" | "local" | null (unknown yet)
  const [backendError, setBackendError] = useState(null);
  const [backendLoading, setBackendLoading] = useState(true);
  const [dimensionError, setDimensionError] = useState(null);
  const [dimensionLoading, setDimensionLoading] = useState(true);
  const [filterCatalog, setFilterCatalog] = useState(null);

  const brandOptions = useMemo(
    () => (filterCatalog?.brands?.length ? filterCatalog.brands : uniqueDimValues(campaignRows, normalizeBrandValue)),
    [campaignRows]
  );

  const platformOptions = useMemo(
    () => (filterCatalog?.platforms?.length ? filterCatalog.platforms : uniqueDimValues(campaignRows, normalizePlatformValue)),
    [campaignRows, filterCatalog]
  );

  const recallOptions = useMemo(
    () => (filterCatalog?.recalls?.length ? filterCatalog.recalls : uniqueDimValues(campaignRows, normalizeRecallValue)),
    [campaignRows, filterCatalog]
  );

  // Region -> its countries, for the nested Region/Country filter control.
  const regionCountryMap = useMemo(() => {
    if (filterCatalog?.regionCountryMap) {
      const map = new Map();
      Object.entries(filterCatalog.regionCountryMap).forEach(([region, countries]) => map.set(region, countries));
      return map;
    }

    const map = new Map();
    for (const row of countryRows) {
      const region = normalizeRegionValue(row);
      const country = normalizeCountryValue(row);
      if (!region || !country) continue;
      if (!map.has(region)) map.set(region, []);
      map.get(region).push(country);
    }
    for (const list of map.values()) list.sort();
    return map;
  }, [countryRows, filterCatalog]);

  const countryLookup = useMemo(
    () => buildCountryLookup(countryRows),
    [countryRows]
  );

  const campaignLookup = useMemo(
    () => buildCampaignLookup(campaignRows),
    [campaignRows]
  );

  // Every fact dataset is enriched the same way — joined to dim_campaign via
  // `campaign` and to dim_country via `country_iso` — so region/country/
  // brand/platform/recall filtering (and the date range) works uniformly
  // across fact_main, fact_release, and fact_adoption_rate.
  const enrichedRows = useMemo(() => {
    const looksPreEnriched = backendRows.some((row) => row.brand !== undefined || row.country_name !== undefined || row.region !== undefined || row.recall !== undefined);
    return looksPreEnriched ? backendRows : backendRows.map((row) => enrichRow(row, campaignLookup, countryLookup));
  }, [backendRows, campaignLookup, countryLookup]);

  const filteredRows = useMemo(
    () => enrichedRows.filter((row) => matchesRowFilters(row, filters)),
    [enrichedRows, filters]
  );

  // Adoption Rate's own small cube (see buildAdoptionRateAggregate in
  // server.js) — already resolved to region/country_name/brand/platform/
  // recall server-side and already filtered to the 60-day eligibility
  // window, so it only needs the same cross-filter/date-range pass as
  // filteredRows, not enrichRow.
  const filteredAdoptionAggRows = useMemo(
    () => adoptionAggRows.filter((row) => matchesRowFilters(row, filters)),
    [adoptionAggRows, filters]
  );

  const filteredReleaseRows = useMemo(() => {
    const rows = releaseRows.some((row) => row.brand !== undefined || row.country_name !== undefined || row.region !== undefined || row.recall !== undefined)
      ? releaseRows
      : releaseRows.map((row) => enrichRow(row, campaignLookup, countryLookup));
    return rows.filter((row) => matchesRowFilters(row, filters));
  }, [releaseRows, campaignLookup, countryLookup, filters]);

  const filteredAdoptionRows = useMemo(() => {
    const rows = adoptionRows.some((row) => row.brand !== undefined || row.country_name !== undefined || row.region !== undefined || row.recall !== undefined)
      ? adoptionRows
      : adoptionRows.map((row) => enrichRow(row, campaignLookup, countryLookup));
    return rows.filter((row) => matchesRowFilters(row, filters));
  }, [adoptionRows, campaignLookup, countryLookup, filters]);

  useEffect(() => {
    localStorage.setItem("ota-nav-open", String(navOpen));
  }, [navOpen]);

  // Swap the token sets before any child renders; App is the tree root,
  // so every component below reads the right theme this pass.
  C = theme === "dark" ? DARK : LIGHT;
  CHART = theme === "dark" ? CHART_DARK : CHART_LIGHT;

  useEffect(() => {
    localStorage.setItem("ota-theme", theme);
    const root = document.documentElement;
    root.style.setProperty("--slider-thumb", C.accent);
    root.style.setProperty("--slider-ring", theme === "dark" ? "#eaf1fb" : "#ffffff");
    document.body.style.background = C.bg;
  }, [theme]);

  useEffect(() => {
    const onHash = () => setRouteState(hashToRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const fetchDashboardSnapshot = async () => {
      try {
        const response = await fetch("/api/dashboard_snapshot");
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const snapshot = await response.json();
        setBackendRows(Array.isArray(snapshot.fact_main) ? snapshot.fact_main : []);
        setAdoptionAggRows(Array.isArray(snapshot.fact_adoption_rate_agg) ? snapshot.fact_adoption_rate_agg : []);
        setCampaignRows(Array.isArray(snapshot.dim_campaign) ? snapshot.dim_campaign : []);
        setCountryRows(Array.isArray(snapshot.dim_country) ? snapshot.dim_country : []);
        setAiSummaries(Array.isArray(snapshot.fact_ai_summaries_latest) ? snapshot.fact_ai_summaries_latest : []);
        setFilterCatalog(snapshot.filter_options || null);
        setDataMode(snapshot.mode || null);
      } catch (error) {
        setBackendError(error.message || String(error));
        setDimensionError(error.message || String(error));
      } finally {
        setBackendLoading(false);
        setDimensionLoading(false);
      }
    };

    fetchDashboardSnapshot();
  }, []);

  // fact_release/fact_adoption_rate are row-level (not aggregated like
  // fact_main) and only the DLCM Release pages need them. At real dataset
  // scale, bundling them into the initial load pushed the total payload
  // past what the browser tab could hold in memory at once (a hard crash,
  // not a slow load) — so they're fetched on their own, only the first time
  // a user actually opens a DLCM page.
  const [dlcmLoading, setDlcmLoading] = useState(false);
  const [dlcmLoaded, setDlcmLoaded] = useState(false);
  const [dlcmError, setDlcmError] = useState(null);
  useEffect(() => {
    if (route.page !== "dlcm" || dlcmLoaded || dlcmLoading) return;
    setDlcmLoading(true);
    fetch("/api/dlcm_snapshot")
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
      })
      .then((snapshot) => {
        setReleaseRows(Array.isArray(snapshot.fact_release) ? snapshot.fact_release : []);
        setAdoptionRows(Array.isArray(snapshot.fact_adoption_rate) ? snapshot.fact_adoption_rate : []);
        setDlcmLoaded(true);
      })
      .catch((error) => setDlcmError(error.message || String(error)))
      .finally(() => setDlcmLoading(false));
  }, [route.page, dlcmLoaded, dlcmLoading]);

  // Subscribe to WebSocket for live updates, fallback to SSE if needed
  useEffect(() => {
    let ws;
    let es;
    const applyPayload = (payload) => {
      if (!payload) return;
      if (payload.full && Array.isArray(payload.rows)) {
        setBackendRows(payload.rows);
        return;
      }
      setBackendRows((prev) => {
        const map = new Map(prev.map((r) => [makeRowId(r), r]));
        if (Array.isArray(payload.removed)) {
          for (const id of payload.removed) map.delete(id);
        }
        if (Array.isArray(payload.updated)) {
          for (const r of payload.updated) map.set(makeRowId(r), r);
        }
        if (Array.isArray(payload.added)) {
          for (const r of payload.added) map.set(makeRowId(r), r);
        }
        return Array.from(map.values());
      });
    };

    const connectWebSocket = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.hostname;
      const wsUrl = import.meta.env.DEV ? `${protocol}//${host}:5001` : `${protocol}//${window.location.host}`;
      try {
        ws = new WebSocket(wsUrl);
        ws.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            applyPayload(payload);
          } catch (err) {
            console.error('WS parse error', err);
          }
        };
        ws.onopen = () => {
          console.info('WebSocket connected to', wsUrl);
        };
        ws.onerror = (error) => {
          console.error('WebSocket error', error);
        };
        ws.onclose = () => {
          console.info('WebSocket closed, falling back to SSE');
          connectSSE();
        };
      } catch (e) {
        console.error('WebSocket connect failed', e);
        connectSSE();
      }
    };

    const connectSSE = () => {
      try {
        es = new EventSource('/events/fact_main');
        es.onmessage = (e) => {
          try {
            const payload = JSON.parse(e.data);
            applyPayload(payload);
          } catch (err) {
            console.error('SSE parse error', err);
          }
        };
        es.onerror = (err) => {
          console.error('EventSource error', err);
        };
      } catch (e) {
        console.error('SSE not supported or failed to connect', e);
      }
    };

    connectWebSocket();

    return () => {
      if (ws) ws.close();
      if (es) es.close();
    };
  }, []);

  const setRoute = (r) => {
    window.location.hash = routeToHash(r);
    setRouteState(r);
  };
  const goHome = () => setRoute({ page: "overview" });

  return (
    <div className="h-screen flex flex-col" style={{ background: C.bg, fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <TopBar
        theme={theme} onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        navOpen={navOpen} onToggleNav={() => setNavOpen((o) => !o)}
      />
      <FilterBar
        filters={filters}
        setFilters={setFilters}
        regionCountryMap={regionCountryMap}
        brandOptions={brandOptions}
        platformOptions={platformOptions}
        recallOptions={recallOptions}
        enrichedRows={enrichedRows}
        filterCatalog={filterCatalog}
      />
      <div className="flex-1 min-h-0 flex flex-row">
        <SideNav open={navOpen} onClose={() => setNavOpen(false)} route={route} onNavigate={setRoute}
          backendLoading={backendLoading} backendError={backendError} dataMode={dataMode} />
        {/* Pages fill the remaining viewport height and scroll if their
            content doesn't fit. The Overview page used to clip instead of
            scrolling here, which silently hid the DLCM buttons whenever the
            FilterBar grew taller (e.g. the "Active scope" row appearing) —
            a scrollbar only appears when content actually overflows, so
            there's no visual cost on a normal-height viewport. */}
        <main className="flex-1 min-h-0 min-w-0 overflow-auto">
          {route.page === "overview" && (
            <Overview
              filters={filters}
              filteredRows={filteredRows}
              filteredAdoptionAggRows={filteredAdoptionAggRows}
              aiSummaries={aiSummaries}
              onOpen={(kpiId) => setRoute({ page: "detail", kpiId })}
              onDlcm={(name) => setRoute({ page: "dlcm", name })}
            />
          )}
          {route.page === "detail" && (
            <Detail kpiId={route.kpiId} filters={filters} filteredRows={filteredRows}
              filteredAdoptionAggRows={filteredAdoptionAggRows}
              aiSummaries={aiSummaries} onBack={goHome} />
          )}
          {route.page === "dlcm" && dlcmLoading && <NoData label="Loading DLCM release data…" />}
          {route.page === "dlcm" && dlcmError && <NoData label={`Backend error: ${dlcmError}`} />}
          {route.page === "dlcm" && dlcmLoaded && route.name === "Statistics" && (
            <DlcmStatistics onBack={goHome} releaseRows={filteredReleaseRows} />
          )}
          {route.page === "dlcm" && dlcmLoaded && route.name === "Comparison" && (
            <DlcmComparison onBack={goHome} releaseRows={filteredReleaseRows} adoptionRows={filteredAdoptionRows} />
          )}
        </main>
      </div>
    </div>
  );
}
