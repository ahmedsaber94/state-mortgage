// Static site generator: data/states.json + config.json  ->  dist/
// Usage: node src/build.mjs [--data path] [--out dir] [--allow-synthetic]

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { STATES } from './states.mjs';
import { paymentBreakdown, incomeNeeded } from './calc.mjs';
import { ledgerHtml, barHtml, factsHtml, money } from './ledger.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DATA_PATH = path.resolve(arg('--data') ?? path.join(ROOT, 'data', 'states.json'));
const OUT = path.resolve(arg('--out') ?? path.join(ROOT, 'dist'));
const ALLOW_SYNTHETIC = argv.includes('--allow-synthetic');

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}
async function readJson(p, optional = false) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch (err) {
    if (optional && err.code === 'ENOENT') return null;
    throw err;
  }
}
async function readText(p) {
  try {
    return await readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// ---- Load ------------------------------------------------------------------
const config = await readJson(path.join(ROOT, 'config.json'));
let data;
try {
  data = await readJson(DATA_PATH);
} catch {
  fail(`No data file at ${DATA_PATH}.\nRun "npm run fetch" first. It needs a free CENSUS_API_KEY (see README).`);
}
if (data.meta?.synthetic && !ALLOW_SYNTHETIC) {
  fail('data/states.json is synthetic test data. Run "npm run fetch" to load real Census and Freddie Mac figures.');
}
const insRates = (await readJson(path.join(ROOT, 'data', 'insurance-rates.json'), true)) ?? {};
// Optional, sourced local facts per state (see README). Every item carries its own official source link.
const LOCAL = (await readJson(path.join(ROOT, 'local-content.json'), true)) ?? { states: {} };

if (!(OUT.length > 8) || ROOT.startsWith(OUT)) fail(`Refusing to clean output directory: ${OUT}`);

const warnings = [];
const SITE = config.siteUrl.replace(/\/+$/, '');
if (/example\.com/.test(SITE)) warnings.push('config.json: siteUrl is still example.com (sitemap and canonical links will be wrong).');
if (!config.contactEmail) warnings.push('config.json: contactEmail is empty (AdSense and visitors expect a contact address).');

// ---- Derived numbers -------------------------------------------------------
const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const round2 = (n) => Math.round(n * 100) / 100;
const roundK = (n) => Math.round(n / 1000) * 1000;

const bySlug = new Map(data.states.map((s) => [s.slug, s]));
const states = STATES.map((s) => {
  const d = bySlug.get(s.slug);
  if (!d) fail(`Data file is missing ${s.name}.`);
  for (const k of ['medianHomeValue', 'medianPropertyTax', 'medianIncome']) {
    if (!(d[k] > 0)) fail(`Bad ${k} for ${s.name} in data file.`);
  }
  const eff = (d.medianPropertyTax / d.medianHomeValue) * 100;
  return {
    ...s,
    ...d,
    eff,
    taxRate: round2(eff),
    // Start from the exact Census median so the page text and the calculator agree.
    price: d.medianHomeValue,
    insRatePct: insRates[s.slug] ?? config.insuranceRatePct,
  };
});
const ranked = [...states].sort((a, b) => b.eff - a.eff);
ranked.forEach((s, i) => (s.rank = i + 1));
const medianEff = median(states.map((s) => s.eff));
const national = {
  price: roundK(median(states.map((s) => s.medianHomeValue))),
  taxRate: round2(medianEff),
  insRatePct: config.insuranceRatePct,
};

const RATE = data.meta.rate;
const DOWN = config.defaultDownPct;
const YEARS = config.defaultTermYears;
const RATIO = config.incomeRatio;

function scenario(price, taxRate, insRatePct) {
  const insAnnual = Math.round((price * insRatePct) / 100);
  return paymentBreakdown({
    homePrice: price,
    downPct: DOWN,
    ratePct: RATE,
    years: YEARS,
    annualPropertyTax: (price * taxRate) / 100,
    annualInsurance: insAnnual,
    monthlyHoa: 0,
    pmiRatePct: config.pmiRatePct,
  });
}
for (const s of states) s.base = scenario(s.price, s.taxRate, s.insRatePct);

// ---- Formatting helpers ----------------------------------------------------
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd0 = (n) => money(n, 0);
const pct = (n, d = 2) => `${n.toFixed(d)}%`;
const ord = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const dateFmt = (iso, opts) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
const monthYear = (iso) => dateFmt(iso, { month: 'long', year: 'numeric' });
const longDate = (iso) => dateFmt(iso, { month: 'long', day: 'numeric', year: 'numeric' });
// Sourced local facts: homebuyer programs, property-tax rules, closing taxes. Items without an https link are skipped.
const LOCAL_SECTIONS = [
  ['programs', 'Homebuyer assistance'],
  ['propertyTax', 'Property tax exemptions and rules'],
  ['closing', 'Taxes and fees at closing'],
];
function localHtml(name, entry) {
  if (!entry) return '';
  const blocks = [];
  for (const [key, title] of LOCAL_SECTIONS) {
    const items = (entry[key] ?? []).filter((it) => it && it.text && it.source && /^https:\/\//.test(it.url ?? ''));
    if (!items.length) continue;
    const lis = items
      .map((it) => `<li>${esc(it.text)} <span class="src">(<a href="${esc(it.url)}" rel="noopener">${esc(it.source)}</a>)</span></li>`)
      .join('');
    blocks.push(`<h3>${esc(title)}</h3><ul>${lis}</ul>`);
  }
  if (!blocks.length) return '';
  const agency =
    entry.agency && /^https:\/\//.test(entry.agency.url ?? '')
      ? `<p>The state housing finance agency is <a href="${esc(entry.agency.url)}" rel="noopener">${esc(entry.agency.name)}</a>.</p>`
      : '';
  const checked = LOCAL.checked ? ` Last checked ${esc(monthYear(LOCAL.checked))}.` : '';
  return `${agency}${blocks.join('')}<p class="note">Each item links to the official source it comes from.${checked} Programs, limits and deadlines change, so confirm with the agency before you rely on them.</p>`;
}
const YEAR = new Date(`${data.meta.generated}T00:00:00Z`).getUTCFullYear();
const UPDATED = monthYear(data.meta.generated);
const RATE_DATE = longDate(data.meta.rateDate);
// Path prefix when the site is served from a sub-path (e.g. https://user.github.io/repo-name/).
// Leave empty for a custom domain at the root. Override with --base for tests.
const BASE = (arg('--base') ?? config.basePath ?? '').replace(/\/+$/, '');

// ---- Page chrome -----------------------------------------------------------
function layout({ title, description, urlPath, body, ld = [], noindex = false }) {
  const adsense = config.adsenseClient
    ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${esc(config.adsenseClient)}" crossorigin="anonymous"></script>`
    : '';
  const analytics = config.analyticsId
    ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(config.analyticsId)}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${esc(config.analyticsId)}');</script>`
    : '';
  const jsonld = ld
    .map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`)
    .join('');
  const canonical = `${SITE}${urlPath}`;
  const stateLinks = STATES.map(
    (s) => `<li><a href="${BASE}/mortgage-calculator/${s.slug}/">${esc(s.name)}</a></li>`
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" href="${BASE}/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="${BASE}/favicon.svg" type="image/svg+xml">
<link rel="icon" href="${BASE}/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="${BASE}/apple-touch-icon.png">
${noindex ?'<meta name="robots" content="noindex">' : ''}
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<link rel="stylesheet" href="${BASE}/assets/style.css">
${adsense}${analytics}${jsonld}
</head>
<body>
<header class="site-head"><div class="wrap">
<a class="brand" href="${BASE}/">${esc(config.siteName)}</a>
<nav aria-label="Main"><a href="${BASE}/#states">All states</a><a href="${BASE}/methodology/">Methodology</a><a href="${BASE}/about/">About</a></nav>
</div></header>
${body}
<footer class="site-foot"><div class="wrap">
<h2>Mortgage calculators by state</h2>
<ul class="statelinks">${stateLinks}</ul>
<div class="foot-links"><a href="${BASE}/methodology/">Methodology</a><a href="${BASE}/about/">About</a><a href="${BASE}/privacy/">Privacy policy</a><a href="${BASE}/disclaimer/">Disclaimer</a><a href="${BASE}/contact/">Contact</a></div>
<p>Mortgage rate: Freddie Mac Primary Mortgage Market Survey, via FRED, Federal Reserve Bank of St. Louis (week of ${esc(RATE_DATE)}). Housing and income figures: U.S. Census Bureau, American Community Survey ${esc(data.meta.acsLabel)} 5-year estimates.</p>
<p>These calculators give estimates for planning only. They are not a loan offer, and ${esc(config.siteName)} is not a lender or financial advisor. &copy; ${YEAR} ${esc(config.siteName)}.</p>
</div></footer>
<script src="${BASE}/assets/app.js" defer></script>
</body>
</html>
`;
}

function calcForm({ cfg, price, taxRate, insRatePct, stateSelect = '', taxHint }) {
  const insAnnual = Math.round((price * insRatePct) / 100);
  const config_ = esc(JSON.stringify(cfg));
  return `<form id="calc" class="calc" data-config="${config_}" novalidate>
${stateSelect}
<div class="grid">
<label class="field">Home price<span class="affix"><i class="pre">$</i><input name="price" type="number" inputmode="decimal" min="1" step="1000" value="${price}"></span></label>
<label class="field">Down payment<span class="affix"><input name="down" type="number" inputmode="decimal" min="0" max="99" step="1" value="${DOWN}"><i class="suf">%</i></span></label>
<label class="field">Loan term<select name="term"><option value="30"${YEARS === 30 ? ' selected' : ''}>30 years</option><option value="20"${YEARS === 20 ? ' selected' : ''}>20 years</option><option value="15"${YEARS === 15 ? ' selected' : ''}>15 years</option></select></label>
<label class="field">Interest rate<span class="affix"><input name="rate" type="number" inputmode="decimal" min="0" max="30" step="0.01" value="${RATE}"><i class="suf">%</i></span></label>
<label class="field">Property tax rate<span class="affix"><input name="taxRate" type="number" inputmode="decimal" min="0" step="0.01" value="${taxRate}"><i class="suf">%</i></span><small>${taxHint}</small></label>
<label class="field">Home insurance per year<span class="affix"><i class="pre">$</i><input name="insurance" type="number" inputmode="decimal" min="0" step="50" value="${insAnnual}"></span><small>Starts as a general estimate. Replace it with a real quote.</small></label>
<label class="field wide">HOA dues per month (optional)<span class="affix"><i class="pre">$</i><input name="hoa" type="number" inputmode="decimal" min="0" step="10" value="0"></span></label>
</div>
<p id="calc-msg" class="calc-msg" role="status" hidden></p>
<button type="button" id="reset-btn" class="linkbtn">Reset to defaults</button>
</form>`;
}

// Sources, date and a one-paragraph method, shown right under the payment so visitors do not have to
// hunt for the footer or the methodology page.
function trustNote(kind, s) {
  const how =
    kind === 'state'
      ? `Principal and interest use the standard fixed-rate loan formula. Property tax uses the ${esc(s.name)} average effective rate: the median real estate tax paid divided by the median home value. Home insurance is a general estimate that you can change.`
      : 'Principal and interest use the standard fixed-rate loan formula. Pick a state to start from its average property tax rate. Home insurance is a general estimate that you can change.';
  return `<div class="trust"><p><strong>How this is calculated.</strong> ${how}</p><p>Sources: <a href="https://www.freddiemac.com/pmms" rel="noopener">Freddie Mac mortgage rate survey</a>, week of ${esc(RATE_DATE)}; <a href="https://www.census.gov/programs-surveys/acs" rel="noopener">U.S. Census Bureau American Community Survey</a>, ${esc(data.meta.acsLabel)}. Updated ${esc(UPDATED)}. <a href="${BASE}/methodology/">Full methodology</a>.</p></div>`;
}

function statement(r, extra = '') {
  return `<section class="statement" aria-labelledby="st-h">
<h2 id="st-h">Estimated monthly payment</h2>
<div id="bar" class="bar" aria-hidden="true">${barHtml(r)}</div>
<div id="ledger" aria-live="polite">${ledgerHtml(r)}</div>
<dl id="facts" class="facts">${factsHtml(r, RATIO)}</dl>
<p class="note">Estimate only. Mortgage insurance (PMI) is added when the down payment is under 20%. Real taxes, insurance and lender fees vary by property.</p>
${extra}
</section>
<a id="sumbar" class="sumbar" href="#st-h" tabindex="-1" aria-hidden="true" hidden><span class="sb-l">Total per month</span><span id="sumbar-amt" class="sb-a">${money(r.total)}</span><span class="sb-go">Details &darr;</span></a>`;
}

const jsBase = (extra) => ({
  rate: RATE,
  downPct: DOWN,
  years: YEARS,
  pmiRatePct: config.pmiRatePct,
  incomeRatio: RATIO,
  ...extra,
});

// ---- Pages -----------------------------------------------------------------
async function statePage(s) {
  const r = s.base;
  const income = incomeNeeded(r.total, RATIO);
  const share = ((r.total * 12) / s.medianIncome) * 100;
  const diff = s.eff - medianEff;
  const compare =
    Math.abs(diff) < 0.05
      ? `close to the typical state rate of ${pct(medianEff)}`
      : diff > 0
        ? `above the typical state rate of ${pct(medianEff)}`
        : `below the typical state rate of ${pct(medianEff)}`;
  const rankText = s.rank === 1 ? 'the highest' : s.rank === 50 ? 'the lowest' : `the ${ord(s.rank)} highest`;
  const near = ranked
    .filter((o) => o.slug !== s.slug)
    .sort((a, b) => Math.abs(a.rank - s.rank) - Math.abs(b.rank - s.rank))
    .slice(0, 6)
    .sort((a, b) => a.rank - b.rank);
  const taxRows = [200000, 300000, 400000, 500000, 750000]
    .map((p) => {
      const annual = (p * s.eff) / 100;
      return `<tr><td>${usd0(p)}</td><td class="num">${usd0(annual)}</td><td class="num">${usd0(annual / 12)}</td></tr>`;
    })
    .join('');
  const editorial = [localHtml(s.name, LOCAL.states?.[s.slug]), await readText(path.join(ROOT, 'content', `${s.slug}.html`))]
    .filter(Boolean)
    .join('\n');

  const faqs = [
    [
      `What is the property tax rate in ${s.name}?`,
      `The average effective property tax rate in ${s.name} is ${pct(s.eff)}. Census Bureau data shows homeowners paid a median of ${usd0(s.medianPropertyTax)} a year on homes with a median value of ${usd0(s.medianHomeValue)}. Your own rate depends on your county, city and school district.`,
    ],
    [
      `How much is the monthly mortgage payment on a median-value home in ${s.name}?`,
      `About ${usd0(r.total)} a month including property tax and insurance, assuming ${DOWN}% down at ${RATE}% on a ${YEARS}-year loan. Principal and interest alone come to ${usd0(r.pi)}.`,
    ],
    [
      `How much income do I need to buy a home in ${s.name}?`,
      `A common guideline keeps housing costs under ${Math.round(RATIO * 100)}% of gross income. For the median-value home above, that works out to about ${usd0(income)} a year. Lenders also look at debts, credit score and savings, so your own number may differ.`,
    ],
    [
      'Does this calculator include property tax and insurance?',
      `Yes. It adds property tax at ${pct(s.eff)} of the home price and home insurance at ${s.insRatePct}% of the home price as a starting estimate. Change either number to match a real quote. Mortgage insurance is added automatically when the down payment is under 20%.`,
    ],
  ];

  const body = `<main>
<div class="wrap">
<nav class="crumbs" aria-label="Breadcrumb"><a href="${BASE}/">Home</a> / <a href="${BASE}/#states">Mortgage calculators</a> / ${esc(s.name)}</nav>
<div class="hero">
<h1>${esc(s.name)} mortgage calculator</h1>
<p class="lede">Estimate your monthly payment for a home in ${esc(s.name)}, with property tax at the state average of ${pct(s.eff)} and home insurance included. Rates use the ${RATE}% national 30-year average from Freddie Mac (week of ${esc(RATE_DATE)}).</p>
</div>
<div class="tool">
${calcForm({
  cfg: jsBase({ price: s.price, taxRate: s.taxRate, insRatePct: s.insRatePct }),
  price: s.price,
  taxRate: s.taxRate,
  insRatePct: s.insRatePct,
  taxHint: `${esc(s.name)} average effective rate`,
})}
${statement(r, trustNote('state', s))}
</div>

<section class="block">
<h2>What a typical home costs per month in ${esc(s.name)}</h2>
<p>A home valued at the ${esc(s.name)} median of ${usd0(s.medianHomeValue)} (the Census Bureau's figure for owner-occupied homes), bought with ${DOWN}% down at ${RATE}% over ${YEARS} years, comes to about <strong>${usd0(r.total)} a month</strong>. That is ${usd0(r.pi)} in principal and interest, ${usd0(r.tax)} in property tax and ${usd0(r.insurance)} in insurance.</p>
<p>Over a year that is ${pct(share, 1)} of the state's median household income of ${usd0(s.medianIncome)}. Keeping housing costs near ${Math.round(RATIO * 100)}% of gross income would take a household income of about ${usd0(income)}.</p>
</section>

<section class="block">
<h2>Property tax in ${esc(s.name)}</h2>
<p>${esc(s.name)} has ${rankText} effective property tax rate of the 50 states at ${pct(s.eff)}, ${compare}. The median ${esc(s.name)} homeowner pays ${usd0(s.medianPropertyTax)} a year.</p>
<div class="tablewrap"><table>
<caption class="sr-only">Estimated property tax by home price in ${esc(s.name)}</caption>
<thead><tr><th scope="col">Home price</th><th scope="col" class="num">Tax per year</th><th scope="col" class="num">Tax per month</th></tr></thead>
<tbody>${taxRows}</tbody>
</table></div>
<p class="note">These figures apply the statewide average rate. Rates differ between counties and taxing districts, and some homes qualify for exemptions.</p>
</section>

<section class="block">
<h2>States with similar property tax rates</h2>
<ul class="plain">${near
    .map(
      (o) =>
        `<li><a href="${BASE}/mortgage-calculator/${o.slug}/">${esc(o.name)}</a><span class="val">${pct(o.eff)} (${ord(o.rank)} highest)</span></li>`
    )
    .join('')}</ul>
</section>

${editorial ? `<section class="block prose"><h2>Buying a home in ${esc(s.name)}</h2>${editorial}</section>` : ''}

<section class="block">
<h2>Questions about ${esc(s.name)} mortgage payments</h2>
${faqs.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('\n')}
<p class="note">Last updated ${esc(UPDATED)}. See the <a href="${BASE}/methodology/">methodology</a> for sources and limits.</p>
</section>
</div>
</main>`;

  const title = `${s.name} Mortgage Calculator with Taxes & Insurance (${YEAR})`;
  const description = `Estimate your monthly mortgage payment in ${s.name}, including property tax (${pct(s.eff)} average rate) and home insurance. Uses the current ${RATE}% 30-year rate and Census data.`;
  const urlPath = `/mortgage-calculator/${s.slug}/`;
  return {
    urlPath,
    html: layout({
      title,
      description,
      urlPath,
      body,
      ld: [
        {
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
            { '@type': 'ListItem', position: 2, name: `${s.name} mortgage calculator`, item: `${SITE}${urlPath}` },
          ],
        },
        {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: faqs.map(([q, a]) => ({
            '@type': 'Question',
            name: q,
            acceptedAnswer: { '@type': 'Answer', text: a },
          })),
        },
      ],
    }),
  };
}

function homePage() {
  const natScenario = scenario(national.price, national.taxRate, national.insRatePct);
  const stateMap = Object.fromEntries(
    states.map((s) => [s.slug, { name: s.name, price: s.price, taxRate: s.taxRate, insRatePct: s.insRatePct }])
  );
  const select = `<label class="field wide" style="margin-bottom:16px">State<select name="state"><option value="">United States (typical)</option>${STATES.map(
    (s) => `<option value="${s.slug}">${esc(s.name)}</option>`
  ).join('')}</select><small>Loads the state's typical home value and property tax rate.</small></label>`;
  const top = ranked.slice(0, 5);
  const bottom = ranked.slice(-5).reverse();
  const li = (o) =>
    `<li><a href="${BASE}/mortgage-calculator/${o.slug}/">${esc(o.name)}</a><span class="val">${pct(o.eff)}</span></li>`;

  const rows = states
    .map(
      (s) =>
        `<tr data-name="${esc(s.name.toLowerCase())} ${s.abbr.toLowerCase()}"><td><a href="${BASE}/mortgage-calculator/${s.slug}/">${esc(s.name)}</a></td><td class="num">${usd0(s.medianHomeValue)}</td><td class="num">${pct(s.eff)}</td><td class="num">${usd0(s.base.total)}</td></tr>`
    )
    .join('');

  const body = `<main>
<div class="wrap">
<div class="hero">
<h1>Mortgage calculator for every U.S. state</h1>
<p class="lede">See your monthly payment with property tax and home insurance included. Choose a state to start from its typical home value and tax rate. The national 30-year rate is ${RATE}% (Freddie Mac, week of ${esc(RATE_DATE)}).</p>
</div>
<div class="tool">
${calcForm({
  cfg: jsBase({ ...national, states: stateMap, national }),
  price: national.price,
  taxRate: national.taxRate,
  insRatePct: national.insRatePct,
  stateSelect: select,
  taxHint: 'Typical state average. Pick a state to load its rate.',
})}
${statement(natScenario, trustNote('home'))}
</div>

<section class="block wide" id="states">
<h2>Compare all 50 states</h2>
<p>Median home value and property tax come from the Census Bureau. The monthly payment assumes a median-value home with ${DOWN}% down at ${RATE}% over ${YEARS} years, including property tax and insurance.</p>
<label class="field filter">Find a state<span class="affix"><input id="state-filter" type="search" autocomplete="off" placeholder="Type a state name"></span></label>
<div class="tablewrap"><table id="state-table">
<thead><tr><th scope="col">State</th><th scope="col" class="num">Median home value</th><th scope="col" class="num">Property tax rate</th><th scope="col" class="num">Monthly payment</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p id="no-match" hidden>No state matches that search.</p>
</section>

<section class="block wide">
<div class="split">
<div><h3>Highest property tax rates</h3><ul class="plain">${top.map(li).join('')}</ul></div>
<div><h3>Lowest property tax rates</h3><ul class="plain">${bottom.map(li).join('')}</ul></div>
</div>
<p class="note">Effective rate = median real estate tax paid divided by median home value, Census ACS ${esc(data.meta.acsLabel)}. Last updated ${esc(UPDATED)}.</p>
</section>
</div>
</main>`;

  return {
    urlPath: '/',
    html: layout({
      title: `Mortgage Calculator by State (${YEAR}) | ${config.siteName}`,
      description: `Free mortgage calculator for all 50 U.S. states with property tax and insurance built in. Current 30-year rate ${RATE}%.`,
      urlPath: '/',
      body,
    }),
  };
}

function simplePage({ urlPath, title, description, h1, content, noindex = false }) {
  const body = `<main><div class="wrap"><div class="hero"><h1>${esc(h1)}</h1></div><div class="prose block">${content}</div></div></main>`;
  return { urlPath, html: layout({ title: `${title} | ${config.siteName}`, description, urlPath, body, noindex }) };
}

function staticPages() {
  const email = config.contactEmail
    ? `<a href="mailto:${esc(config.contactEmail)}">${esc(config.contactEmail)}</a>`
    : 'the contact address on this page once it is added';
  const ads = config.adsenseClient
    ? `<p>We show ads through Google AdSense. Google and its partners use cookies to serve ads based on your visits to this and other websites. You can opt out of personalized advertising in <a href="https://adssettings.google.com">Google Ads Settings</a>, or learn more at <a href="https://policies.google.com/technologies/ads">how Google uses information from sites that use its services</a>.</p>`
    : '';
  const analytics = config.analyticsId
    ? `<p>We use Google Analytics to count visits and see which pages are useful. It sets cookies and collects your approximate location and device type. It does not tell us who you are.</p>`
    : '';
  return [
    simplePage({
      urlPath: '/methodology/',
      title: 'Methodology and Sources',
      h1: 'How the calculators work',
      description: 'Where the numbers on these mortgage calculators come from, how payments are calculated, and what the estimates leave out.',
      content: `
<h2>The payment formula</h2>
<p>Principal and interest use the standard fixed-rate formula: M = L &times; r(1+r)<sup>n</sup> / ((1+r)<sup>n</sup> &minus; 1), where L is the loan amount, r is the monthly interest rate and n is the number of monthly payments. Property tax and insurance are added as one twelfth of the yearly amount.</p>
<h2>Where the figures come from</h2>
<ul>
<li><strong>Mortgage rate:</strong> the weekly 30-year fixed average from the Freddie Mac Primary Mortgage Market Survey, published through FRED at the Federal Reserve Bank of St. Louis. The current value is ${RATE}% for the week of ${esc(RATE_DATE)}.</li>
<li><strong>Home values:</strong> median value of owner-occupied homes, Census Bureau American Community Survey ${esc(data.meta.acsLabel)} 5-year estimates (table B25077).</li>
<li><strong>Property tax:</strong> median real estate taxes paid by homeowners, same survey (table B25103). The effective rate is the median tax divided by the median home value.</li>
<li><strong>Income:</strong> median household income, same survey (table B19013).</li>
</ul>
<h2>Assumptions you can change</h2>
<ul>
<li>Home insurance starts at ${config.insuranceRatePct}% of the home price a year. This is a general starting estimate and not a figure measured for each state, so replace it with a quote from an insurer.</li>
<li>Mortgage insurance (PMI) is estimated at ${config.pmiRatePct}% of the loan a year when the down payment is under 20%. Actual PMI depends on credit score and loan type.</li>
<li>The income guideline uses ${Math.round(RATIO * 100)}% of gross income for housing costs. Lenders set their own limits.</li>
</ul>
<h2>What the estimates leave out</h2>
<ul>
<li>Home values in the Census survey are what owners report, not current listing or sale prices.</li>
<li>Medians describe the middle of a state. Your county, city and school district can have very different tax rates.</li>
<li>Closing costs, points, special assessments, flood insurance and exemptions such as homestead credits are not included.</li>
<li>The Census Bureau limits the highest reported tax amount, which can understate tax in very high-tax areas.</li>
</ul>
<h2>Updates</h2>
<p>The mortgage rate is refreshed weekly after Freddie Mac publishes it. Census figures are updated each year when a new 5-year release comes out. This site was last updated in ${esc(UPDATED)}.</p>
<p>Found a number that looks wrong? Write to ${email} and include the page address.</p>`,
    }),
    simplePage({
      urlPath: '/about/',
      title: 'About',
      h1: `About ${config.siteName}`,
      description: `${config.siteName} offers free mortgage payment calculators for every U.S. state, built on public Census Bureau and Freddie Mac data.`,
      content: `
<p>${esc(config.siteName)} publishes free mortgage calculators for each of the 50 U.S. states. Every page starts from official public data: the Census Bureau's housing and income survey and Freddie Mac's weekly mortgage rate. You can change any number to match your own situation.</p>
<p>We are an independent publisher. We are not a lender, mortgage broker or financial advisor, we do not take loan applications, and we do not sell your information to lenders. Read how we get and use our numbers on the <a href="${BASE}/methodology/">methodology page</a>.</p>
<p>Questions or corrections: ${email}.</p>`,
    }),
    simplePage({
      urlPath: '/privacy/',
      title: 'Privacy Policy',
      h1: 'Privacy policy',
      description: `How ${config.siteName} handles visitor data.`,
      content: `
<p>Last updated ${esc(UPDATED)}.</p>
<h2>What the calculators do with your numbers</h2>
<p>The home price, down payment and other values you type into a calculator are processed in your browser. They are not sent to our servers or stored.</p>
<h2>Server logs</h2>
<p>Our web host may keep standard server logs, such as IP address, browser type and the pages requested. These are used for security and to keep the site running.</p>
<h2>Cookies, analytics and advertising</h2>
${analytics}${ads}
<p>${config.analyticsId || config.adsenseClient ? 'You can block or delete cookies in your browser settings.' : 'This site currently sets no cookies.'}</p>
<h2>Children</h2>
<p>This site is for adults and is not directed to children under 13.</p>
<h2>Contact</h2>
<p>Privacy questions: ${email}.</p>`,
    }),
    simplePage({
      urlPath: '/disclaimer/',
      title: 'Disclaimer',
      h1: 'Disclaimer',
      description: 'The calculators on this site give estimates only and are not financial advice.',
      content: `
<p>The calculators and articles on ${esc(config.siteName)} are for general information and planning. Results are estimates built on averages and assumptions that may not match your loan, property or location.</p>
<p>Nothing here is financial, legal or tax advice, and nothing is an offer or commitment to lend. Interest rates, taxes, insurance costs and loan terms change and differ between lenders and properties. Talk to a licensed lender and a qualified professional before making a decision.</p>
<p>We work to keep our data accurate, but we make no guarantee that it is complete or current. See the <a href="${BASE}/methodology/">methodology</a> for sources and known limits.</p>`,
    }),
    simplePage({
      urlPath: '/contact/',
      title: 'Contact',
      h1: 'Contact',
      description: `Contact ${config.siteName} with questions, corrections or feedback.`,
      content: config.contactEmail
        ? `<p>Questions, corrections or feedback: ${email}.</p><p>If you are reporting a wrong number, include the page address and what you expected to see.</p>`
        : `<p>Contact details will appear here soon.</p>`,
    }),
  ];
}

// ---- Site icon -------------------------------------------------------------
// Navy tile with a cream house. One set of shapes drives both the SVG and the PNG/ICO pixels,
// so there are no image files to upload or keep in the repository.
const ICON_BG = '#16233a';
const ICON_FG = '#eef2ea';
const HOUSE = [[32, 11], [55, 31], [47, 31], [47, 52], [17, 52], [17, 31], [9, 31]];
const DOOR = { x: 27, y: 37, w: 10, h: 15 };
const ICON_RADIUS = 14;

const iconSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
  `<rect width="64" height="64" rx="${ICON_RADIUS}" fill="${ICON_BG}"/>` +
  `<path fill="${ICON_FG}" d="M${HOUSE.map((p) => p.join(' ')).join('L')}Z"/>` +
  `<rect x="${DOOR.x}" y="${DOOR.y}" width="${DOOR.w}" height="${DOOR.h}" fill="${ICON_BG}"/></svg>\n`;

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inTile(x, y, r) {
  if (x < 0 || y < 0 || x > 64 || y > 64) return false;
  const cx = x < r ? r : x > 64 - r ? 64 - r : x;
  const cy = y < r ? r : y > 64 - r ? 64 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
// round=false gives a full-bleed square (iOS rounds the corners itself and paints transparency black).
function iconPng(size, round = true) {
  const SS = 8;
  const radius = round ? ICON_RADIUS : 0;
  const bg = hexRgb(ICON_BG);
  const fg = hexRgb(ICON_FG);
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let n = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 64;
          const y = ((py + (sy + 0.5) / SS) / size) * 64;
          if (!inTile(x, y, radius)) continue;
          const door = x >= DOOR.x && x <= DOOR.x + DOOR.w && y >= DOOR.y && y <= DOOR.y + DOOR.h;
          const c = inPolygon(x, y, HOUSE) && !door ? fg : bg;
          n++; r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = py * stride + 1 + px * 4;
      if (n) {
        raw[o] = Math.round(r / n); raw[o + 1] = Math.round(g / n); raw[o + 2] = Math.round(b / n);
        raw[o + 3] = Math.round((255 * n) / (SS * SS));
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
// .ico that holds PNG images (supported by every current browser).
function iconIco(sizes) {
  const images = sizes.map((s) => iconPng(s));
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((img, i) => {
    const o = 6 + 16 * i;
    head[o] = sizes[i] % 256;
    head[o + 1] = sizes[i] % 256;
    head.writeUInt16LE(1, o + 4); // planes
    head.writeUInt16LE(32, o + 6); // bits per pixel
    head.writeUInt32LE(img.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += img.length;
  });
  return Buffer.concat([head, ...images]);
}

// ---- Write everything ------------------------------------------------------
async function writePage(p) {
  const dir = path.join(OUT, p.urlPath);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), p.html);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'assets'), { recursive: true });

const pages = [homePage(), ...(await Promise.all(states.map(statePage))), ...staticPages()];
for (const p of pages) await writePage(p);

// 404 (must be a top-level file for most static hosts)
await writeFile(
  path.join(OUT, '404.html'),
  layout({
    title: `Page not found | ${config.siteName}`,
    description: 'That page does not exist.',
    urlPath: '/404.html',
    noindex: true,
    body: `<main><div class="wrap"><div class="hero"><h1>That page does not exist</h1><p class="lede">Check the address, or <a href="${BASE}/">go to the home page</a> and pick your state from the list.</p></div></div></main>`,
  })
);

// Browser script: calc + ledger + app in one classic script (works from any static host)
const strip = (src) => src.replace(/^import .*$/gm, '').replace(/^export /gm, '');
const bundle = `(function () {\n'use strict';\n${strip(await readFile(path.join(ROOT, 'src', 'calc.mjs'), 'utf8'))}\n${strip(
  await readFile(path.join(ROOT, 'src', 'ledger.mjs'), 'utf8')
)}\n${await readFile(path.join(ROOT, 'src', 'app.js'), 'utf8')}\n})();\n`;
await writeFile(path.join(OUT, 'assets', 'app.js'), bundle);
await writeFile(path.join(OUT, 'assets', 'style.css'), await readFile(path.join(ROOT, 'assets', 'style.css')));

const indexable = pages.filter((p) => !p.urlPath.includes('404'));
await writeFile(
  path.join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${indexable
    .map((p) => `<url><loc>${esc(SITE + p.urlPath)}</loc><lastmod>${data.meta.generated}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`
);
await writeFile(path.join(OUT, 'favicon.svg'), iconSvg());
await writeFile(path.join(OUT, 'favicon.ico'), iconIco([16, 32, 48]));
await writeFile(path.join(OUT, 'icon-192.png'), iconPng(192));
await writeFile(path.join(OUT, 'apple-touch-icon.png'), iconPng(180, false));
await writeFile(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
if (config.adsenseClient) {
  const pub = config.adsenseClient.replace(/^ca-/, '');
  await writeFile(path.join(OUT, 'ads.txt'), `google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`);
}

console.log(`Built ${pages.length} pages into ${OUT} (${states.length} state pages).`);
for (const w of warnings) console.warn(`Warning: ${w}`);
