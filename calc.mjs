// Pure calculator math. Runs in Node (tests, build) and is bundled into the browser script.

/** Monthly principal-and-interest payment on a fixed-rate loan. */
export function monthlyPI(loan, annualRatePct, years) {
  const n = years * 12;
  if (!(loan > 0) || !(n > 0)) return 0;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return loan / n;
  const f = Math.pow(1 + r, n);
  return (loan * r * f) / (f - 1);
}

/**
 * Full monthly breakdown.
 * PMI is estimated only when the down payment is under 20%.
 */
export function paymentBreakdown(o) {
  const price = o.homePrice;
  const downPct = o.downPct;
  const loan = price * (1 - downPct / 100);
  const pi = monthlyPI(loan, o.ratePct, o.years);
  const tax = (o.annualPropertyTax || 0) / 12;
  const insurance = (o.annualInsurance || 0) / 12;
  const hoa = o.monthlyHoa || 0;
  const pmiRate = o.pmiRatePct == null ? 0.5 : o.pmiRatePct;
  const pmi = downPct < 20 ? (loan * pmiRate) / 100 / 12 : 0;
  const total = pi + tax + insurance + hoa + pmi;
  const totalInterest = Math.max(0, pi * o.years * 12 - loan);
  return {
    price,
    downPct,
    downPayment: (price * downPct) / 100,
    loan,
    years: o.years,
    pi,
    tax,
    insurance,
    hoa,
    pmi,
    total,
    totalInterest,
  };
}

/** Gross yearly income at which the monthly total equals `ratio` of income (a guideline, not a lender rule). */
export function incomeNeeded(totalMonthly, ratio = 0.28) {
  return (totalMonthly * 12) / ratio;
}
