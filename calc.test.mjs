import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyPI, paymentBreakdown, incomeNeeded } from '../src/calc.mjs';

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test('principal and interest matches published amortization values', () => {
  near(monthlyPI(300000, 6.5, 30), 1896.2, 0.01); // $632.07 per $100k at 6.5% / 30y
  near(monthlyPI(200000, 4, 30), 954.83, 0.01);
  near(monthlyPI(100000, 5, 15), 790.79, 0.01);
});

test('zero-rate and zero-loan edge cases', () => {
  near(monthlyPI(120000, 0, 10), 1000);
  assert.equal(monthlyPI(0, 6, 30), 0);
});

test('breakdown adds tax, insurance and HOA, and skips PMI at 20% down', () => {
  const r = paymentBreakdown({
    homePrice: 400000, downPct: 20, ratePct: 6.5, years: 30,
    annualPropertyTax: 4800, annualInsurance: 1800, monthlyHoa: 100, pmiRatePct: 0.5,
  });
  near(r.loan, 320000);
  near(r.tax, 400);
  near(r.insurance, 150);
  assert.equal(r.pmi, 0);
  near(r.total, r.pi + 400 + 150 + 100);
});

test('PMI applies under 20% down', () => {
  const r = paymentBreakdown({
    homePrice: 300000, downPct: 10, ratePct: 6, years: 30,
    annualPropertyTax: 0, annualInsurance: 0, monthlyHoa: 0, pmiRatePct: 0.5,
  });
  near(r.loan, 270000);
  near(r.pmi, (270000 * 0.5) / 100 / 12);
});

test('total interest over the life of the loan', () => {
  const r = paymentBreakdown({
    homePrice: 375000, downPct: 20, ratePct: 6.5, years: 30,
    annualPropertyTax: 0, annualInsurance: 0, monthlyHoa: 0,
  });
  near(r.loan, 300000);
  near(r.totalInterest, 382633, 5);
});

test('income guideline', () => {
  near(incomeNeeded(2800, 0.28), 120000);
});
