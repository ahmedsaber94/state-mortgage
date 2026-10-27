// Browser behaviour. The build step prepends calc.mjs and ledger.mjs (with `export` stripped)
// and wraps everything in one function, so paymentBreakdown(), ledgerHtml() etc. are in scope.

function setupCalc(form) {
  var cfg = JSON.parse(form.getAttribute('data-config'));
  var f = form.elements;
  var ledger = document.getElementById('ledger');
  var bar = document.getElementById('bar');
  var facts = document.getElementById('facts');
  var msg = document.getElementById('calc-msg');
  var sumAmt = document.getElementById('sumbar-amt');
  var stmt = document.querySelector('.statement');
  var states = cfg.states || {};
  var cur = { price: cfg.price, taxRate: cfg.taxRate, insRatePct: cfg.insRatePct };
  var insTouched = false;
  // State pages with county data have a county picker and a table; the picker reads the table rows.
  var countyRows = document.querySelectorAll('#county-table tbody tr');
  var hintEl = f.taxRate.closest ? f.taxRate.closest('label').querySelector('small') : null;
  var baseHint = hintEl ? hintEl.textContent : '';

  function val(name) {
    var v = parseFloat(f[name].value);
    return isFinite(v) ? v : NaN;
  }

  function autoInsurance() {
    if (insTouched) return;
    var p = val('price');
    f.insurance.value = p > 0 ? Math.round((p * cur.insRatePct) / 100) : 0;
  }

  function render() {
    var price = val('price');
    var down = val('down');
    var rate = val('rate');
    var term = val('term');
    var taxRate = val('taxRate');
    var ins = val('insurance');
    var hoa = f.hoa.value === '' ? 0 : val('hoa');
    var problems = [];
    if (!(price > 0)) problems.push('Enter a home price above $0.');
    if (!(down >= 0 && down < 100)) problems.push('Down payment must be from 0% to 99%.');
    if (!(rate >= 0 && rate <= 30)) problems.push('Enter an interest rate from 0% to 30%.');
    if (!(taxRate >= 0)) problems.push('Enter a property tax rate of 0% or more.');
    if (!(ins >= 0)) problems.push('Enter home insurance as a yearly amount, or 0.');
    if (!(hoa >= 0)) problems.push('Enter HOA dues as a monthly amount, or 0.');
    if (problems.length) {
      msg.textContent = problems.join(' ');
      msg.hidden = false;
      if (sumAmt) sumAmt.textContent = '—';
      // Do not leave the last good numbers on screen next to an error: dash the total and dim the rest.
      var shown = ledger.querySelector('.total .amt');
      if (shown) shown.textContent = '—';
      if (stmt) stmt.classList.add('stale');
      return;
    }
    msg.hidden = true;
    if (stmt) stmt.classList.remove('stale');
    var r = paymentBreakdown({
      homePrice: price,
      downPct: down,
      ratePct: rate,
      years: term,
      annualPropertyTax: (price * taxRate) / 100,
      annualInsurance: ins,
      monthlyHoa: hoa,
      pmiRatePct: cfg.pmiRatePct,
    });
    ledger.innerHTML = ledgerHtml(r);
    if (sumAmt) sumAmt.textContent = money(r.total);
    bar.innerHTML = barHtml(r);
    facts.innerHTML = factsHtml(r, cfg.incomeRatio);
  }

  form.addEventListener('input', function (e) {
    var t = e.target;
    if (t.name === 'state' || t.name === 'county') {
      var s;
      if (t.name === 'state') {
        s = states[t.value] || cfg.national || cur;
      } else {
        var row = t.value === '' ? null : countyRows[parseInt(t.value, 10)];
        if (row) {
          s = { price: parseFloat(row.getAttribute('data-p')), taxRate: parseFloat(row.getAttribute('data-r')), insRatePct: cfg.insRatePct };
        } else {
          s = { price: cfg.price, taxRate: cfg.taxRate, insRatePct: cfg.insRatePct };
        }
        if (hintEl) hintEl.textContent = row ? row.cells[0].textContent + ' effective rate' : baseHint;
      }
      cur = { price: s.price, taxRate: s.taxRate, insRatePct: s.insRatePct };
      f.price.value = cur.price;
      f.taxRate.value = cur.taxRate;
      insTouched = false;
      autoInsurance();
      render();
      return;
    }
    if (t.name === 'insurance') insTouched = true;
    if (t.name === 'price') autoInsurance();
    render();
  });

  // Home page: choosing a state opens that state's page (it has the county picker, county table and local facts).
  // The input handler above has already loaded the state's numbers by then, which is what a keyboard user sees.
  // On a closed list, arrow keys and typed letters change the value step by step (typing "T" lands on Tennessee before
  // "Texas" can be finished), so they never move the page: the link under the list (shown for every choice) is how a
  // keyboard user goes on. A click, a tap, Enter or Space (committing an open list) opens the page.
  var stateSel = f.state;
  var goBox = document.getElementById('state-go');
  var lastKey = '';
  function showGoLink() {
    // Returns the chosen state's page address, or '' when no state is chosen. Also fills in the link under the list.
    var slug = stateSel.value;
    var s = states[slug];
    if (!slug || !s) {
      if (goBox) goBox.hidden = true;
      return '';
    }
    var href = (stateSel.getAttribute('data-path') || '') + slug + '/';
    var link = goBox ? goBox.querySelector('a') : null;
    if (link) {
      link.setAttribute('href', href);
      link.textContent = 'Open the ' + s.name + ' page →';
      goBox.hidden = false;
    }
    return href;
  }
  if (stateSel && stateSel.tagName === 'SELECT') {
    stateSel.addEventListener('keydown', function (e) {
      lastKey = e.key || '';
    });
    ['pointerdown', 'mousedown', 'touchstart'].forEach(function (name) {
      stateSel.addEventListener(name, function () {
        lastKey = '';
      });
    });
    stateSel.addEventListener('change', function () {
      var href = showGoLink();
      if (!href || !(lastKey === '' || lastKey === 'Enter' || lastKey === ' ')) return;
      window.location.href = href;
    });
  }

  var reset = document.getElementById('reset-btn');
  if (reset) {
    reset.addEventListener('click', function () {
      // An element with id="reset" would shadow form.reset, so call the prototype method.
      HTMLFormElement.prototype.reset.call(form);
      cur = { price: cfg.price, taxRate: cfg.taxRate, insRatePct: cfg.insRatePct };
      insTouched = false;
      if (hintEl) hintEl.textContent = baseHint;
      if (goBox) goBox.hidden = true;
      render();
    });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
  });

  // Coming back with the Back button (or a reload) makes the browser put the old field values back, including the
  // chosen state or county, while the statement is built from the page's defaults. Redraw it from what the fields hold.
  // Browsers put the values back after the page has loaded, so this also runs on "pageshow".
  function syncRestored() {
    if (stateSel && stateSel.tagName === 'SELECT' && states[stateSel.value]) {
      var st = states[stateSel.value];
      cur = { price: st.price, taxRate: st.taxRate, insRatePct: st.insRatePct };
      showGoLink();
    }
    if (f.county && f.county.value !== '' && hintEl) {
      var back = countyRows[parseInt(f.county.value, 10)];
      if (back) hintEl.textContent = back.cells[0].textContent + ' effective rate';
    }
    // Only redraw when a field differs from the page's own value, so a normal visit leaves the statement untouched.
    var restored = false;
    for (var i = 0; i < form.elements.length; i++) {
      var el = form.elements[i];
      if (el.tagName === 'INPUT' && el.value !== el.defaultValue) restored = true;
      if (el.tagName === 'SELECT') {
        var first = 0;
        for (var j = 0; j < el.options.length; j++) if (el.options[j].defaultSelected) first = j;
        if (el.selectedIndex !== first) restored = true;
      }
    }
    if (restored) render();
  }
  syncRestored();
  window.addEventListener('pageshow', syncRestored);
}

// Sticky total on phones: shown only while the full payment statement is scrolled out of view.
// It also stays hidden while the state table (home page) or the county table (state pages) is on screen,
// because the visitor is comparing rows there and the monthly total of the calculator above is not what they are reading.
function setupSumBar() {
  var sum = document.getElementById('sumbar');
  if (!sum || !('IntersectionObserver' in window)) return;
  var statement = document.querySelector('.statement');
  if (!statement) return;
  var watch = [statement];
  var table = document.getElementById('state-table');
  if (table) watch.push(table);
  var countyTable = document.getElementById('county-table');
  if (countyTable) watch.push(countyTable);
  var seen = new Map();
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      seen.set(e.target, e.isIntersecting);
    });
    sum.hidden = watch.some(function (el) {
      return seen.get(el);
    });
  });
  watch.forEach(function (el) {
    io.observe(el);
  });
}

function setupFilter(input, tableId, emptyId) {
  var rows = Array.prototype.slice.call(document.querySelectorAll('#' + tableId + ' tbody tr'));
  var empty = document.getElementById(emptyId);
  input.addEventListener('input', function () {
    var q = input.value.trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (row) {
      var hit = !q || row.getAttribute('data-name').indexOf(q) !== -1;
      row.hidden = !hit;
      if (hit) shown++;
    });
    empty.hidden = shown > 0;
  });
}

(function init() {
  var form = document.getElementById('calc');
  if (form) setupCalc(form);
  setupSumBar();
  var filter = document.getElementById('state-filter');
  if (filter) setupFilter(filter, 'state-table', 'no-match');
  var countyFilter = document.getElementById('county-filter');
  if (countyFilter) setupFilter(countyFilter, 'county-table', 'county-no-match');
})();
