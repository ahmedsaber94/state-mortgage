// The 50 U.S. states with Census FIPS codes. DC and territories are left out on purpose.
const LIST = [
  ['01', 'Alabama', 'AL'], ['02', 'Alaska', 'AK'], ['04', 'Arizona', 'AZ'], ['05', 'Arkansas', 'AR'],
  ['06', 'California', 'CA'], ['08', 'Colorado', 'CO'], ['09', 'Connecticut', 'CT'], ['10', 'Delaware', 'DE'],
  ['12', 'Florida', 'FL'], ['13', 'Georgia', 'GA'], ['15', 'Hawaii', 'HI'], ['16', 'Idaho', 'ID'],
  ['17', 'Illinois', 'IL'], ['18', 'Indiana', 'IN'], ['19', 'Iowa', 'IA'], ['20', 'Kansas', 'KS'],
  ['21', 'Kentucky', 'KY'], ['22', 'Louisiana', 'LA'], ['23', 'Maine', 'ME'], ['24', 'Maryland', 'MD'],
  ['25', 'Massachusetts', 'MA'], ['26', 'Michigan', 'MI'], ['27', 'Minnesota', 'MN'], ['28', 'Mississippi', 'MS'],
  ['29', 'Missouri', 'MO'], ['30', 'Montana', 'MT'], ['31', 'Nebraska', 'NE'], ['32', 'Nevada', 'NV'],
  ['33', 'New Hampshire', 'NH'], ['34', 'New Jersey', 'NJ'], ['35', 'New Mexico', 'NM'], ['36', 'New York', 'NY'],
  ['37', 'North Carolina', 'NC'], ['38', 'North Dakota', 'ND'], ['39', 'Ohio', 'OH'], ['40', 'Oklahoma', 'OK'],
  ['41', 'Oregon', 'OR'], ['42', 'Pennsylvania', 'PA'], ['44', 'Rhode Island', 'RI'], ['45', 'South Carolina', 'SC'],
  ['46', 'South Dakota', 'SD'], ['47', 'Tennessee', 'TN'], ['48', 'Texas', 'TX'], ['49', 'Utah', 'UT'],
  ['50', 'Vermont', 'VT'], ['51', 'Virginia', 'VA'], ['53', 'Washington', 'WA'], ['54', 'West Virginia', 'WV'],
  ['55', 'Wisconsin', 'WI'], ['56', 'Wyoming', 'WY'],
];

export const STATES = LIST.map(([fips, name, abbr]) => ({
  fips,
  name,
  abbr,
  slug: name.toLowerCase().replace(/\s+/g, '-'),
}));

// ---- County figures ----------------------------------------------------------------------------
// Pure helpers for the county tables. Used by scripts/fetch-data.mjs (reading the Census response),
// src/build.mjs (checking data/counties.json before it is shown) and the tests. They live in this
// file so that the flat upload of files to the repository root keeps working unchanged.
// County figures come from the same two ACS tables as the state figures:
//   B25077 median value of owner-occupied homes, B25103 median real estate taxes paid.
// B25003 (owner-occupied housing units) tells us how many homes sit behind a county's medians.

export const COUNTY_VARS = { value: 'B25077_001E', tax: 'B25103_001E', owners: 'B25003_002E' };

// Medians from a handful of homes are noisy, so counties below this are left out.
export const MIN_OWNER_HOMES = 500;
// The "highest" and "lowest" county named in the page text come from counties with at least this many
// owner-occupied homes, so a headline never rests on a median from a very small sample.
export const HEADLINE_OWNER_HOMES = 2000;
// A county rate outside this band is far more likely to be a data problem than a real tax rate.
export const MIN_RATE = 0.05;
export const MAX_RATE = 4.5;

/** "Harris County, Texas" -> "Harris County". Other names are kept exactly as the Census Bureau gives them. */
export function countyName(fullName, stateName) {
  const name = String(fullName).trim();
  const suffix = `, ${stateName}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

/** A county entry as stored in counties.json: { n: name, v: median home value, t: median tax paid, o: owner-occupied homes }. */
export function isUsableCounty(c) {
  if (!c || typeof c.n !== 'string' || !c.n.trim()) return false;
  if (!Number.isFinite(c.v) || !Number.isFinite(c.t) || !(c.v > 0) || !(c.t > 0)) return false;
  const rate = (c.t / c.v) * 100;
  return rate >= MIN_RATE && rate <= MAX_RATE;
}

/**
 * Turns the Census API table (first row = column names) into { states: { slug: [{ n, v, t }] }, kept, skipped }.
 * Rows are skipped, never guessed: missing values (the Census Bureau uses large negative numbers),
 * too few owner-occupied homes, implausible rates, and areas outside the 50 states.
 */
export function parseCounties(table, states) {
  if (!Array.isArray(table) || table.length < 2) throw new Error('county table is empty');
  const [head, ...rows] = table;
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  for (const k of ['NAME', 'state', COUNTY_VARS.value, COUNTY_VARS.tax, COUNTY_VARS.owners]) {
    if (!(k in col)) throw new Error(`county table is missing the column ${k}`);
  }
  const byFips = new Map(states.map((s) => [s.fips, s]));
  const out = {};
  const skipped = { otherArea: 0, missing: 0, tooSmall: 0, implausible: 0 };
  let kept = 0;
  for (const r of rows) {
    const st = byFips.get(r[col.state]);
    if (!st) {
      skipped.otherArea++;
      continue;
    }
    const v = Number(r[col[COUNTY_VARS.value]]);
    const t = Number(r[col[COUNTY_VARS.tax]]);
    const owners = Number(r[col[COUNTY_VARS.owners]]);
    if (![v, t, owners].every(Number.isFinite) || v <= 0 || t <= 0) {
      skipped.missing++;
      continue;
    }
    if (owners < MIN_OWNER_HOMES) {
      skipped.tooSmall++;
      continue;
    }
    const entry = { n: countyName(r[col.NAME], st.name), v, t, o: owners };
    if (!isUsableCounty(entry)) {
      skipped.implausible++;
      continue;
    }
    (out[st.slug] ??= []).push(entry);
    kept++;
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.n.localeCompare(b.n, 'en'));
  return { states: out, kept, skipped };
}
