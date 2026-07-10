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

// Fleet shares used to scale volume KPIs when a scope filter is applied
const BRAND_SHARE = { VW: 0.34, Audi: 0.22, Porsche: 0.07, "Škoda": 0.17, CUPRA: 0.09, MAN: 0.11 };
const REGION_SHARE = { Europe: 0.48, "North America": 0.17, China: 0.24, "South America": 0.06, RoW: 0.05 };
const PLATFORM_SHARE = { MQB: 0.38, MLB: 0.22, MEB: 0.28, PPE: 0.12 };
const RECALL_SHARE = { "R-2214": 0.04, "R-2260": 0.03, "R-2301": 0.02 };

// Empty array = "All" (no constraint on that dimension)
const DEFAULT_FILTERS = {
  region: [], brand: [], platform: [], recall: [],
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
  return row.recall || row.Recall || row.recall_id || row.Recall_ID || "";
}

function makeRowId(row) {
  // Prefer campaign as the stable identifier; fall back to composite if missing.
  const campaign = (row.campaign || row.Campaign || row.campaign_id || row.id || row.name || "").toString();
  if (campaign) return `campaign:${campaign}`;
  const country = (row.country_iso || row.iso || row.country || "").toString();
  const recall = (row.recall || row.Recall || row.recall_id || row.Recall_ID || "").toString();
  const tech = (row.updated_technology || row.Update_Technology || row.update_technology || "").toString();
  const platform = (row.platform || row.Platform || "").toString();
  return `fallback:${country}||${recall}||${tech}||${platform}`;
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

function matchesRowFilters(row, filters, countryLookup, campaignLookup) {
  const rowCampaign = normalizeCampaignValue(row);
  const campaign = campaignLookup.get(rowCampaign) || {};
  const rowBrand = row.brand || row.Brand || campaign.brand || "";
  const rowPlatform = row.platform || row.Platform || campaign.platform || "";
  const rowRecall = row.recall || row.Recall || campaign.recall || rowCampaign;
  const lookup = countryLookup.get(row.country_iso || row.country || row.iso || "") || {};
  const rowRegion = lookup.region || row.region || row.Region || "";

  if (filters.brand.length && !filters.brand.includes(rowBrand)) return false;
  if (filters.platform.length && !filters.platform.includes(rowPlatform)) return false;
  if (filters.recall.length && !rowRecall) return false;
  if (filters.recall.length && !filters.recall.includes(rowRecall)) return false;
  if (filters.region.length && !filters.region.includes(rowRegion)) return false;
  return true;
}

function getAvailableDimensionOptions(filters, campaignRows, countryRows) {
  const available = {
    region: new Set(),
    brand: new Set(),
    platform: new Set(),
    recall: new Set(),
  };

  for (const row of campaignRows) {
    const rowRegion = normalizeRegionValue(row);
    const rowBrand = normalizeBrandValue(row);
    const rowPlatform = normalizePlatformValue(row);
    const rowRecall = normalizeRecallValue(row);

    if (filters.region.length && !filters.region.includes(rowRegion)) continue;
    if (filters.brand.length && !filters.brand.includes(rowBrand)) continue;
    if (filters.platform.length && !filters.platform.includes(rowPlatform)) continue;
    if (filters.recall.length && !filters.recall.includes(rowRecall)) continue;

    if (rowBrand) available.brand.add(rowBrand);
    if (rowPlatform) available.platform.add(rowPlatform);
    if (rowRecall) available.recall.add(rowRecall);
    if (rowRegion) available.region.add(rowRegion);
  }

  if (!filters.brand.length && !filters.platform.length && !filters.recall.length) {
    for (const row of countryRows) {
      const region = normalizeRegionValue(row);
      if (region) available.region.add(region);
    }
  }

  if (!campaignRows.length) {
    for (const row of countryRows) {
      const region = normalizeRegionValue(row);
      if (region) available.region.add(region);
    }
  }

  return available;
}

function cascadeFilters(filters, available) {
  const out = { ...filters };
  out.brand = out.brand.filter((v) => available.brand.has(v));
  out.platform = out.platform.filter((v) => available.platform.has(v));
  out.recall = out.recall.filter((v) => available.recall.has(v));
  out.region = out.region.filter((v) => available.region.has(v));
  return out;
}

// Derive a deterministic scope from the filters: volume scale factor,
// a seed shift so every scope draws a different (but stable) series,
// and the list of active selections for display.
const sumShare = (sel, table) => (sel.length ? Math.min(1, sel.reduce((a, k) => a + (table[k] ?? 0.08), 0)) : 1);

function filterScope(filters) {
  const active = [
    ...filters.brand,
    ...filters.region,
    ...filters.platform,
    ...filters.recall,
  ];
  const scale =
    sumShare(filters.brand, BRAND_SHARE) *
    sumShare(filters.region, REGION_SHARE) *
    sumShare(filters.platform, PLATFORM_SHARE) *
    sumShare(filters.recall, RECALL_SHARE);
  const seedShift = active.join("").split("").reduce((a, c) => a + c.charCodeAt(0), 0) % 89 * 0.37;
  return { scale, seedShift, active };
}

// Rescale a display magnitude like "17.7M", "+29.1K" or "2.0bn" by a factor,
// re-picking the suffix so filtered values stay readable.
function scaleMagnitude(str, scale) {
  if (scale === 1) return str;
  const m = String(str).match(/^([+-]?)(\d+(?:\.\d+)?)(bn|M|K)?$/);
  if (!m) return str;
  const mult = { bn: 1e9, M: 1e6, K: 1e3 }[m[3]] ?? 1;
  const abs = parseFloat(m[2]) * mult * scale;
  let out;
  if (abs >= 1e9) out = (abs / 1e9).toFixed(1) + "bn";
  else if (abs >= 1e6) out = (abs / 1e6).toFixed(1) + "M";
  else if (abs >= 1e3) out = (abs / 1e3).toFixed(1) + "K";
  else out = abs.toFixed(abs < 10 ? 1 : 0);
  return m[1] + out;
}

// deterministic pseudo-random series so the demo is stable
function genSeries(seed, base, vol, days, drift = 0, endDate = "2026-07-07") {
  const out = [];
  let v = base;
  const end = new Date(endDate + "T00:00:00");
  for (let i = 0; i < days; i++) {
    const n = Math.sin(seed * 3.7 + i * 1.31) * 0.5 + Math.sin(seed + i * 0.37) * 0.5;
    v = Math.max(0, v + n * vol + drift);
    const d = new Date(end);
    d.setDate(end.getDate() - (days - 1 - i));
    out.push({
      date: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
      value: +v.toFixed(2),
    });
  }
  return out;
}

function genBreakdown(seed, keys, base) {
  return keys.map((k, i) => ({
    name: k,
    value: +(base * (0.4 + Math.abs(Math.sin(seed * 2.1 + i * 1.7)) * 1.2)).toFixed(1),
  }));
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
    scaleWithFleet: true,
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
    unitLabel: "",
    value: "35%",
    d7: "0.0%", d30: "0.0%",
    goodWhen: "up",
    icon: Users,
    seed: 41, base: 34.2, vol: 0.5, drift: 0.02,
    detailNote: "Share of eligible vehicles that installed the latest offered release",
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
    scaleWithFleet: true,
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
    scaleWithFleet: true,
    icon: Leaf,
    seed: 71, base: 18, vol: 2.2, drift: 0.15,
    detailNote: "Avoided emissions from workshop trips (daily increment, tonnes)",
    anomalies: [
      { sev: "info", text: "Cumulative savings equivalent to ~14,700 average EU passenger-car years." },
    ],
  },
];

const deltaColor = (raw, goodWhen) => {
  const num = parseFloat(String(raw).replace(/[^\d.-]/g, ""));
  if (!num) return C.bad; // flat deltas render red, matching the source Power BI dashboard
  const positive = num > 0;
  const good = goodWhen === "up" ? positive : !positive;
  return good ? C.good : C.bad;
};

// Project a KPI into the current filter scope (volume KPIs scale with fleet share)
function scopedKpi(kpi, scope) {
  if (!kpi.scaleWithFleet || scope.scale === 1) return kpi;
  return {
    ...kpi,
    value: scaleMagnitude(kpi.value, scope.scale),
    d7: scaleMagnitude(kpi.d7, scope.scale),
    d30: scaleMagnitude(kpi.d30, scope.scale),
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

function valueForKpi(rows, kpiId) {
  if (!rows || !rows.length) return null;
  switch (kpiId) {
    case "updates":
      return sumField(rows, ["successful_updates"]);
    case "quality": {
      const totalUpdates = sumField(rows, ["successful_updates"]);
      const weightedQuality = rows.reduce((sum, row) => {
        const quality = getNumericField(row, ["quality"]);
        const updates = getNumericField(row, ["successful_updates"]);
        return sum + quality * updates;
      }, 0);
      return totalUpdates ? weightedQuality / totalUpdates : averageField(rows, ["quality"]);
    }
    case "liegenbleiber": {
      const totalUpdates = sumField(rows, ["successful_updates"]);
      const totalWarnings = sumField(rows, ["customerWarning_minor", "customerWarning_major"]);
      return totalUpdates ? (totalWarnings / totalUpdates) * 1000 : null;
    }
    case "adoption": {
      const installs = sumField(rows, ["update_operations"]);
      const eligible = sumField(rows, ["lb_common_vehicles", "lb_backend_vehicles", "lb_aftersales_vehicles"]);
      return eligible ? (installs / eligible) * 100 : null;
    }
    case "duration":
      return averageField(rows, ["downtime_minutes"]);
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
      return `${value.toFixed(1)}%`;
    case "cost":
    case "co2":
      return formatLargeNumber(value);
    default:
      return `${value}`;
  }
}

function runtimeKpi(kpi, rows, scope) {
  const actualValue = valueForKpi(rows, kpi.id);
  if (actualValue == null) return scopedKpi(kpi, scope);
  return scopedKpi({ ...kpi, value: formatKpiValue(actualValue, kpi.id) }, scope);
}

function buildKpiSeries(rows, kpiId, range) {
  if (!rows || !rows.length) return [];
  const dateMap = new Map();
  for (const row of rows) {
    const rawDate = row.date ?? row.Date;
    const parsed = rawDate ? new Date(rawDate) : null;
    if (!parsed || Number.isNaN(parsed.valueOf())) continue;
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
  const groups = new Map();
  for (const row of rows) {
    const key = row[dimension] ?? row[dimension.charAt(0).toUpperCase() + dimension.slice(1)] ?? "Unknown";
    const current = groups.get(key) || 0;
    groups.set(key, current + (valueForKpi([row], kpiId) ?? 0));
  }
  return Array.from(groups.entries())
    .map(([name, value]) => ({ name, value }))
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

function TopBar({ theme, onToggleTheme, navOpen, onToggleNav, backendStatus }) {
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

function SideNav({ open, onClose, route, onNavigate, backendStatus }) {
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
          <span className="text-xs" style={{ color: C.dim }}>{backendStatus}</span>
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

/* Multi-select dropdown with checkboxes. `options` is [{ v, enabled }];
   disabled entries are values cascaded away by the other filters. */
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
          {options.map(({ v, enabled }) => (
            <label
              key={v}
              className="flex items-center gap-2 px-2 py-1 text-sm"
              style={{
                color: enabled ? C.text : C.disabledText,
                opacity: enabled ? 1 : 0.55,
                cursor: enabled ? "pointer" : "not-allowed",
              }}
            >
              <input
                type="checkbox"
                checked={values.includes(v)}
                disabled={!enabled}
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

function FilterBar({ filters, setFilters, regionOptions, brandOptions, platformOptions, recallOptions, campaignRows, countryRows }) {
  const available = getAvailableDimensionOptions(filters, campaignRows, countryRows);
  const set = (k) => (v) => setFilters((f) => ({ ...f, [k]: v }));
  // A change in one dimension re-cascades the others using actual dimension availability.
  const setDim = (dim) => (vals) => setFilters((f) => {
    const next = { ...f, [dim]: vals };
    const nextAvailable = getAvailableDimensionOptions(next, campaignRows, countryRows);
    return cascadeFilters(next, nextAvailable);
  });
  const reset = () => setFilters(DEFAULT_FILTERS);
  const scope = filterScope(filters);
  const optsFor = (dim, all) => all.map((v) => ({ v, enabled: available[dim].has(v) }));
  return (
    <div
      className="flex flex-wrap items-end gap-3 px-4 py-2 shrink-0"
      style={{ background: C.panel, borderBottom: `1px solid ${C.cardBorderSoft}` }}
    >
      <VLabel>SCOPE</VLabel>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-1 min-w-0" style={{ maxWidth: 960 }}>
        <MultiSelect label="Region" values={filters.region} options={optsFor("region", regionOptions)} onChange={setDim("region")} />
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
          <span className="text-xs" style={{ color: C.faint }}>
            (~{(scope.scale * 100).toFixed(scope.scale < 0.1 ? 1 : 0)}% of fleet — volume KPIs rescaled)
          </span>
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
          {kpi.insight ? (
            <>
              <p className="text-xs mt-0.5 text-center font-medium" style={{
                color: C.text, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
              }}>{kpi.insight}</p>
              <p className="text-xs mt-0.5 text-center truncate" style={{ color: C.dim }}>{kpi.insightMeta}</p>
            </>
          ) : (
            <p className="text-xs mt-0.5" style={{ color: C.dim }}>available soon</p>
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

function Overview({ onOpen, onDlcm, filters, filteredRows }) {
  const scope = filterScope(filters);
  const primaries = KPIS.filter((k) => k.tier === "primary").map((k) => runtimeKpi(k, filteredRows, scope));
  const secondaries = KPIS.filter((k) => k.tier === "secondary").map((k) => runtimeKpi(k, filteredRows, scope));
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

function Detail({ kpiId, onBack, filters, filteredRows }) {
  const scope = filterScope(filters);
  const kpi = runtimeKpi(KPIS.find((k) => k.id === kpiId), filteredRows, scope);
  const [range, setRange] = useState(30);
  const volScale = kpi.scaleWithFleet ? scope.scale : 1;
  const series = useMemo(() => {
    const actualSeries = buildKpiSeries(filteredRows, kpiId, range);
    return actualSeries.length ? actualSeries : genSeries(
      kpi.seed + scope.seedShift,
      kpi.base * volScale,
      kpi.vol * Math.max(volScale, 0.15),
      range,
      kpi.drift * volScale,
      filters.to
    );
  }, [filteredRows, kpiId, kpi.seed, kpi.base, kpi.vol, kpi.drift, volScale, scope.seedShift, range, filters.to]);
  const byBrand = useMemo(() => {
    const actual = buildKpiBreakdown(filteredRows, kpiId, "brand");
    return actual.length ? actual : genBreakdown(kpi.seed + scope.seedShift, BRANDS, kpi.base * volScale);
  }, [filteredRows, kpiId, kpi.seed, kpi.base, volScale, scope.seedShift]);
  const byRegion = useMemo(() => {
    const actual = buildKpiBreakdown(filteredRows, kpiId, "region");
    return actual.length ? actual : genBreakdown(kpi.seed + scope.seedShift + 5, REGIONS, kpi.base * volScale);
  }, [filteredRows, kpiId, kpi.seed, kpi.base, volScale, scope.seedShift]);
  const Icon = kpi.icon;
  const trendUp = series[series.length - 1].value >= series[0].value;
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
        </div>
      </Panel>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Breakdown by Brand">
          <div style={{ height: "clamp(120px, 16vh, 280px)" }}>
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
          </div>
        </Panel>
        <Panel title="Breakdown by Region">
          <div style={{ height: "clamp(120px, 16vh, 280px)" }}>
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
          </div>
        </Panel>
      </div>

      {/* AI insights & anomalies */}
      <Panel title={
        <span className="flex items-center gap-2" style={{ color: C.amber }}>
          <Sparkles size={15} /> AI Insights & Anomalies
        </span>
      }>
        <div className="flex flex-col gap-2">
          {kpi.insight && (
            <div className="flex items-start gap-2 p-2 rounded-lg"
              style={{ background: "rgba(255,181,71,0.08)", border: "1px solid rgba(255,181,71,0.25)" }}>
              <Sparkles size={15} color={C.amber} className="mt-0.5 shrink-0" />
              <p className="text-sm" style={{ color: C.text }}>
                {kpi.insight} <span style={{ color: C.dim }}>{kpi.insightMeta}</span>
              </p>
            </div>
          )}
          {kpi.anomalies.map((a, i) => (
            <div key={i} className="flex items-start gap-2 p-2 rounded-lg"
              style={{
                background: a.sev === "warn" ? "rgba(255,90,106,0.07)" : "rgba(77,163,255,0.06)",
                border: `1px solid ${a.sev === "warn" ? "rgba(255,90,106,0.3)" : "rgba(77,163,255,0.2)"}`,
              }}>
              {a.sev === "warn"
                ? <AlertTriangle size={15} color={C.bad} className="mt-0.5 shrink-0" />
                : <CircleDot size={15} color={C.accent} className="mt-0.5 shrink-0" />}
              <p className="text-sm" style={{ color: C.text }}>{a.text}</p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DLCM Release Statistics                                             */
/* ------------------------------------------------------------------ */
function DlcmStatistics({ onBack }) {
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
            <BarChart data={RELEASES} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
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
            <BarChart data={RELEASES} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
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
              {RELEASES.map((r) => (
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

function DlcmComparison({ onBack }) {
  const [relA, setRelA] = useState("15.6.0");
  const [relB, setRelB] = useState("15.5.0");
  const A = RELEASES.find((r) => r.id === relA);
  const B = RELEASES.find((r) => r.id === relB);

  const data = useMemo(() => {
    const ca = adoptionCurve(A);
    const cb = adoptionCurve(B);
    return ca.map((v, i) => ({ day: i, [A.id]: v, [B.id]: cb[i] }));
  }, [A, B]);

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
          <Select label="Release A" value={relA} options={RELEASES.map((r) => r.id).filter((id) => id !== relB)}
            onChange={(v) => v !== "All" && setRelA(v)} />
          <Select label="Release B" value={relB} options={RELEASES.map((r) => r.id).filter((id) => id !== relA)}
            onChange={(v) => v !== "All" && setRelB(v)} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <CompareStat label="Adoption after 30 days" unit="%" goodWhen="up"
          a={+adoptionCurve(A)[30].toFixed(1)} b={+adoptionCurve(B)[30].toFixed(1)} relA={A.id} relB={B.id} />
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
  const [backendError, setBackendError] = useState(null);
  const [backendLoading, setBackendLoading] = useState(true);
  const [dimensionError, setDimensionError] = useState(null);
  const [dimensionLoading, setDimensionLoading] = useState(true);

  const brandOptions = useMemo(
    () => uniqueDimValues(campaignRows, normalizeBrandValue),
    [campaignRows]
  );

  const platformOptions = useMemo(
    () => uniqueDimValues(campaignRows, normalizePlatformValue),
    [campaignRows]
  );

  const recallOptions = useMemo(
    () => uniqueDimValues(campaignRows, normalizeRecallValue),
    [campaignRows]
  );

  const regionOptions = useMemo(
    () => uniqueDimValues(countryRows, normalizeRegionValue),
    [countryRows]
  );

  const countryLookup = useMemo(
    () => buildCountryLookup(countryRows),
    [countryRows]
  );

  const campaignLookup = useMemo(
    () => buildCampaignLookup(campaignRows),
    [campaignRows]
  );

  const filteredRows = useMemo(
    () => backendRows.filter((row) => matchesRowFilters(row, filters, countryLookup, campaignLookup)),
    [backendRows, filters, countryLookup, campaignLookup]
  );

  const scope = filterScope(filters);
  const scopeSummary = scope.active.length ? scope.active.join(" / ") : "All data";

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
    const fetchBackendData = async () => {
      try {
        const response = await fetch("/api/fact_main_oru4_prod?limit=1000");
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const data = await response.json();
        setBackendRows(data);
      } catch (error) {
        setBackendError(error.message || String(error));
      } finally {
        setBackendLoading(false);
      }
    };

    const fetchDimensionData = async () => {
      try {
        const [campaignRes, countryRes] = await Promise.all([
          fetch("/api/dim_campaign_combined?limit=1000"),
          fetch("/api/dim_country_combined?limit=1000"),
        ]);
        if (!campaignRes.ok) throw new Error(`Campaign fetch failed: ${campaignRes.status} ${campaignRes.statusText}`);
        if (!countryRes.ok) throw new Error(`Country fetch failed: ${countryRes.status} ${countryRes.statusText}`);
        const [campaignData, countryData] = await Promise.all([campaignRes.json(), countryRes.json()]);
        setCampaignRows(campaignData);
        setCountryRows(countryData);
      } catch (error) {
        setDimensionError(error.message || String(error));
      } finally {
        setDimensionLoading(false);
      }
    };

    fetchBackendData();
    fetchDimensionData();
  }, []);

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
      const wsUrl = import.meta.env.DEV ? `${protocol}//${host}:4000` : `${protocol}//${window.location.host}`;
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
        backendStatus={
          backendLoading || dimensionLoading
            ? "Loading backend…"
            : backendError || dimensionError
              ? `Backend error: ${backendError || dimensionError}`
              : `${filteredRows.length} rows matched from ${backendRows.length} backend rows · ${scopeSummary}`
        }
      />
      <FilterBar
        filters={filters}
        setFilters={setFilters}
        regionOptions={regionOptions}
        brandOptions={brandOptions}
        platformOptions={platformOptions}
        recallOptions={recallOptions}
        campaignRows={campaignRows}
        countryRows={countryRows}
      />
      <div className="flex-1 min-h-0 flex flex-row">
        <SideNav open={navOpen} onClose={() => setNavOpen(false)} route={route} onNavigate={setRoute}
          backendStatus={backendLoading ? "Loading backend…" : backendError ? `Backend error: ${backendError}` : `${backendRows.length} backend rows loaded`} />
        {/* Pages fill the remaining viewport height. The Overview/landing page
            never shows a scrollbar — it clips instead of scrolling on windows
            too short to fit it. Detail/DLCM pages keep a scroll fallback since
            they stack more content (charts + insights) than a short window
            can show in full. */}
        <main className={`flex-1 min-h-0 min-w-0 ${route.page === "overview" ? "overflow-hidden" : "overflow-auto"}`}>
          {route.page === "overview" && (
            <Overview
              filters={filters}
              onOpen={(kpiId) => setRoute({ page: "detail", kpiId })}
              onDlcm={(name) => setRoute({ page: "dlcm", name })}
            />
          )}
          {route.page === "detail" && (
            <Detail kpiId={route.kpiId} filters={filters} onBack={goHome} />
          )}
          {route.page === "dlcm" && route.name === "Statistics" && <DlcmStatistics onBack={goHome} />}
          {route.page === "dlcm" && route.name === "Comparison" && <DlcmComparison onBack={goHome} />}
        </main>
      </div>
    </div>
  );
}
