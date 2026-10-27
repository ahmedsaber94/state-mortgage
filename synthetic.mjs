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

// Fake county figures for tests ONLY. Wyoming has none, Rhode Island too few for a table (the build
// needs at least 3), and Texas carries two damaged entries that the build must drop. Names are listed
// in reverse order on purpose, so the tests can check that pages sort them.
export function syntheticCounties() {
  const states = {};
  STATES.forEach((s, i) => {
    if (s.slug === 'wyoming') return;
    const n = s.slug === 'rhode-island' ? 2 : 4 + (i % 5);
    const list = [];
    for (let j = 0; j < n; j++) {
      const v = 120000 + ((i * 7 + j * 13) % 40) * 9000;
      const eff = 0.3 + ((i * 5 + j * 11) % 30) * 0.05;
      const o = 600 + ((i * 3 + j * 17) % 40) * 150; // some below the 2,000 headline threshold, some above
      list.push({ n: `${s.name} County ${String.fromCharCode(65 + j)}`, v, t: Math.round((v * eff) / 100), o });
    }
    if (s.slug === 'texas') {
      list.push({ n: 'Broken County', v: 100000, t: -5 });
      list.push({ n: 'Wild County', v: 100000, t: 90000 });
      list.push({ n: "Doña Ana & O'Brien County", v: 200000, t: 3000, o: 5000 }); // characters that need escaping
    }
    states[s.slug] = list.reverse();
  });
  return { meta: { generated: '2026-10-09', acsYear: 2024, acsLabel: '2020–2024', minOwnerHomes: 500 }, states };
}
