// Pulls the current mortgage rate (FRED / Freddie Mac) and state housing figures (Census ACS)
// and writes data/states.json. Run with:  CENSUS_API_KEY=xxxx node scripts/fetch-data.mjs
//
// Free Census key (takes ~2 minutes): https://api.census.gov/data/key_signup.html
// Optional FRED key (the script works without it): https://fred.stlouisfed.org/docs/api/api_key.html

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATES } from '../src/states.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CENSUS_KEY = process.env.CENSUS_API_KEY;
const FRED_KEY = process.env.FRED_API_KEY;
const UA = { 'user-agent': 'state-mortgage-calculators/1.0 (static site data refresh)' };

function die(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

if (!CENSUS_KEY) {
  die(
    'CENSUS_API_KEY is not set.\n' +
      'Get a free key at https://api.census.gov/data/key_signup.html and run:\n' +
      '  CENSUS_API_KEY=your_key npm run fetch'
  );
}

async function get(url, label) {
  let res;
  try {
    res = await fetch(url, { headers: UA });
  } catch (err) {
    throw new Error(`${label}: network error (${err.cause?.code ?? err.message})`);
  }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res;
}

// ---- Mortgage rate ---------------------------------------------------------
async function latestRate() {
  if (FRED_KEY) {
    const url =
      'https://api.stlouisfed.org/fred/series/observations?series_id=MORTGAGE30US' +
      `&sort_order=desc&limit=10&file_type=json&api_key=${encodeURIComponent(FRED_KEY)}`;
    const json = await (await get(url, 'FRED API')).json();
    const obs = (json.observations || []).find((o) => o.value !== '.' && Number.isFinite(parseFloat(o.value)));
    if (!obs) throw new Error('FRED API: no usable observation');
    return { rate: parseFloat(obs.value), date: obs.date };
  }
  const text = await (await get('https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US', 'FRED CSV')).text();
  const rows = text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(','))
    .filter(([, v]) => v && v !== '.' && Number.isFinite(parseFloat(v)));
  const last = rows.at(-1);
  if (!last) throw new Error('FRED CSV: no usable rows');
  return { rate: parseFloat(last[1]), date: last[0] };
}

// ---- Census ACS ------------------------------------------------------------
const VARS = { value: 'B25077_001E', tax: 'B25103_001E', income: 'B19013_001E' };

async function acsYear(year) {
  const url =
    `https://api.census.gov/data/${year}/acs/acs5?get=NAME,${VARS.value},${VARS.tax},${VARS.income}` +
    `&for=state:*&key=${encodeURIComponent(CENSUS_KEY)}`;
  const res = await get(url, `Census ACS ${year}`);
  const body = await res.text();
  let table;
  try {
    table = JSON.parse(body);
  } catch {
    throw new Error(`Census ACS ${year}: response was not JSON (is the API key valid and activated?)`);
  }
  const [head, ...rows] = table;
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  const byFips = new Map(rows.map((r) => [r[col.state], r]));
  const out = [];
  for (const s of STATES) {
    const r = byFips.get(s.fips);
    if (!r) throw new Error(`Census ACS ${year}: missing ${s.name}`);
    const medianHomeValue = Number(r[col[VARS.value]]);
    const medianPropertyTax = Number(r[col[VARS.tax]]);
    const medianIncome = Number(r[col[VARS.income]]);
    for (const [k, v] of Object.entries({ medianHomeValue, medianPropertyTax, medianIncome })) {
      // Census uses large negative sentinel values (e.g. -666666666) for "not available".
      if (!Number.isFinite(v) || v <= 0) throw new Error(`Census ACS ${year}: bad ${k} for ${s.name}: ${v}`);
    }
    const eff = (medianPropertyTax / medianHomeValue) * 100;
    if (eff < 0.1 || eff > 3.5) throw new Error(`Census ACS ${year}: implausible tax rate for ${s.name}: ${eff.toFixed(2)}%`);
    out.push({ slug: s.slug, name: s.name, abbr: s.abbr, medianHomeValue, medianPropertyTax, medianIncome });
  }
  return out;
}

async function latestAcs() {
  const thisYear = new Date().getFullYear();
  const errors = [];
  // The newest 5-year release is usually the previous calendar year (published in December).
  for (let y = thisYear - 1; y >= thisYear - 3; y--) {
    try {
      return { year: y, states: await acsYear(y) };
    } catch (err) {
      errors.push(err.message);
      if (/not JSON|valid/.test(err.message)) break; // a bad key will not get better with an older year
    }
  }
  throw new Error(errors.join('\n'));
}

// ---- Run -------------------------------------------------------------------
try {
  const [{ rate, date }, acs] = await Promise.all([latestRate(), latestAcs()]);
  if (!(rate > 1 && rate < 20)) throw new Error(`Implausible mortgage rate: ${rate}`);

  const data = {
    meta: {
      generated: new Date().toISOString().slice(0, 10),
      rate,
      rateDate: date,
      acsYear: acs.year,
      acsLabel: `${acs.year - 4}–${acs.year}`,
      synthetic: false,
    },
    states: acs.states,
  };

  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  await writeFile(path.join(ROOT, 'data', 'states.json'), JSON.stringify(data, null, 2) + '\n');
  console.log(`Saved ${data.states.length} states. 30-year rate ${rate}% (week of ${date}). ACS ${data.meta.acsLabel}.`);
} catch (err) {
  die(`Data refresh failed:\n${err.message}`);
}
