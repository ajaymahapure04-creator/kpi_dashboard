# OTA Dashboard Data Model

This document is the reference for where the dashboard's data comes from, how
regional source tables merge into the logical datasets served by the API and
the CSV exporter, and which rules normalize and enrich each row. The merge
lists live in `server.js` and `scripts/export-combined-csv.js` — **both files
must declare identical source lists and candidate schemas**, otherwise the
live dashboard and the exported CSVs report different numbers.

## The regional model

Every fact dataset is a combination of **three regions**, each contributing
specific update technologies:

| Region (`Source` tag) | Meaning | Technologies |
|---|---|---|
| `EU` | Europe | ORU4 + ORU23 + ORUnext |
| `USCA` | US + Canada | ORU4 only |
| `NAR/CN` | North America region + China | ORU4 + ORU23 |

**ORUnext** is the newly introduced update technology. It applies to
`fact_main` only (`fact_main_orunext`) and is currently available for the EU
region alone — if it expands to other regions or datasets, new source tables
must be added to both merge lists.

Target composition per dataset, and what is actually wired today:

| Dataset | EU | US/CA | NAR/CN |
|---|---|---|---|
| `fact_main` | ✅ oru4_prod + oru23_prod + orunext | ✅ oru4_int | ✅ oru4_nar + oru234chn_oru23nar |
| `fact_adoption_rate` | ✅ oru4_prod + oru23 | ✅ oru4_int | ✅ oru4_nar |
| `fact_ecu` | ✅ oru4_prod + oru23(_prod) | — no feed (confirmed) | — no feed (confirmed) |
| `fact_frequency` | ✅ oru4_prod + oru23_prod | ✅ oru4_int | — no feed (confirmed) |
| `fact_enrolled` | ⚠️ planned — no tables exist in the codebase yet | ⚠️ | ⚠️ |

— = confirmed not part of this dataset today. ⚠️ = planned but not wired.
US/CA fact_main deliberately uses **only** `fact_main_oru4_int` (not the
USCA workspace's `fact_main_oru4_prod`). When new tables appear in
Databricks, add them to **both** merge lists.

### KPI usage

`fact_main` drives most primary/secondary KPIs. Every KPI is a sum or a
ratio-of-sums over the whole filtered scope, never a per-row average of
per-row ratios (see `valueForKpiAgg`/`valueForKpi` in `src/App.jsx`):

- **Successful vehicle updates** = `SUM(successful_updates)`
- **Quality** = `(SUM(quality) / SUM(successful_updates)) * 1000` — errors
  per 1k successful updates
- **Liegenbleiber** = `(SUM(lb_common_vehicles + lb_backend_vehicles +
  lb_aftersales_vehicles) / SUM(successful_updates)) * 1000`
- **Installation Duration** = `SUM(downtime_minutes) / SUM(update_operations)`
  — `downtime_minutes` is the row's *total* minutes across all its
  operations, not a single-instance sample to average directly
- **CO2 savings** = `SUM(co2_savings)`
- **Cost savings** = `SUM(cost_savings)`

**Adoption Rate** is the one KPI *not* sourced from `fact_main` — it comes
from `fact_adoption_rate`, using two columns real Databricks exports carry
(`targeted_date`, `successful_update_date`) that the local CSV export/mock
generator previously omitted:

- Adoption Rate = `SUM(successful_updates)` **where**
  `(successful_update_date - targeted_date) <= 60 days`
- Aggregated server-side into its own small cube
  (`buildAdoptionRateAggregate` in `server.js`) at the same grain as
  `fact_main`'s cube (date × region × country × brand × platform × recall),
  shipped eagerly in `/api/dashboard_snapshot` as `fact_adoption_rate_agg` —
  row-level `fact_adoption_rate` is still only fetched lazily via
  `/api/dlcm_snapshot`, for the DLCM adoption-curve chart specifically.

`fact_ai_summaries_facts_v3_int` is the odd one out: it is not a regional
merge. It reads **all** data in Databricks and stores generated summaries per
region/country/brand/platform; the API serves only the newest batch
(`WHERE generated_at = MAX(generated_at)`).

### `fact_ai_summaries_facts_v3_int` columns

Confirmed from a real office-laptop export (2026-07-11):

| Column | Notes |
|---|---|
| `brand` | always a specific brand (not a wildcard) |
| `fact` | long-form summary text — in the real sample this is one boilerplate sentence per brand, not per metric |
| `headline` | short, specific claim (e.g. "SEAT Shatters mothly OTA record: 12,987 updates, upto 330% vs prior average.") |
| `generated_at` | batch generation date |
| `metric_domains` | which KPI the row is about — values seen: `successful_updates`, `Co2_savings` (note the mixed casing — preserved as-is, not normalized) |
| `platform` | one of the 5 platform codes |
| `rank` | priority/relevance ordering within a batch |
| `reasoning` | blank in both real sample rows |
| `region` | a specific region name, **or `"ALL"`** meaning not region-scoped |
| `run_id` | batch identifier, e.g. `run_2026_07_11_03` |
| `triggered_signals` | dot-joined anomaly codes, e.g. `sig_spike.sig_new_high` |

The frontend (`src/App.jsx`) matches each KPI to a `metric_domains` value via
`KPI_METRIC_DOMAIN` (case-insensitive) to surface the most relevant summary
row on that KPI's card/detail page; `region: "ALL"` renders as "All regions".

## Physical layout

Data lives in two Azure Databricks workspaces, each with schemas under
`hive_metastore`:

| Connection | Workspace | Schemas | Contents |
|---|---|---|---|
| `prod` | EU prod | `datalake_prod` | EU `*_prod`, `orunext`, plus NAR/CN feeds (`*_nar`, `oru234chn_oru23nar`) |
| `usca` | USCA/INT | `datalake_prod`, `datalake_int` | US/CA `*_prod` tables in `datalake_prod`; `*_int` tables in `datalake_int` |
| `int` | USCA/INT (same host) | `datalake_int`, `datalake_dev` | integration/dev copies |

Table lookup (`executeAgainstFirstAvailable`) probes candidates in order and
uses the first one that answers:

1. `datalake_prod` @ `prod`
2. `datalake_prod` @ `usca`
3. `datalake_int` @ `usca`
4. `datalake_int` @ `int`
5. `datalake_dev` @ `int`

A `connectionHint` on a source restricts the probe to that connection —
`'prod'` pins a table to the EU workspace, `'usca'` to the USCA workspace.
This is how the same table name (`fact_main_oru4_prod`) is fetched once from
EU and once from US/CA. Failed probes are silently skipped — a missing table
drops its rows from the merge without an error, so verify row counts with
`scripts/count_all_sources.mjs` when numbers look low.

## Naming convention

`<dataset>_<technology>_<environment>`:

- `oru4_prod` — ORU4 (MEB platform), production (exists on both EU and USCA workspaces)
- `oru23` / `oru23_prod` — ORU23 (MQB/MLB platform), EU
- `oru4_nar` — ORU4, NAR/CN feed
- `oru234chn_oru23nar` — combined China + NAR feed (mixed technologies)
- `oru4_int` — ORU4, USCA integration feed
- `orunext` — ORUnext, the newly added update technology (fact_main only, EU only)

## Dimensions vs. regions (design decision)

Three tag fields are injected during the merge; keep their semantics separate:

- **`Source`** — region the data comes from: `EU`, `USCA`, `NAR/CN`
- **`updated_technology`** — update stack: `ORU4`, `ORU23`, `ORUnext`
- **`platform`** — *vehicle* platform: `MEB`, `MQB/MLB`

`platform` must never hold a region value. When a source table lacks explicit
tags, they are inferred: table name containing `oru4` → `ORU4`, `oru23` →
`ORU23`; then `ORU4` → `MEB`, `ORU23` → `MQB/MLB`. Sources marked
`skipMetadata: true` (the country dimension) bypass inference entirely.

## Canonical `fact_main` row

The 19 canonical columns (see `normalize_preview.mjs` /
`create_unified_view.mjs`; sources missing a column contribute typed NULLs):

| Column | Type | Notes |
|---|---|---|
| `campaign` | STRING | trimmed; primary row identity |
| `brand` | STRING | uppercased |
| `country_iso` | STRING | `-1` → `Unknown` |
| `wave` | STRING | `"wave "` prefix stripped |
| `date` | DATE | |
| `successful_updates` | BIGINT | KPI: successful vehicle updates |
| `quality` | BIGINT | KPI: quality |
| `downtime_minutes` | BIGINT | mirrored to `Installation_Duration` |
| `update_operations` | BIGINT | |
| `lb_common_vehicles` | BIGINT | KPI: Liegenbleiber |
| `lb_backend_vehicles` | BIGINT | KPI: Liegenbleiber |
| `lb_aftersales_vehicles` | BIGINT | KPI: Liegenbleiber |
| `cost_savings` | DOUBLE | KPI: cost savings |
| `co2_savings` | DOUBLE | KPI: CO2 savings |
| `platform` | STRING | vehicle platform |
| `update_technology` | STRING | normalized to `updated_technology` |
| `customerWarning_none` | BIGINT | |
| `customerWarning_minor` | BIGINT | |
| `customerWarning_major` | BIGINT | |

## Merge lineage

Each logical dataset is a UNION of source tables with injected tags.
`(prod)` / `(usca)` = `connectionHint`.

### fact_main (`/api/fact_main_combined`, `/api/fact_main_eu_usca_combined`, cache + SSE/WS)

| Source table | Region | Tags |
|---|---|---|
| `fact_main_oru4_prod` (prod) | EU | ORU4, MEB |
| `fact_main_oru23_prod` | EU | ORU23, MQB/MLB |
| `fact_main_orunext` | EU | ORUnext |
| `fact_main_oru4_nar` | NAR/CN | ORU4, MEB |
| `fact_main_oru234chn_oru23nar` | NAR/CN | mixed; per-row columns win |
| `fact_main_oru4_int` (usca) | USCA | ORU4, MEB |

Rows are then enriched from `dim_campaign` (brand, platform, recall) and
`dim_country` (country_name, region_name) — enrichment only fills fields that
are still empty.

### fact_adoption_rate

| Source table | Region | Tags |
|---|---|---|
| `fact_adoption_rate_oru4_prod` | EU | ORU4, MEB |
| `fact_adoption_rate_oru23` | EU | ORU23 (inferred) |
| `fact_adoption_rate_oru4_nar` | NAR/CN | ORU4 |
| `fact_adoption_rate_oru4_int` (usca) | USCA | ORU4 |

### fact_frequency / fact_release / fact_targeted_vehicles

Pattern: `<name>_oru4_prod` (EU, ORU4/MEB) + `<name>_oru23_prod` (EU) +
`<name>_oru4_int` (usca; USCA, ORU4). fact_frequency has no NAR/CN feed
(confirmed).

### fact_ecu

EU only (confirmed — no US/CA or NAR/CN feed): `fact_ecu_oru4_prod` +
`fact_ecu_oru23` (combined) or `fact_ecu_oru23_prod` (EU variant).

### dim_campaign

| Source table | Region |
|---|---|
| `dim_campaign_oru4_prod` | EU (ORU4/MEB) |
| `dim_campaign_oru23_prod` | EU (ORU23) |
| `dim_campaign_orunext` | EU |
| `dim_campaign_oru4_int` (usca) | USCA (ORU4) |
| `dim_campaign_oru234chn_oru23nar` | NAR/CN |

### dim_country (special handling)

Sources: `dim_country_oru4_prod`, `dim_country_oru23_prod` (EU),
`dim_country_oru4_int` (usca), `dim_country_oru234chn_oru23nar` (NAR/CN) —
all with `skipMetadata: true`. The merge then:

1. fetches **all** rows (no per-table limit),
2. drops rows with an empty `country_name`,
3. dedupes by `country_iso` — **first source listed wins**, so EU prod
   definitions take precedence; reordering the list changes the outcome,
4. strips `updated_technology`/`platform` (meaningless on a country lookup).

## Frontend filter model

The dashboard's FilterBar (`src/App.jsx`) reads five dimensions, each sourced
from a specific column and joined through the fact table's two primary keys:

| Filter | Source column | Joined via |
|---|---|---|
| Region | `dim_country.region_name` — **`Europe` / `North America` / `China`** | `country_iso` |
| Country | `dim_country.country_name` | `country_iso` |
| Brand | `dim_campaign.brand` | `campaign` |
| Platform | `dim_campaign.platform` — **`MEB` / `MQB/MLB` / `MQBevo` / `PPC` / `PPE`** | `campaign` |
| Recall ID | `dim_campaign.campaign` | `campaign` (recall_id **is** the campaign id — there is no separate recall column) |

`region_name` is a **UI-facing geography**, deliberately distinct from the
`Source` merge-lineage tag documented above: `NAR/CN`'s bucket bundles two
different geographies (the `NAR` country entry → `North America`, `CN` →
`China`), so region_name is resolved per-country, not per-bucket. `Source`
stays on fact rows as provenance; the frontend never reads it for filtering.

**Every fact table carries `campaign` and `country_iso`** — these are the
only two primary keys used to join to `dim_campaign` and `dim_country`
respectively. `fact_main` and `fact_targeted_vehicles` are exploded to one
row per country; `fact_adoption_rate`, `fact_ecu`, and `fact_release` are
campaign-grain and carry a single representative `country_iso` (the
campaign's first country) purely so they remain joinable and filterable —
not a claim that adoption/ECU/release figures vary by country in the mock.

`src/App.jsx`'s `enrichRow()` performs this join once per row (resolving
`brand`/`platform`/`recall`/`country_name`/`region`), and cascading
availability (`getAvailableDimensionOptions`) is computed from these
enriched **fact** rows, not from `dim_campaign`/`dim_country` alone — a
dimension's own selection is excluded from its own availability check (so
multi-select doesn't self-lock), but cross-dimension narrowing (e.g.
Region → Brand) requires scanning the fact bridge, since `dim_campaign` and
`dim_country` share no key with each other directly.

### Date filtering

There is no `dim_calendar` table. `dateInRange()` filters each row against
`filters.from`/`filters.to` using whichever date-like column it has:
`date` (fact_main, fact_adoption_rate) or `rollout_start` (fact_release).
Rows with neither column are never excluded by the date filter. This applies
uniformly to `filteredRows`, `filteredReleaseRows`, and `filteredAdoptionRows`
in `App()`, so the DLCM pages honor the same date range as the KPI cards.

## Row normalization and identity

`transformRow` (duplicated in `server.js` and the exporter) applies: wave
prefix strip, brand uppercase, campaign trim, `country_iso -1 → Unknown`,
`downtime_minutes → Installation_Duration`, and collapses
`Update_Technology`/`Platform` variants into lowercase
`updated_technology`/`platform`.

Row identity (`makeRowId`, used for live-update deltas): `campaign` when
present, else the composite `country_iso || recall || technology || platform`.
Campaigns are assumed unique across all merged sources — two sources sharing
a campaign ID would collide in the delta stream.

## Verification scripts

- `scripts/count_all_sources.mjs` — row count per table across all candidates
- `scripts/count_fq_usca.mjs` — proves `fact_main_oru4_int` lives in
  `datalake_int` on the USCA workspace
- `check_usca_prod_table_access.mjs` — proves the USCA workspace serves
  `datalake_prod.fact_main_oru4_prod`
- `scripts/describe_table_columns.mjs` — column inventory per table
- `scripts/export-combined-csv.js` — exports every logical dataset to
  `data/*.csv` (`--all`, `--max=N`, `--only=file.csv`)

## Canonical data files

There is exactly **one file per dataset** — each already the full
EU + US/CA + NAR/CN combination. The exporter, the mock generator
(`scripts/generate-mock-data.mjs`), and the backend's local-data mode all
use these names; every API route maps onto one of them via
`LOCAL_ENDPOINT_ALIASES` in `server.js`:

| File | Notes |
|---|---|
| `fact_main.csv` | primary/secondary KPIs |
| `fact_adoption_rate.csv` | Adoption Rate KPI — needs `targeted_date`, `successful_update_date`, `successful_updates` (see KPI usage above) |
| `fact_ecu.csv` | EU-only by design |
| `fact_targeted_vehicles.csv` | |
| `fact_release.csv` | |
| `dim_campaign.csv` | one row per campaign |
| `dim_country.csv` | 42 rows: 38 European countries + US + CA + NAR + CN |
| `fact_ai_summaries_latest.csv` | newest `generated_at` batch only |
