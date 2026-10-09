// Fake data for tests ONLY. Flagged synthetic so the real build refuses to publish it.
import { STATES } from '../../src/states.mjs';

export function syntheticData() {
  const states = STATES.map((s, i) => {
    const value = 150000 + ((i * 37) % 50) * 13000;
    const eff = 0.3 + ((i * 17) % 50) * 0.034;
    return {
      slug: s.slug,
      name: s.name,
      abbr: s.abbr,
      medianHomeValue: value,
      medianPropertyTax: Math.round((value * eff) / 100),
      medianIncome: 55000 + ((i * 29) % 50) * 1100,
    };
  });
  return {
    meta: {
      generated: '2026-10-09',
      rate: 6.5,
      rateDate: '2026-10-08',
      acsYear: 2024,
      acsLabel: '2020–2024',
      synthetic: true,
    },
    states,
  };
}
