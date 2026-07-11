import fs from 'node:fs';
import path from 'node:path';

// Generates deterministic dummy CSVs in data/ using the same file names as
// scripts/export-combined-csv.js, so the backend's local-data mode (and any
// consumer of the real exports) works without a Databricks connection.
// Regional model (see DATA_MODEL.md): EU = ORU4+ORU23+ORUnext,
// USCA = ORU4 only, NAR/CN = ORU4+ORU23.
//
// Two different "region" concepts are in play, deliberately kept separate:
// - REGIONS keys (EU/USCA/NAR-CN) are the technical merge bucket that
//   decides which technologies/countries a campaign draws from (Source tag
//   on fact rows, matches the real Databricks merge lineage).
// - dim_country.region_name is the UI-facing geography (Europe / North
//   America / China) that the frontend's Region filter reads. NAR/CN's
//   bucket bundles two different UI regions (NAR -> North America, CN ->
//   China), so region_name is resolved per-country, not per-bucket.

const DATA_DIR = path.resolve(process.cwd(), 'data');

// --- deterministic PRNG (mulberry32) so re-runs produce identical data ---
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const randFloat = (min, max) => rand() * (max - min) + min;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// --- dimensions -----------------------------------------------------------
// dim_country totals 42 rows: 38 European countries + US + CA + NAR + CN.
const REGIONS = {
  EU: {
    technologies: ['ORU4', 'ORU23', 'ORUnext'],
    countries: [
      ['AT', 'Austria'], ['BE', 'Belgium'], ['BG', 'Bulgaria'], ['HR', 'Croatia'],
      ['CY', 'Cyprus'], ['CZ', 'Czechia'], ['DK', 'Denmark'], ['EE', 'Estonia'],
      ['FI', 'Finland'], ['FR', 'France'], ['DE', 'Germany'], ['GR', 'Greece'],
      ['HU', 'Hungary'], ['IE', 'Ireland'], ['IT', 'Italy'], ['LV', 'Latvia'],
      ['LT', 'Lithuania'], ['LU', 'Luxembourg'], ['MT', 'Malta'], ['NL', 'Netherlands'],
      ['PL', 'Poland'], ['PT', 'Portugal'], ['RO', 'Romania'], ['SK', 'Slovakia'],
      ['SI', 'Slovenia'], ['ES', 'Spain'], ['SE', 'Sweden'], ['GB', 'United Kingdom'],
      ['NO', 'Norway'], ['CH', 'Switzerland'], ['IS', 'Iceland'], ['LI', 'Liechtenstein'],
      ['RS', 'Serbia'], ['BA', 'Bosnia and Herzegovina'], ['MK', 'North Macedonia'],
      ['AL', 'Albania'], ['ME', 'Montenegro'], ['UA', 'Ukraine'],
    ],
  },
  USCA: {
    technologies: ['ORU4'],
    countries: [['US', 'United States'], ['CA', 'Canada']],
  },
  'NAR/CN': {
    technologies: ['ORU4', 'ORU23'],
    countries: [['NAR', 'North America Region'], ['CN', 'China']],
  },
};

function regionLabelFor(bucket, iso) {
  if (bucket === 'EU') return 'Europe';
  if (bucket === 'USCA') return 'North America';
  if (bucket === 'NAR/CN') return iso === 'CN' ? 'China' : 'North America';
  return 'Unknown';
}

// Platform (dim_campaign.platform) is its own dimension, not a strict 1:1
// function of technology — weighted pools give plausible variety across
// all five real platform codes.
const PLATFORMS_BY_TECH = {
  ORU4: ['MEB', 'MEB', 'MEB', 'MQBevo'],
  ORU23: ['MQB/MLB', 'MQB/MLB', 'MQBevo'],
  ORUnext: ['PPC', 'PPE', 'MQBevo'],
};
const BRANDS = ['VW', 'AUDI', 'SKODA', 'SEAT', 'CUPRA', 'VWN'];
const CAMPAIGNS_PER_REGION_TECH = { 'EU|ORU4': 8, 'EU|ORU23': 8, 'EU|ORUnext': 3, 'USCA|ORU4': 6, 'NAR/CN|ORU4': 5, 'NAR/CN|ORU23': 5 };

// Weekly reporting dates ending just before the frontend's default "to" filter (2026-07-07).
const LAST_DATE = new Date('2026-07-05T00:00:00Z');
function weeklyDates(count) {
  const dates = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(LAST_DATE);
    d.setUTCDate(d.getUTCDate() - i * 7);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// --- campaigns ------------------------------------------------------------
let campaignSeq = 100;
const campaigns = [];
for (const [key, count] of Object.entries(CAMPAIGNS_PER_REGION_TECH)) {
  const [region, tech] = key.split('|');
  for (let i = 0; i < count; i++) {
    const brand = pick(BRANDS);
    const seq = campaignSeq++;
    const id = `OTA-${tech}-${brand}-${seq}`;
    // recall_id is the campaign column itself (dim_campaign.campaign) —
    // there is no separate synthetic recall code; each campaign IS a recall.
    campaigns.push({
      campaign: id,
      brand,
      region,
      technology: tech,
      platform: pick(PLATFORMS_BY_TECH[tech]),
      wave: String(randInt(1, 5)),
      release: `15.${seq - 100}.${randInt(0, 9)}`, // unique per campaign
      scale: randFloat(0.4, 2.5),
      countries: (() => {
        const pool = [...REGIONS[region].countries];
        const n = Math.min(pool.length, randInt(2, 5));
        const chosen = [];
        for (let k = 0; k < n; k++) chosen.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
        return chosen;
      })(),
    });
  }
}

// --- fact_main ------------------------------------------------------------
const factMain = [];
for (const c of campaigns) {
  const dates = weeklyDates(randInt(8, 14));
  for (const [iso] of c.countries) {
    for (const date of dates) {
      const updates = Math.round(randInt(200, 8000) * c.scale);
      const operations = Math.round(updates * randFloat(1.05, 1.2));
      const eligible = Math.round(operations / randFloat(0.55, 0.9));
      const minor = Math.round(updates * randFloat(0.002, 0.008));
      const major = Math.round(updates * randFloat(0.0005, 0.002));
      factMain.push({
        campaign: c.campaign,
        brand: c.brand,
        country_iso: iso,
        wave: c.wave,
        date,
        successful_updates: updates,
        quality: randInt(90, 99),
        downtime_minutes: randInt(20, 75),
        update_operations: operations,
        lb_common_vehicles: Math.round(eligible * 0.7),
        lb_backend_vehicles: Math.round(eligible * 0.2),
        lb_aftersales_vehicles: Math.round(eligible * 0.1),
        cost_savings: Math.round(updates * randFloat(30, 45) * 100) / 100,
        co2_savings: Math.round(updates * randFloat(0.010, 0.016) * 1000) / 1000,
        platform: c.platform,
        updated_technology: c.technology,
        customerWarning_none: updates - minor - major,
        customerWarning_minor: minor,
        customerWarning_major: major,
        // No region/recall columns here by design — region is resolved by
        // joining country_iso -> dim_country, and recall_id by joining
        // campaign -> dim_campaign (both PKs). Source is the merge-lineage
        // provenance tag (EU/USCA/NAR-CN), kept for parity with real exports.
        Source: c.region,
        Installation_Duration: undefined, // filled below to mirror transformRow
      });
    }
  }
}
for (const row of factMain) row.Installation_Duration = row.downtime_minutes;

// --- dimensions -----------------------------------------------------------
// dim_campaign carries no geography — region/country come only from
// dim_country, joined via country_iso on the fact tables.
const dimCampaign = campaigns.map((c) => ({
  campaign: c.campaign,
  brand: c.brand,
  platform: c.platform,
  updated_technology: c.technology,
}));

// region_name is the UI-facing label (Europe / North America / China),
// resolved per-country — see regionLabelFor().
const dimCountry = Object.entries(REGIONS).flatMap(([bucket, def]) =>
  def.countries.map(([iso, name]) => ({
    country_iso: iso,
    country_name: name,
    region_name: regionLabelFor(bucket, iso),
  }))
);

// --- secondary facts ------------------------------------------------------
const factTargeted = [];
const factAdoption = [];
for (const c of campaigns) {
  for (const [iso] of c.countries) {
    factTargeted.push({
      campaign: c.campaign,
      brand: c.brand,
      country_iso: iso,
      targeted_vehicles: Math.round(randInt(5000, 60000) * c.scale),
      platform: c.platform,
      updated_technology: c.technology,
      Source: c.region,
    });
  }
  // Adoption is tracked at campaign grain; tag with the campaign's primary
  // country so it still joins to dim_country (country_iso is the PK, not
  // fully exploded per country the way fact_main/fact_targeted_vehicles are).
  const primaryIso = c.countries[0][0];
  const dates = weeklyDates(10);
  dates.forEach((date, i) => {
    factAdoption.push({
      campaign: c.campaign,
      country_iso: primaryIso,
      date,
      adoption_rate: Math.round((20 + (70 * (i + 1)) / dates.length + randFloat(-4, 4)) * 10) / 10,
      platform: c.platform,
      updated_technology: c.technology,
      Source: c.region,
    });
  });
}

const ECUS = ['ICAS1', 'ICAS3', 'HCP3', 'OCU3', 'BCM2', 'DCU1', 'GWC5'];
const factEcu = [];
for (const c of campaigns.filter((x) => x.region === 'EU')) {
  const primaryIso = c.countries[0][0];
  for (const ecu of ECUS.slice(0, randInt(3, ECUS.length))) {
    const updates = Math.round(randInt(1000, 30000) * c.scale);
    factEcu.push({
      ecu,
      campaign: c.campaign,
      country_iso: primaryIso,
      successful_updates: updates,
      failed_updates: Math.round(updates * randFloat(0.002, 0.02)),
      updated_technology: c.technology,
      platform: c.platform,
      Source: 'EU',
    });
  }
}

const factRelease = campaigns.map((c) => ({
  campaign: c.campaign,
  country_iso: c.countries[0][0],
  release: c.release,
  rollout_start: weeklyDates(randInt(8, 14))[0],
  vehicles: Math.round(randInt(10000, 90000) * c.scale),
  success_rate: Math.round(randFloat(93.5, 97.5) * 10) / 10,
  err_per_1k: Math.round(randFloat(2.5, 6.5) * 10) / 10,
  avg_duration_min: Math.round(randFloat(55, 72) * 10) / 10,
  rollout_pct: randInt(60, 100),
  updated_technology: c.technology,
  platform: c.platform,
  Source: c.region,
}));

// Schema matches the real fact_ai_summaries_facts_v3_int export: brand, fact
// (boilerplate long-form text, one per brand in the real sample), headline
// (short per-metric claim), generated_at, metric_domains, platform, rank,
// reasoning (blank in the real sample), region ("ALL" is a valid value
// meaning "not region-scoped"), run_id, triggered_signals (dot-joined codes).
const GENERATED_AT = '2026-07-11';
const RUN_ID = 'run_2026_07_11_03';
const METRIC_DOMAINS = [
  { metric: 'successful_updates', headline: (b, n, p) => `${b} shatters monthly OTA record: ${n} updates, up ${p}% vs prior average.` },
  { metric: 'quality', headline: (b, n, p) => `${b} quality holds at ${n} errors/1k, ${p}% better than fleet average.` },
  { metric: 'liegenbleiber', headline: (b, n, p) => `${b} Liegenbleiber rate stays within target at ${n}/1k.` },
  { metric: 'adoption_rate', headline: (b, n, p) => `${b} adoption rate climbs to ${n}%, up ${p}pts week over week.` },
  { metric: 'installation_duration', headline: (b, n, p) => `${b} installation time drops to ${n} min, ${p}% faster than baseline.` },
  { metric: 'cost_savings', headline: (b, n, p) => `${b} OTA cost savings hit €${n}M this cycle, +${p}% vs prior month.` },
  { metric: 'Co2_savings', headline: (b, n, p) => `${b} CO2 savings reach ${n}K tonnes, +${p}% vs prior month.` }, // casing matches the real export
];
const SIGNAL_POOL = ['sig_spike', 'sig_new_high', 'sig_drop', 'sig_plateau', 'sig_recovery', 'sig_threshold_breach'];
function pickSignals() {
  const pool = [...SIGNAL_POOL];
  const n = randInt(1, 2);
  const chosen = [];
  for (let i = 0; i < n; i++) chosen.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return chosen.join('.');
}

const factAiSummaries = [];
let rank = 1;
BRANDS.forEach((brand, bi) => {
  const fact = `Mock summary for brand ${brand}: update volume trending up week over week; quality stable above 95; Liegenbleiber rate within target; no critical anomalies detected.`;
  // Two metric-domain insights per brand, rotating through the 7 KPIs.
  for (let k = 0; k < 2; k++) {
    const domain = METRIC_DOMAINS[(bi * 2 + k) % METRIC_DOMAINS.length];
    const region = pick(['Europe', 'North America', 'China', 'ALL']);
    factAiSummaries.push({
      brand,
      fact,
      headline: domain.headline(brand, randInt(500, 15000), randInt(5, 60)),
      generated_at: GENERATED_AT,
      metric_domains: domain.metric,
      platform: pick(['MEB', 'MQB/MLB', 'MQBevo', 'PPC', 'PPE']),
      rank: rank++,
      reasoning: '',
      region,
      run_id: RUN_ID,
      triggered_signals: pickSignals(),
    });
  }
});

// --- CSV writing (same escaping rules as export-combined-csv.js) ----------
function rowsToCsv(rows) {
  if (!rows.length) return '';
  const headers = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) { seen.add(key); headers.push(key); }
    }
  }
  const escape = (value) => {
    const raw = value === null || value === undefined ? '' : String(value);
    if (raw.includes('"') || raw.includes(',') || raw.includes('\n') || raw.includes('\r')) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((h) => escape(row[h])).join(','))].join('\n');
}

// One canonical file per dataset — each is already the full
// EU + US/CA + NAR/CN combination (fact_ecu is EU-only by design).
const files = {
  'fact_main.csv': factMain,
  'fact_adoption_rate.csv': factAdoption,
  'fact_ecu.csv': factEcu,
  'fact_targeted_vehicles.csv': factTargeted,
  'fact_release.csv': factRelease,
  'dim_campaign.csv': dimCampaign,
  'dim_country.csv': dimCountry,
  'fact_ai_summaries_latest.csv': factAiSummaries,
};

// Write via a temp file + rename so a file locked by another program (an
// editor, Excel, a preview pane) can't crash the whole run — same pattern
// as scripts/export-combined-csv.js's writeCsvFile.
function writeCsvFile(name, rows) {
  const csv = rowsToCsv(rows);
  const filePath = path.join(DATA_DIR, name);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, csv, 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
    console.log(`Wrote data/${name} (${rows.length} rows)`);
  } catch (err) {
    const fallback = `${filePath}.new`;
    fs.renameSync(tmpPath, fallback);
    console.warn(`data/${name} is locked by another program — wrote data/${path.basename(fallback)} instead (${rows.length} rows). Close whatever has it open and re-run to replace it.`);
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
// remove stale CSVs so data/ only ever contains the canonical set
for (const existing of fs.readdirSync(DATA_DIR)) {
  if (existing.endsWith('.csv') && !(existing in files)) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, existing));
    } catch (err) {
      console.warn(`Could not remove stale ${existing} (${err.code}) — close any program holding it open and re-run.`);
    }
  }
}
for (const [name, rows] of Object.entries(files)) {
  writeCsvFile(name, rows);
}
console.log(`\nDone: ${campaigns.length} campaigns, ${factMain.length} fact_main rows.`);
