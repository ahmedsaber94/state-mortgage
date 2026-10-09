// HTML for the payment "statement". Used at build time (so pages work without JavaScript)
// and in the browser (live updates). The import line is stripped when bundled for the browser.
import { incomeNeeded } from './calc.mjs';

export function money(n, d = 2) {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function rowsOf(r) {
  const rows = [
    ['pi', 'Principal and interest', r.pi],
    ['tax', 'Property tax', r.tax],
    ['ins', 'Home insurance', r.insurance],
  ];
  if (r.pmi > 0) rows.push(['pmi', 'Mortgage insurance (PMI)', r.pmi]);
  if (r.hoa > 0) rows.push(['hoa', 'HOA dues', r.hoa]);
  return rows;
}

export function ledgerHtml(r) {
  const lines = rowsOf(r)
    .map(
      ([k, label, v]) =>
        `<div class="line"><span class="key k-${k}" aria-hidden="true"></span><span class="lbl">${label}</span><span class="dots" aria-hidden="true"></span><span class="amt">${money(v)}</span></div>`
    )
    .join('');
  return `<div class="rows">${lines}</div><div class="line total"><span class="lbl">Total per month</span><span class="dots" aria-hidden="true"></span><span class="amt">${money(r.total)}</span></div>`;
}

export function barHtml(r) {
  return rowsOf(r)
    .map(([k, , v]) => `<span class="seg k-${k}" style="flex-grow:${v.toFixed(4)}"></span>`)
    .join('');
}

export function factsHtml(r, ratio = 0.28) {
  const items = [
    ['Loan amount', money(r.loan, 0)],
    ['Down payment', money(r.downPayment, 0)],
    [`Interest over ${r.years} years`, money(r.totalInterest, 0)],
    [`Income needed (${Math.round(ratio * 100)}% guideline)`, `${money(incomeNeeded(r.total, ratio), 0)} a year`],
  ];
  return items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}
