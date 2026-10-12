import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { syntheticData } from './helpers/synthetic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'src', 'build.mjs');

async function buildSynthetic() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mortgage-build-'));
  const dataFile = path.join(dir, 'states.json');
  const out = path.join(dir, 'dist');
  await writeFile(dataFile, JSON.stringify(syntheticData()));
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
