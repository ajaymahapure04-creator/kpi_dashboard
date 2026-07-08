import React, { useState, useMemo } from "react";
import {
  CloudUpload, ShieldAlert, CarFront, Users, Timer, Euro, Leaf,
  ArrowLeft, Sparkles, Info, RotateCcw, ChevronRight, BarChart3,
  LineChart as LineChartIcon, FileText, TrendingUp, TrendingDown,
  AlertTriangle, Home, BookOpen, Mail, CircleDot
} from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip,
  CartesianGrid, BarChart, Bar, PieChart, Pie, Cell, ReferenceLine, Legend
} from "recharts";

/* ------------------------------------------------------------------ */
/* Design tokens — CARIAD dark analytics theme                         */
/* ------------------------------------------------------------------ */
const C = {
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
};

const cardStyle = (highlight) => ({
  background: highlight
    ? `linear-gradient(160deg, #1a3a6b 0%, ${C.cardTop} 35%, ${C.cardBottom} 100%)`
    : `linear-gradient(160deg, ${C.cardTop} 0%, ${C.cardBottom} 100%)`,
  border: `1px solid ${highlight ? "#2f5793" : C.cardBorderSoft}`,
  borderRadius: 14,
});

/* ------------------------------------------------------------------ */
/* Mock data                                                           */
/* ------------------------------------------------------------------ */
const BRANDS = ["VW", "Audi", "Porsche", "Škoda", "CUPRA", "MAN"];
const REGIONS = ["Europe", "North America", "China", "South America", "RoW"];
const PLATFORMS = ["MQB", "MLB", "MEB", "PPE"];

// deterministic pseudo-random series so the demo is stable
function genSeries(seed, base, vol, days, drift = 0) {
  const out = [];
  let v = base;
  for (let i = 0; i < days; i++) {
    const n = Math.sin(seed * 3.7 + i * 1.31) * 0.5 + Math.sin(seed + i * 0.37) * 0.5;
    v = Math.max(0, v + n * vol + drift);
    const d = new Date(2026, 6, 7 - (days - 1 - i));
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

const deltaColor = (raw, goodWhen) => {
  const num = parseFloat(String(raw).replace(/[^\d.-]/g, ""));
  if (!num) return C.bad; // flat deltas render red, matching the source Power BI dashboard
  const positive = num > 0;
  const good = goodWhen === "up" ? positive : !positive;
  return good ? C.good : C.bad;
};

/* ------------------------------------------------------------------ */
/* Shared chrome                                                       */
/* ------------------------------------------------------------------ */
function TopBar() {
  return (
    <div
      className="flex items-center justify-between px-4 py-2"
      style={{ background: "#070c16", borderBottom: `1px solid ${C.cardBorderSoft}` }}
    >
      <div className="flex items-center gap-3">
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
      </div>
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
        style={{ background: "#101a2e", color: C.text, border: `1px solid ${C.cardBorderSoft}` }}
      >
        <option>All</option>
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </div>
  );
}

function FilterBar({ filters, setFilters }) {
  const set = (k) => (v) => setFilters((f) => ({ ...f, [k]: v }));
  const reset = () =>
    setFilters({ region: "All", brand: "All", platform: "All", recall: "All", from: "2021-01-01", to: "2026-07-07" });
  return (
    <div
      className="flex flex-wrap items-end gap-3 px-4 py-3"
      style={{ background: C.panel, borderBottom: `1px solid ${C.cardBorderSoft}` }}
    >
      <span className="text-xs font-bold tracking-widest self-center rotate-0" style={{ color: C.accent }}>SCOPE</span>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-1 min-w-0" style={{ maxWidth: 720 }}>
        <Select label="Region" value={filters.region} options={REGIONS} onChange={set("region")} />
        <Select label="Brand" value={filters.brand} options={BRANDS} onChange={set("brand")} />
        <Select label="Platform" value={filters.platform} options={PLATFORMS} onChange={set("platform")} />
        <Select label="Recall ID" value={filters.recall} options={["R-2214", "R-2260", "R-2301"]} onChange={set("recall")} />
      </div>
      <div className="flex items-end gap-2">
        <span className="text-xs font-bold tracking-widest self-center" style={{ color: C.accent }}>TIME</span>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold" style={{ color: C.dim }}>From</label>
          <input type="date" value={filters.from} onChange={(e) => set("from")(e.target.value)}
            className="rounded px-2 py-1 text-sm"
            style={{ background: "#101a2e", color: C.text, border: `1px solid ${C.cardBorderSoft}`, colorScheme: "dark" }} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold" style={{ color: C.dim }}>To</label>
          <input type="date" value={filters.to} onChange={(e) => set("to")(e.target.value)}
            className="rounded px-2 py-1 text-sm"
            style={{ background: "#101a2e", color: C.text, border: `1px solid ${C.cardBorderSoft}`, colorScheme: "dark" }} />
        </div>
        <button onClick={reset}
          className="flex flex-col items-center gap-0.5 px-2 py-1 rounded text-xs hover:opacity-80"
          style={{ color: C.dim }}>
          <RotateCcw size={16} color={C.accent} />
          Clear filters
        </button>
      </div>
    </div>
  );
}

function DeltaPair({ kpi, size = "sm" }) {
  const cls = size === "sm" ? "text-xs" : "text-sm";
  return (
    <div className="flex items-stretch mt-2">
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
  return (
    <button
      onClick={() => onOpen(kpi.id)}
      className="text-left p-4 transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 w-full"
      style={{
        ...cardStyle(primary && kpi.id === "updates"),
        cursor: "pointer",
        boxShadow: "0 4px 18px rgba(0,0,0,0.35)",
      }}
      aria-label={`Open ${kpi.title} details`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center rounded-full"
            style={{ width: 34, height: 34, border: `1.5px solid ${C.text}` }}>
            <Icon size={17} color={C.text} />
          </span>
          <span className="font-bold" style={{ color: C.text }}>
            {kpi.title}{" "}
            {kpi.unitLabel && <span className="font-normal text-xs" style={{ color: C.dim }}>{kpi.unitLabel}</span>}
          </span>
        </div>
        <Info size={15} color={C.dim} />
      </div>

      <div className={"text-center font-extrabold " + (primary ? "text-4xl mt-2" : "text-3xl mt-1")}
        style={{ color: C.text }}>
        {kpi.value}
      </div>

      <DeltaPair kpi={kpi} size={primary ? "md" : "sm"} />

      {primary && (
        <div className="mt-3 pt-2" style={{ borderTop: `1px solid ${C.cardBorderSoft}` }}>
          <div className="flex items-center gap-1 text-xs font-bold" style={{ color: C.amber }}>
            <Sparkles size={13} /> AI Insight
          </div>
          {kpi.insight ? (
            <>
              <p className="text-xs mt-1 text-center font-medium" style={{ color: C.text }}>{kpi.insight}</p>
              <p className="text-xs mt-1 text-center" style={{ color: C.dim }}>{kpi.insightMeta}</p>
            </>
          ) : (
            <p className="text-xs mt-1" style={{ color: C.dim }}>available soon</p>
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
      className="flex items-center gap-3 px-4 py-3 rounded-xl"
      style={{
        background: disabled ? "#3a4252" : `linear-gradient(160deg, ${C.cardTop}, ${C.cardBottom})`,
        border: `1px solid ${disabled ? "#4a5266" : C.cardBorder}`,
        color: disabled ? "#9aa3b5" : C.text,
        opacity: disabled ? 0.7 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <Icon size={20} color={disabled ? "#9aa3b5" : C.accent} />
      <span className="text-left text-sm leading-tight">
        {l1}<br /><b>{l2}</b>
      </span>
      <ChevronRight size={18} />
    </button>
  );
}

function Overview({ onOpen, onDlcm }) {
  const primaries = KPIS.filter((k) => k.tier === "primary");
  const secondaries = KPIS.filter((k) => k.tier === "secondary");
  return (
    <div className="px-4 py-4 flex flex-col gap-5">
      <section>
        <h2 className="text-sm font-extrabold tracking-wide mb-2" style={{ color: C.text }}>PRIMARY KPIs</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {primaries.map((k) => <KpiCard key={k.id} kpi={k} onOpen={onOpen} primary />)}
        </div>
      </section>
      <section>
        <h2 className="text-sm font-extrabold tracking-wide mb-2" style={{ color: C.text }}>SECONDARY KPIs</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {secondaries.map((k) => <KpiCard key={k.id} kpi={k} onOpen={onOpen} />)}
        </div>
      </section>
      <div className="flex flex-wrap gap-3 justify-end pt-1">
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
const PIE_COLORS = ["#4da3ff", "#39d0d8", "#7c6bff", "#ffb547", "#35d07f", "#ff5a6a"];

function Panel({ title, children, right }) {
  return (
    <div className="p-4 rounded-xl" style={{ ...cardStyle(false) }}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold" style={{ color: C.text }}>{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

const tooltipStyle = {
  background: "#0d1830",
  border: `1px solid ${C.cardBorder}`,
  borderRadius: 8,
  color: C.text,
  fontSize: 12,
};

function Detail({ kpiId, onBack }) {
  const kpi = KPIS.find((k) => k.id === kpiId);
  const [range, setRange] = useState(30);
  const series = useMemo(() => genSeries(kpi.seed, kpi.base, kpi.vol, range, kpi.drift), [kpi, range]);
  const byBrand = useMemo(() => genBreakdown(kpi.seed, BRANDS, kpi.base), [kpi]);
  const byRegion = useMemo(() => genBreakdown(kpi.seed + 5, REGIONS, kpi.base), [kpi]);
  const Icon = kpi.icon;
  const trendUp = series[series.length - 1].value >= series[0].value;
  const trendGood = kpi.goodWhen === "up" ? trendUp : !trendUp;

  return (
    <div className="px-4 py-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button onClick={onBack}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold hover:opacity-80"
          style={{ background: "#101a2e", color: C.text, border: `1px solid ${C.cardBorder}` }}>
          <ArrowLeft size={16} /> Back to Overview
        </button>
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center rounded-full"
            style={{ width: 40, height: 40, border: `1.5px solid ${C.accent}` }}>
            <Icon size={20} color={C.accent} />
          </span>
          <div>
            <h1 className="text-xl font-extrabold" style={{ color: C.text }}>
              {kpi.title} {kpi.unitLabel && <span className="text-sm font-normal" style={{ color: C.dim }}>({kpi.unitLabel})</span>}
            </h1>
            <p className="text-xs" style={{ color: C.dim }}>{kpi.detailNote}</p>
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
                  background: range === r ? C.accent : "#101a2e",
                  color: range === r ? "#04122b" : C.dim,
                  border: `1px solid ${range === r ? C.accent : C.cardBorderSoft}`,
                }}>
                {r}d
              </button>
            ))}
          </div>
        }
      >
        <ResponsiveContainer width="100%" height={240}>
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
            <Tooltip contentStyle={tooltipStyle} />
            {kpi.threshold && (
              <ReferenceLine y={kpi.threshold} stroke={C.bad} strokeDasharray="6 4"
                label={{ value: `target ceiling ${kpi.threshold}`, fill: C.bad, fontSize: 11, position: "insideTopRight" }} />
            )}
            <Area type="monotone" dataKey="value" stroke={C.accent} strokeWidth={2} fill="url(#g1)" />
          </AreaChart>
        </ResponsiveContainer>
      </Panel>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Breakdown by Brand">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={byBrand} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid stroke={C.cardBorderSoft} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fill: C.dim, fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: C.faint, fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(77,163,255,0.08)" }} />
              <Bar dataKey="value" radius={[5, 5, 0, 0]}>
                {byBrand.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Breakdown by Region">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={byRegion} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85}
                paddingAngle={3} stroke={C.panel}>
                {byRegion.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: 12, color: C.dim }} />
            </PieChart>
          </ResponsiveContainer>
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
            <div className="flex items-start gap-2 p-3 rounded-lg"
              style={{ background: "rgba(255,181,71,0.08)", border: "1px solid rgba(255,181,71,0.25)" }}>
              <Sparkles size={15} color={C.amber} className="mt-0.5 shrink-0" />
              <p className="text-sm" style={{ color: C.text }}>
                {kpi.insight} <span style={{ color: C.dim }}>{kpi.insightMeta}</span>
              </p>
            </div>
          )}
          {kpi.anomalies.map((a, i) => (
            <div key={i} className="flex items-start gap-2 p-3 rounded-lg"
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
/* DLCM stub                                                           */
/* ------------------------------------------------------------------ */
function DlcmStub({ name, onBack }) {
  return (
    <div className="px-4 py-6 flex flex-col items-start gap-4">
      <button onClick={onBack}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold"
        style={{ background: "#101a2e", color: C.text, border: `1px solid ${C.cardBorder}` }}>
        <ArrowLeft size={16} /> Back to Overview
      </button>
      <div className="p-6 rounded-xl w-full" style={cardStyle(false)}>
        <h1 className="text-lg font-bold" style={{ color: C.text }}>DLCM Release {name}</h1>
        <p className="text-sm mt-2" style={{ color: C.dim }}>
          Placeholder route. In the production app this maps to <code>/dlcm/{name.toLowerCase()}</code> and
          hosts release-level tables and comparison charts.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App shell + routing                                                 */
/* In the artifact we use view-state routing; in Next.js each branch   */
/* below becomes a real route (see architecture notes).                */
/* ------------------------------------------------------------------ */
export default function App() {
  const [route, setRoute] = useState({ page: "overview" });
  const [filters, setFilters] = useState({
    region: "All", brand: "All", platform: "All", recall: "All",
    from: "2021-01-01", to: "2026-07-07",
  });

  return (
    <div className="min-h-screen" style={{ background: C.bg, fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <TopBar />
      <FilterBar filters={filters} setFilters={setFilters} />
      {route.page === "overview" && (
        <Overview
          onOpen={(kpiId) => setRoute({ page: "detail", kpiId })}
          onDlcm={(name) => setRoute({ page: "dlcm", name })}
        />
      )}
      {route.page === "detail" && (
        <Detail kpiId={route.kpiId} onBack={() => setRoute({ page: "overview" })} />
      )}
      {route.page === "dlcm" && (
        <DlcmStub name={route.name} onBack={() => setRoute({ page: "overview" })} />
      )}
    </div>
  );
}
