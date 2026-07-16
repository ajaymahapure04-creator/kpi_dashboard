import fs from 'fs';
import path from 'path';

export const LOCAL_DATA_DIR = path.resolve(process.cwd(), 'data');

export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) return ',';
  const first = lines[0];
  const commaCount = (first.match(/,/g) || []).length;
  const tabCount = (first.match(/\t/g) || []).length;
  return tabCount > commaCount ? '\t' : ',';
}

export function parseCsvText(text) {
  const delimiter = detectDelimiter(text);
  const records = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      records.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); records.push(row); }
  if (records.length < 2) return [];
  const headers = records[0].map((h) => String(h).trim());
  return records.slice(1)
    .filter((r) => r.some((v) => v !== ''))
    .map((r) => {
      const obj = {};
      headers.forEach((h, idx) => {
        const v = r[idx];
        if (v !== undefined && v !== '') obj[h] = v;
      });
      return obj;
    });
}

export function writeJsonRows(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!Array.isArray(rows)) {
    fs.writeFileSync(filePath, '[]', 'utf8');
    return;
  }

  // Write synchronously via a file descriptor so the file is fully on disk
  // when this returns — every caller (loadLocalDataRows, generateLocalJson-
  // FilesFromCsvs) is synchronous and reads the file immediately afterwards,
  // so an async write stream would leave them racing a half-flushed file.
  // Chunked writes keep us from materializing one ~480 MB string for
  // fact_main while still emitting valid, comma-separated JSON.
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, '[');
    const batchSize = 100;
    let firstRow = true;
    for (let index = 0; index < rows.length; index += batchSize) {
      const batch = rows.slice(index, index + batchSize);
      const chunk = batch.map((row) => {
        const rendered = JSON.stringify(row);
        // The separating comma goes before every row except the very first in
        // the whole file. The flag must flip per row (not per batch) or every
        // row inside a batch is treated as "first" and joined as invalid `}{`.
        const prefixed = firstRow ? rendered : `,${rendered}`;
        firstRow = false;
        return prefixed;
      }).join('');
      fs.writeSync(fd, chunk);
    }
    fs.writeSync(fd, ']');
  } finally {
    fs.closeSync(fd);
  }
}

export function loadLocalDataRows(name, cache = new Map()) {
  if (cache.has(name)) return cache.get(name);

  const jsonPath = path.join(LOCAL_DATA_DIR, `${name}.json`);
  const csvPath = path.join(LOCAL_DATA_DIR, `${name}.csv`);
  let rows = null;

  if (fs.existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (Array.isArray(parsed)) rows = parsed;
    } catch (error) {
      console.warn(`Unable to read local JSON for ${name}, falling back to CSV.`, error.message || error);
    }
  }

  if (!rows && fs.existsSync(csvPath)) {
    rows = parseCsvText(fs.readFileSync(csvPath, 'utf8'));
    if (rows && rows.length) {
      writeJsonRows(jsonPath, rows);
      console.log(`Generated local JSON cache for ${name}`);
    }
  }

  cache.set(name, rows);
  return rows;
}

export function loadLocalDashboardSnapshot(cache = new Map()) {
  const snapshotKey = '__dashboard_snapshot__';
  if (cache.has(snapshotKey)) return cache.get(snapshotKey);

  const snapshot = {
    fact_main: loadLocalDataRows('fact_main', cache) || [],
    dim_campaign: loadLocalDataRows('dim_campaign', cache) || [],
    dim_country: loadLocalDataRows('dim_country', cache) || [],
    fact_release: loadLocalDataRows('fact_release', cache) || [],
    fact_adoption_rate: loadLocalDataRows('fact_adoption_rate', cache) || [],
    fact_targeted_vehicles: loadLocalDataRows('fact_targeted_vehicles', cache) || [],
    fact_ai_summaries_latest: loadLocalDataRows('fact_ai_summaries_latest', cache) || [],
  };

  cache.set(snapshotKey, snapshot);
  return snapshot;
}

export function generateLocalJsonFilesFromCsvs() {
  if (!fs.existsSync(LOCAL_DATA_DIR)) return [];
  const files = fs.readdirSync(LOCAL_DATA_DIR)
    .filter((file) => file.endsWith('.csv'))
    .sort();

  const generated = [];
  for (const file of files) {
    const base = file.replace(/\.csv$/, '');
    const csvPath = path.join(LOCAL_DATA_DIR, file);
    const jsonPath = path.join(LOCAL_DATA_DIR, `${base}.json`);
    const csvText = fs.readFileSync(csvPath, 'utf8');
    const rows = parseCsvText(csvText);
    if (rows && rows.length) {
      writeJsonRows(jsonPath, rows);
      generated.push(base);
    }
  }
  return generated;
}
