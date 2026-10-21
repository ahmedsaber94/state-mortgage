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
const RATE_MAX_AGE_DAYS = 35;
const plausible = (v) => Number.isFinite(v) && v > 1 && v < 20;

// observations: [{ date: 'YYYY-MM-DD', value: '6.30' }] in any order. Only well-formed rows count.
// Returns the newest plausible one. A bad value is skipped with a warning, so one source glitch
// cannot block the whole refresh, and the page shows the real date of the rate it uses.
function pickRate(observations) {
  const rows = observations
    .filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date) && /^\d+(\.\d+)?$/.test(String(o.value).trim()))
    .map((o) => ({ date: o.date, rate: parseFloat(o.value) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!rows.length) throw new Error('FRED: no well-formed observations');
  for (const row of rows.slice(0, 8)) {
    if (plausible(row.rate)) {
      const ageDays = (Date.now() - Date.parse(row.date)) / 86400000;
      if (ageDays > RATE_MAX_AGE_DAYS) throw new Error(`FRED: the newest usable rate is from ${row.date}, which is too old`);
      return row;
    }
    console.warn(`Skipping implausible FRED value ${row.rate} for ${row.date}`);
  }
  throw new Error(
    `FRED: no plausible rate among the latest observations (${rows
      .slice(0, 3)
      .map((r) => `${r.date}=${r.rate}`)
      .join(', ')})`
  );
}

async function getWithRetry(url, label, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await get(url, label);
    } catch (err) {
      last = err;
      if (i < tries) await new Promise((r) => setTimeout(r, 4000 * i));
    }
  }
  throw last;
}

async function latestRate() {
  if (FRED_KEY) {
    const url =
      'https://api.stlouisfed.org/fred/series/observations?series_id=MORTGAGE30US' +
      `&sort_order=desc&limit=10&file_type=json&api_key=${encodeURIComponent(FRED_KEY)}`;
    const json = await (await getWithRetry(url, 'FRED API')).json();
    return pickRate((json.observations || []).map((o) => ({ date: o.date, value: o.value })));
  }
  const text = await (await getWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US', 'FRED CSV')).text();
  const rows = text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(','))
    .map(([date, value]) => ({ date: (date || '').trim(), value: (value || '').trim() }));
  try {
    return pickRate(rows);
  } catch (err) {
    // Show what FRED actually sent, so a source-side change is visible in the log.
    throw new Error(`${err.message}\nStart of response: ${JSON.stringify(text.slice(0, 200))}\nEnd of response: ${JSON.stringify(text.slice(-200))}`);
  }
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
