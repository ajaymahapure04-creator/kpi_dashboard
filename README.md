# CARIAD OTA Performance Dashboard

This repository is a live React + Vite dashboard for OTA performance KPIs.
The app combines a modern frontend with a Node.js backend that reads from
Databricks SQL, caches results, and streams updates to the browser.

## What is included

- `src/App.jsx` — main dashboard UI, live update client, charting, filters
- `server.js` — backend API, Databricks data ingestion, cache refresh, SSE/WebSocket live updates
- `.env` — local environment loading for Databricks hosts, tokens, port, and schema settings
- `vite.config.js` — frontend proxy of `/api` to the backend
- `scripts/start-dev.js` — combined `npm run dev-all` startup for backend + frontend

## Local development

Install dependencies:

```bash
npm install
```

Start both backend and frontend together:

```bash
npm run dev-all
```

Or run individually:

```bash
npm run backend
npm run dev
```

### Local data mode (no Databricks needed)

When no Databricks token is configured (or `LOCAL_DATA=1` is set), the
backend serves rows from `data/*.csv` instead of querying Databricks — the
frontend works unchanged, including SSE live updates. Set `LOCAL_DATA=0` to
force live mode.

For an explicit, easier-to-remember switch during development, set
`DATA_MODE=live` or `DATA_MODE=local` in `.env` — it takes priority over
`LOCAL_DATA` and the token-presence auto-detection.

```bash
npm run mock-data   # generate deterministic dummy CSVs into data/
npm run dev-all     # backend picks them up automatically
```

The same `data/` folder also accepts real exports produced by
`node scripts/export-combined-csv.js` on a machine with credentials, so you
can develop against real numbers without a live connection. `data/` is
gitignored — never commit real exports.

The frontend will normally serve on a Vite port such as:

- `http://localhost:5177/`

The backend listens on:

- `http://localhost:5001`

If port `5001` is already in use, update `PORT` in the `.env` file.

## Backend architecture

The backend is implemented in `server.js`:

- Express server for REST APIs
- `@databricks/sql` client to query Databricks tables
- In-memory cache for `fact_main` data
- Periodic refresh every 15 seconds by default
- Live update delivery via:
  - Server-Sent Events on `/events/fact_main`
  - WebSocket broadcast to connected clients

### Environment and configuration

Key environment variables used by `server.js`:

- `PORT` — backend port (default `5001` if not set, matching the Vite proxy)
- `DATA_MODE` — `live` or `local`, explicit override for local-data mode (see above)
- `DATABRICKS_HOST_EU`, `DATABRICKS_PATH_EU`, `DATABRICKS_TOKEN_EU`
- `DATABRICKS_INT_HOST`, `DATABRICKS_INT_PATH`, `DATABRICKS_INT_TOKEN`
- `DATALAKE_PROD_SCHEMA` — default production schema
- `DATALAKE_INT_SCHEMA` — default integration schema
- `DATALAKE_DEV_SCHEMA` — default dev schema
- `CACHE_REFRESH_INTERVAL_MS` — cache refresh interval in milliseconds (default
  10 minutes; the cache now fetches the full fact_main dataset unlimited, not
  a 1000-row sample, so refreshing more often than that hits Databricks with
  a full-table scan every cycle)

All fact/dimension API routes are unlimited by default (every row from
Databricks or `data/*.csv`) — pass `?limit=N` on a request to cap it
explicitly for testing.

The frontend proxy in `vite.config.js` forwards `/api` traffic to the backend.

## Backend data model and semantics

The backend merges data from multiple regional/technology tables to produce a
combined OTA fact dataset.

### Primary combined source: `fact_main`

The main combined dataset is built from:

- `fact_main_oru4_prod`
- `fact_main_oru23`
- `fact_main_oru4_nar`
- `fact_main_orunext`
- `fact_main_oru4_int` (integration/USCA source)

Additional per-table metadata is injected where appropriate, for example:

- `Update_Technology`: `ORU4`, `ORU23`
- `Platform`: `MEB`, `MQB/MLB`, `NA`
- `Source`: `EU`, `USCA`, `NAR/CN`

### Row normalization

Each row is transformed and normalized before returning to the frontend:

- `wave` string cleanup
- `brand` uppercased
- `campaign` trimmed
- `country_iso` gets normalized values like `Unknown`
- canonical fields are normalized to lowercase keys such as:
  - `updated_technology`
  - `platform`
  - `country_name`
  - `region_name`
- fallback row IDs are generated from `campaign`, `country_iso`, `recall`, `technology`, and `platform`

### Enrichment

When possible, the backend enriches `fact_main` rows using dimension tables:

- `dim_campaign_*`
- `dim_country_*`

This adds missing metadata such as brand, platform, recall, region, and country name.

## Backend API endpoints

The backend exposes raw and combined endpoints for live KPI consumption.

### Fact APIs

- `GET /api/fact_main_oru4_prod`
  - serves cached combined rows for the main dashboard
  - falls back to a live query if cache is empty
- `GET /api/fact_main_combined`
- `GET /api/fact_main_eu_usca_combined`

### Additional combined endpoints

- `GET /api/fact_targeted_vehicles_combined`
- `GET /api/fact_adoption_rate_combined`
- `GET /api/fact_adoption_rate_eu_usca_combined`
- `GET /api/fact_ecu_combined`
- `GET /api/fact_ecu_eu_combined`
- `GET /api/fact_release_combined`

### Dimension endpoints

- `GET /api/dim_campaign_combined`
- `GET /api/dim_campaign_eu_usca_narch_combined`
- `GET /api/dim_country_combined`
- `GET /api/dim_country_eu_usca_narch_combined`

### AI and metadata endpoints

- `GET /api/fact_ai_summaries_latest`
- `GET /api/table_counts`
- `GET /api/status` — `{ mode: "live" | "local" }`, decided once at server
  startup; drives the sidebar's Live/Connected-Local-data indicator

## Live updates

The backend supports live data push via two mechanisms:

- `/events/fact_main` — Server-Sent Events (SSE)
- WebSocket server attached to the same HTTP server

On initial connect, clients receive a full snapshot. Subsequent refreshes deliver
delta updates containing added, updated, and removed rows.

## Frontend notes

The dashboard frontend is built with:

- Vite 7
- React 19
- Tailwind CSS 4
- Recharts 3
- lucide-react

The frontend loads data from the backend API and can display live numbers
from the combined `fact_main` cache.

## Notes for developers

- `npm run dev-all` starts both backend and frontend
- `npm run backend` starts only the backend server
- `npm run dev` starts only the frontend Vite dev server
- `server.js` uses `@databricks/sql` to connect to Databricks and probe the first available configured table source
- `scripts/start-dev.js` orchestrates local startup on Windows and macOS/Linux

## File structure

- `src/` — React application source
- `server.js` — Node backend and live update server
- `scripts/start-dev.js` — combined dev runner
- `.env` — local Databricks and port config
- `vite.config.js` — frontend proxy config
- `README.md` — project documentation
