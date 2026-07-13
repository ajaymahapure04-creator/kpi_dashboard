// Diagnostic for the Region filter bug: prints the actual country_iso
// values on both sides of the fact_main -> dim_country join (raw, not
// normalized) so a real mismatch can be seen directly instead of guessed
// at. Run with: node scripts/diagnose-region-join.mjs
import fs from 'fs';
import path from 'path';
import { LOCAL_DATA_DIR, parseCsvText } from './local-data-utils.mjs';

function readCsv(name) {
  const p = path.join(LOCAL_DATA_DIR, `${name}.csv`);
  if (!fs.existsSync(p)) {
    console.log(`MISSING: ${p}`);
    return [];
  }
  return parseCsvText(fs.readFileSync(p, 'utf8'));
}

function show(label, value) {
  // JSON.stringify makes stray quote/whitespace characters visible instead
  // of invisible in a terminal.
  console.log(`${label}: ${JSON.stringify(value)}`);
}

const factRows = readCsv('fact_main');
const countryRows = readCsv('dim_country');

console.log(`fact_main.csv: ${factRows.length} rows`);
console.log(`dim_country.csv: ${countryRows.length} rows`);
console.log('');

console.log('--- Raw country_iso values from the FIRST 5 fact_main rows (exact, unmodified) ---');
factRows.slice(0, 5).forEach((r, i) => show(`  fact_main[${i}].country_iso`, r.country_iso));

console.log('');
console.log('--- Raw country_iso values from the FIRST 10 dim_country rows (exact, unmodified) ---');
countryRows.slice(0, 10).forEach((r, i) => show(`  dim_country[${i}].country_iso`, r.country_iso));

const factIsoSet = new Set(factRows.map((r) => r.country_iso));
const countryIsoSet = new Set(countryRows.map((r) => r.country_iso));

console.log('');
console.log(`--- Distinct country_iso values in fact_main.csv (${factIsoSet.size} distinct) ---`);
[...factIsoSet].slice(0, 20).forEach((v) => show('  ', v));
if (factIsoSet.size > 20) console.log(`  ... and ${factIsoSet.size - 20} more`);

console.log('');
console.log(`--- Distinct country_iso values in dim_country.csv (${countryIsoSet.size} distinct) ---`);
[...countryIsoSet].forEach((v) => show('  ', v));

console.log('');
const matching = [...factIsoSet].filter((v) => countryIsoSet.has(v));
console.log(`--- Exact-match overlap: ${matching.length} of ${factIsoSet.size} fact_main country_iso values match a dim_country row exactly ---`);
if (matching.length) console.log('  Examples:', matching.slice(0, 5));

console.log('');
console.log('--- dim_country.csv: first 5 full rows (to check region_name is populated) ---');
countryRows.slice(0, 5).forEach((r, i) => console.log(`  [${i}]`, JSON.stringify(r)));
