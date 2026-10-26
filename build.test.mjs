import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { syntheticData, syntheticCounties } from './helpers/synthetic.mjs';
import { STATES, COUNTY_VARS, MIN_OWNER_HOMES, countyName, isUsableCounty, parseCounties } from '../src/states.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'src', 'build.mjs');

async function buildSynthetic() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mortgage-build-'));
  const dataFile = path.join(dir, 'states.json');
  const out = path.join(dir, 'dist');
  await writeFile(dataFile, JSON.stringify(syntheticData()));
  await writeFile(path.join(dir, 'counties.json'), JSON.stringify(syntheticCounties()));
  // '--base' '' pins the root path so these tests do not depend on the deployed config.json.
  const res = spawnSync(process.execPath, [BUILD, '--data', dataFile, '--out', out, '--allow-synthetic', '--base', ''], { encoding: 'utf8' });
  return { dir, dataFile, out, res };
}

const exists = (p) => access(p).then(() => true, () => false);
const htmlFiles = async (out) =>
  (await readdir(out, { recursive: true })).filter((f) => f.endsWith('.html')).map((f) => path.join(out, f));

test('build refuses synthetic data without the explicit flag', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mortgage-refuse-'));
  const dataFile = path.join(dir, 'states.json');
  await writeFile(dataFile, JSON.stringify(syntheticData()));
  const res = spawnSync(process.execPath, [BUILD, '--data', dataFile, '--out', path.join(dir, 'dist')], { encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /synthetic/i);
});

test('build produces 50 state pages, home, static pages and sitemap', async () => {
  const { out, res } = await buildSynthetic();
  assert.equal(res.status, 0, res.stderr);
  const states = await readdir(path.join(out, 'mortgage-calculator'));
  assert.equal(states.length, 50);
  for (const p of ['index.html', 'methodology/index.html', 'about/index.html', 'privacy/index.html', 'disclaimer/index.html', 'contact/index.html', '404.html', 'sitemap.xml', 'robots.txt', 'assets/app.js', 'assets/style.css']) {
    assert.ok(await exists(path.join(out, p)), `missing ${p}`);
  }
  const sitemap = await readFile(path.join(out, 'sitemap.xml'), 'utf8');
  assert.equal((sitemap.match(/<loc>/g) || []).length, 56);
});

test('no broken internal links, and no NaN/undefined leaks', async () => {
  const { out } = await buildSynthetic();
  for (const file of await htmlFiles(out)) {
    const html = await readFile(file, 'utf8');
    assert.ok(!/NaN|undefined|\[object/.test(html), `bad value in ${file}`);
    for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]*)"/g)) {
      const target = m[1].endsWith('/') ? path.join(out, m[1], 'index.html') : path.join(out, m[1]);
      assert.ok(await exists(target), `${file} links to missing ${m[1]}`);
    }
  }
});

test('basePath prefixes every internal link and asset', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mortgage-base-'));
  const dataFile = path.join(dir, 'states.json');
  const out = path.join(dir, 'dist');
  await writeFile(dataFile, JSON.stringify(syntheticData()));
  const res = spawnSync(process.execPath, [BUILD, '--data', dataFile, '--out', out, '--allow-synthetic', '--base', '/sub'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  let checked = 0;
  for (const file of await htmlFiles(out)) {
    const html = await readFile(file, 'utf8');
    for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]*)"/g)) {
      assert.ok(m[1].startsWith('/sub/'), `${file} has unprefixed link ${m[1]}`);
      const rest = m[1].slice('/sub'.length);
      const target = rest.endsWith('/') ? path.join(out, rest, 'index.html') : path.join(out, rest);
      assert.ok(await exists(target), `${file} links to missing ${m[1]}`);
      checked++;
    }
  }
  assert.ok(checked > 1000);
  const sitemap = await readFile(path.join(out, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/[^<]+\/mortgage-calculator\/texas\/<\/loc>/);
});

test('site icon files are generated and linked from the page head', async () => {
  const { out, res } = await buildSynthetic();
  assert.equal(res.status, 0, res.stderr);
  const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (const [file, size] of [['icon-192.png', 192], ['apple-touch-icon.png', 180]]) {
    const png = await readFile(path.join(out, file));
    assert.deepEqual([...png.subarray(0, 8)], pngSig, `${file} is not a PNG`);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  const ico = await readFile(path.join(out, 'favicon.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  assert.match(await readFile(path.join(out, 'favicon.svg'), 'utf8'), /^<svg /);
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /<link rel="icon" href="\/favicon\.ico"/);
  assert.match(html, /<link rel="icon" href="\/favicon\.svg"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
});

test('phone summary bar repeats the monthly total, and form fields are 16px or larger', async () => {
  const { out, res } = await buildSynthetic();
  assert.equal(res.status, 0, res.stderr);
  for (const page of ['index.html', 'mortgage-calculator/texas/index.html']) {
    const html = await readFile(path.join(out, page), 'utf8');
    const bar = html.match(/<a id="sumbar"[^>]*>.*?<span id="sumbar-amt"[^>]*>([^<]+)<\/span>/s);
    assert.ok(bar, `${page} has no summary bar`);
    const total = html.match(/class="line total">.*?<span class="amt">([^<]+)<\/span>/s);
    assert.equal(bar[1], total[1], `${page}: bar total differs from the statement total`);
    assert.match(html, /<a id="sumbar"[^>]*aria-hidden="true"[^>]*hidden/, 'bar must start hidden and be aria-hidden');
  }
  const css = await readFile(path.join(ROOT, 'assets', 'style.css'), 'utf8');
  assert.match(css, /\.affix input \{[^}]*font-size:\s*max\(16px/);
  assert.match(css, /\.field select \{[^}]*font-size:\s*max\(16px/);
  assert.match(css, /\.sumbar\[hidden\]\s*\{\s*display:\s*none/);
});

test('titles and descriptions fit search results, and every page has a skip link and share card', async () => {
  const { out } = await buildSynthetic();
  const titles = new Set();
  for (const file of await htmlFiles(out)) {
    const html = await readFile(file, 'utf8');
    const name = path.relative(out, file);
    const title = html.match(/<title>([^<]*)<\/title>/)[1].replaceAll('&amp;', '&');
    const desc = html.match(/<meta name="description" content="([^"]*)">/)[1].replaceAll('&amp;', '&');
    assert.ok(title.length <= 60, `${name}: title is ${title.length} characters: ${title}`);
    assert.ok(!titles.has(title), `${name}: duplicate title ${title}`);
    titles.add(title);
    assert.ok(desc.length <= 160, `${name}: description is ${desc.length} characters`);
    if (name !== '404.html') assert.ok(desc.length >= 70, `${name}: description is only ${desc.length} characters`);
    assert.match(html, /<a class="skip" href="#main">/, `${name}: no skip link`);
    assert.match(html, /<main id="main" tabindex="-1">/, `${name}: main has no id for the skip link`);
    assert.match(html, /<meta name="twitter:card" content="summary">/, `${name}: no twitter card`);
  }
});

test('rows can grow on narrow phones, field borders are visible, and invalid input is not left looking current', async () => {
  const css = await readFile(path.join(ROOT, 'assets', 'style.css'), 'utf8');
  assert.match(css, /\.line \{[^}]*min-height:\s*32px/, 'ledger rows must grow instead of using a fixed height');
  assert.doesNotMatch(css, /\.line \{[^}]*[^-]height:\s*32px/);
  assert.match(css, /\.affix \{[^}]*border:\s*1px solid var\(--field-line\)/);
  assert.match(css, /--field-line:\s*#728872/);
  assert.match(css, /\.statement\.stale/);
  const js = await readFile(path.join(ROOT, 'src', 'app.js'), 'utf8');
  assert.match(js, /classList\.add\('stale'\)/);
  assert.match(js, /classList\.remove\('stale'\)/);
  assert.match(js, /getElementById\('state-table'\)/, 'sticky bar must step aside while the home page state table is on screen');
});

test('methodology page says the property tax average can understate what a new buyer pays', async () => {
  const { out } = await buildSynthetic();
  const html = await readFile(path.join(out, 'methodology/index.html'), 'utf8');
  assert.match(html, /limit how fast a home's assessed value can rise/);
  const tx = await readFile(path.join(out, 'mortgage-calculator/texas/index.html'), 'utf8');
  assert.match(tx, /Where a state caps yearly increases in assessed value/);
});

test('home page names the site for search engines', async () => {
  const { out } = await buildSynthetic();
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /"@type":"WebSite","name":"State Mortgage Calculators"/);
});

test('state pages carry different numbers, not just a swapped name', async () => {
  const { out } = await buildSynthetic();
  const tx = await readFile(path.join(out, 'mortgage-calculator/texas/index.html'), 'utf8');
  const ny = await readFile(path.join(out, 'mortgage-calculator/new-york/index.html'), 'utf8');
  const text = (h) => h.match(/<h2>What a typical home costs[\s\S]*?<\/section>/)[0].replace(/Texas|New York/g, 'X');
  assert.notEqual(text(tx), text(ny));
  assert.match(tx, /FAQPage/);
});

test('calculator starts at the exact median home value quoted in the page text', async () => {
  const { out } = await buildSynthetic();
  const data = syntheticData();
  for (const slug of ['texas', 'new-york', 'hawaii']) {
    const html = await readFile(path.join(out, `mortgage-calculator/${slug}/index.html`), 'utf8');
    const price = Number(html.match(/name="price"[^>]*value="(\d+)"/)[1]);
    const median = data.states.find((s) => s.slug === slug).medianHomeValue;
    assert.equal(price, median, `${slug}: calculator starts at ${price}, median is ${median}`);
    assert.ok(html.includes(median.toLocaleString('en-US')), `${slug}: median not quoted in text`);
  }
});

test('sources, date and method are shown next to the calculator', async () => {
  const { out } = await buildSynthetic();
  for (const p of ['index.html', 'mortgage-calculator/texas/index.html']) {
    const html = await readFile(path.join(out, p), 'utf8');
    const section = html.match(/<section class="statement"[\s\S]*?<\/section>/)[0];
    assert.match(section, /How this is calculated/, p);
    assert.match(section, /href="https:\/\/www\.freddiemac\.com\/pmms"/, p);
    assert.match(section, /href="https:\/\/www\.census\.gov\/programs-surveys\/acs"/, p);
    assert.match(section, /October 8, 2026/, p);
    assert.match(section, /Updated October 2026/, p);
  }
  const tx = await readFile(path.join(out, 'mortgage-calculator/texas/index.html'), 'utf8');
  assert.match(tx.match(/<div class="trust">[\s\S]*?<\/div>/)[0], /Texas average effective rate/);
});

test('browser bundle parses and loads without a DOM', async () => {
  const { out } = await buildSynthetic();
  const code = await readFile(path.join(out, 'assets/app.js'), 'utf8');
  assert.doesNotMatch(code, /^export /m);
  const sandbox = { document: { getElementById: () => null } };
  vm.runInNewContext(code, sandbox);
});

test('local-content.json is well formed: known states, https sources, no empty text', async () => {
  const raw = JSON.parse(await readFile(path.join(ROOT, 'local-content.json'), 'utf8'));
  const { STATES } = await import('../src/states.mjs');
  const slugs = new Set(STATES.map((s) => s.slug));
  assert.match(raw.checked, /^\d{4}-\d{2}-\d{2}$/);
  const allowed = new Set(['agency', 'programs', 'propertyTax', 'closing']);
  for (const [slug, entry] of Object.entries(raw.states)) {
    assert.ok(slugs.has(slug), `unknown state slug ${slug}`);
    for (const [key, val] of Object.entries(entry)) {
      assert.ok(allowed.has(key), `${slug}: unknown section ${key}`);
      const items = key === 'agency' ? [val] : val;
      for (const it of items) {
        const label = it.text ?? it.name;
        assert.ok(label && label.trim().length > 10, `${slug}.${key}: empty text`);
        assert.match(it.url, /^https:\/\/[^\s"<>]+$/, `${slug}.${key}: bad url`);
        if (key !== 'agency') {
          assert.ok(it.source && it.source.trim(), `${slug}.${key}: missing source name`);
          assert.ok(it.quote && it.quote.trim(), `${slug}.${key}: missing quote for audit`);
        }
      }
    }
  }
});

test('sourced local facts appear on the state page with their source link', async () => {
  const { out } = await buildSynthetic();
  const tx = await readFile(path.join(out, 'mortgage-calculator/texas/index.html'), 'utf8');
  assert.match(tx, /<h3>Property tax exemptions and rules<\/h3>/);
  assert.match(tx, /\$140,000 exemption/);
  assert.match(tx, /href="https:\/\/comptroller\.texas\.gov\/taxes\/property-tax\/exemptions\/"/);
  assert.match(tx, /Last checked October 2026/);
  // A state with no sourced entry must not show an empty section.
  const raw = JSON.parse(await readFile(path.join(ROOT, 'local-content.json'), 'utf8'));
  const { STATES } = await import('../src/states.mjs');
  const bare = STATES.find((s) => !raw.states[s.slug]);
  if (bare) {
    const html = await readFile(path.join(out, `mortgage-calculator/${bare.slug}/index.html`), 'utf8');
    assert.doesNotMatch(html, /Property tax exemptions and rules|Homebuyer assistance|Taxes and fees at closing/);
  }
});

const round2 = (n) => Math.round(n * 100) / 100;
const unesc = (s) => s.replaceAll('&amp;', '&').replaceAll('&#39;', "'");

test('county table lists each usable county, sorted, and drops damaged entries', async () => {
  const { out, res } = await buildSynthetic();
  assert.equal(res.status, 0, res.stderr);
  const html = await readFile(path.join(out, 'mortgage-calculator/texas/index.html'), 'utf8');
  const section = html.match(/<section class="block wide" id="counties">[\s\S]*?<\/section>/)[0];
  const rows = [...section.matchAll(/<tr data-name="([^"]*)" data-p="(\d+)" data-r="([\d.]+)"><td>([^<]*)<\/td><td class="num">([\d.]+)%<\/td><td class="num">\$([\d,]+)<\/td><td class="num">\$([\d,]+)<\/td><\/tr>/g)];
  const valid = syntheticCounties().states.texas.filter((c) => c.t > 0 && c.t / c.v < 0.045);
  assert.equal(rows.length, valid.length);
  const names = rows.map((r) => unesc(r[4]));
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
  for (const r of rows) {
    const c = valid.find((x) => x.n === unesc(r[4]));
    assert.ok(c, `unexpected row ${r[4]}`);
    assert.equal(Number(r[2]), c.v);
    assert.equal(Number(r[3]), round2((c.t / c.v) * 100));
    assert.equal(r[6], c.t.toLocaleString('en-US'));
    assert.equal(r[7], c.v.toLocaleString('en-US'));
  }
  assert.doesNotMatch(html, /Broken County|Wild County/);
  assert.ok(html.includes('Doña Ana &amp; O&#39;Brien County'), 'names with & and an apostrophe must be escaped');
  assert.ok(!html.includes("O'Brien County"), 'raw apostrophe leaked into the page');
  // The picker has one option per row plus the state average, and the option index points at that row.
  const select = html.match(/<select name="county">([\s\S]*?)<\/select>/)[1];
  const options = [...select.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)];
  assert.equal(options.length, rows.length + 1);
  assert.equal(options[0][1], '');
  options.slice(1).forEach((o, i) => {
    assert.equal(o[1], String(i));
    assert.equal(unesc(o[2]), names[i]);
  });
  // Text and structured data use the same extremes as the table.
  const byRate = [...rows].sort((a, b) => Number(b[3]) - Number(a[3]));
  const lowest = byRate.at(-1);
  assert.match(section, new RegExp(`from ${lowest[5]}% in ${lowest[4]} to ${byRate[0][5]}% in ${byRate[0][4]}`));
  assert.match(html, /Which Texas county has the highest property tax rate\?/);
  assert.match(html, /href="#counties">county table<\/a> below/);
  assert.match(section, /fewer than 500 owner-occupied homes/);
});

test('county picker and table are wired to the calculator script', async () => {
  const { out } = await buildSynthetic();
  const js = await readFile(path.join(out, 'assets/app.js'), 'utf8');
  assert.match(js, /#county-table tbody tr/);
  assert.match(js, /t\.name === 'county'/);
  assert.match(js, /setupFilter\(countyFilter, 'county-table', 'county-no-match'\)/);
  const html = await readFile(path.join(out, 'mortgage-calculator/texas/index.html'), 'utf8');
  assert.match(html, /id="county-filter"/);
  assert.match(html, /id="county-no-match" hidden/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids on the page');
});

test('Louisiana and Alaska use their own words for county areas', async () => {
  const { out } = await buildSynthetic();
  const la = await readFile(path.join(out, 'mortgage-calculator/louisiana/index.html'), 'utf8');
  assert.match(la, /<h2>Property tax by parish in Louisiana<\/h2>/);
  assert.match(la, /<label class="field wide"[^>]*>Parish<select name="county">/);
  const ak = await readFile(path.join(out, 'mortgage-calculator/alaska/index.html'), 'utf8');
  assert.match(ak, /<h2>Property tax by borough or census area in Alaska<\/h2>/);
});

test('states with no or too few counties get no county section or picker', async () => {
  const { out } = await buildSynthetic();
  for (const slug of ['wyoming', 'rhode-island']) {
    const html = await readFile(path.join(out, `mortgage-calculator/${slug}/index.html`), 'utf8');
    assert.doesNotMatch(html, /county-table|name="county"|href="#counties"|id="counties"/, slug);
  }
  const home = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.doesNotMatch(home, /county-table|name="county"/);
});

test('build still works without counties.json, or with a damaged one', async () => {
  for (const content of [null, '{not json']) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mortgage-nocounty-'));
    const dataFile = path.join(dir, 'states.json');
    const out = path.join(dir, 'dist');
    await writeFile(dataFile, JSON.stringify(syntheticData()));
    if (content) await writeFile(path.join(dir, 'counties.json'), content);
    const res = spawnSync(process.execPath, [BUILD, '--data', dataFile, '--out', out, '--allow-synthetic', '--base', ''], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    if (content) assert.match(res.stderr, /counties\.json could not be read/);
    for (const file of await htmlFiles(out)) {
      assert.doesNotMatch(await readFile(file, 'utf8'), /county-table|name="county"|County figures:/, file);
    }
  }
});

test('methodology page explains the county figures when they are shown', async () => {
  const { out } = await buildSynthetic();
  const html = await readFile(path.join(out, 'methodology/index.html'), 'utf8');
  assert.match(html, /<strong>County figures:<\/strong>/);
  assert.match(html, /It is not the official rate the county publishes/);
});

const HEAD = ['NAME', COUNTY_VARS.value, COUNTY_VARS.tax, COUNTY_VARS.owners, 'state', 'county'];
const row = (name, v, t, owners, state, county = '001') => [name, String(v), String(t), String(owners), state, county];

test('county names drop only the trailing state', () => {
  assert.equal(countyName('Harris County, Texas', 'Texas'), 'Harris County');
  assert.equal(countyName('Richmond city, Virginia', 'Virginia'), 'Richmond city');
  assert.equal(countyName('Capitol Planning Region, Connecticut', 'Connecticut'), 'Capitol Planning Region');
  assert.equal(countyName('Something', 'Texas'), 'Something');
});

test('county rows are checked, not guessed', () => {
  const table = [
    HEAD,
    row('Harris County, Texas', 250000, 4000, 900000, '48'),
    row('Dallas County, Texas', 300000, 5500, 400000, '48'),
    row('Loving County, Texas', 80000, 600, 40, '48'), // too few homes
    row('Kenedy County, Texas', -666666666, -666666666, 120, '48'), // Census "not available"
    row('Odd County, Texas', 100000, 90000, 5000, '48'), // 90% is not a tax rate
    row('Missing County, Texas', null, 3000, 5000, '48'),
    row('Ponce Municipio, Puerto Rico', 90000, 500, 9000, '72'), // outside the 50 states
    row('Autauga County, Alabama', 190000, 800, 15000, '01'),
  ];
  const out = parseCounties(table, STATES);
  assert.equal(out.kept, 3);
  assert.deepEqual(out.skipped, { otherArea: 1, missing: 2, tooSmall: 1, implausible: 1 });
  assert.deepEqual(out.states.texas.map((c) => c.n), ['Dallas County', 'Harris County']);
  assert.deepEqual(out.states.texas[1], { n: 'Harris County', v: 250000, t: 4000 });
  assert.deepEqual(out.states.alabama, [{ n: 'Autauga County', v: 190000, t: 800 }]);
});

test('owner-home threshold is inclusive and bad tables are refused', () => {
  const ok = parseCounties([HEAD, row('A County, Ohio', 150000, 2000, MIN_OWNER_HOMES, '39')], STATES);
  assert.equal(ok.kept, 1);
  const short = parseCounties([HEAD, row('A County, Ohio', 150000, 2000, MIN_OWNER_HOMES - 1, '39')], STATES);
  assert.equal(short.kept, 0);
  assert.throws(() => parseCounties([], STATES), /empty/);
  assert.throws(() => parseCounties([['NAME', 'state'], ['A', '39']], STATES), /missing the column/);
});

test('stored county entries must have a name, positive numbers and a believable rate', () => {
  assert.ok(isUsableCounty({ n: 'A County', v: 200000, t: 2400 }));
  assert.ok(!isUsableCounty({ n: '', v: 200000, t: 2400 }));
  assert.ok(!isUsableCounty({ n: 'A', v: 0, t: 10 }));
  assert.ok(!isUsableCounty({ n: 'A', v: 200000, t: -1 }));
  assert.ok(!isUsableCounty({ n: 'A', v: 200000, t: 'x' }));
  assert.ok(!isUsableCounty({ n: 'A', v: 200000, t: 20 })); // 0.01%
  assert.ok(!isUsableCounty({ n: 'A', v: 100000, t: 6000 })); // 6%
  assert.ok(!isUsableCounty(null));
});
