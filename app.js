// Browser behaviour. The build step prepends calc.mjs and ledger.mjs (with `export` stripped)
// and wraps everything in one function, so paymentBreakdown(), ledgerHtml() etc. are in scope.

function setupCalc(form) {
  var cfg = JSON.parse(form.getAttribute('data-config'));
  var f = form.elements;
  var ledger = document.getElementById('ledger');
  var bar = document.getElementById('bar');
  var facts = document.getElementById('facts');
  var msg = document.getElementById('calc-msg');
  var states = cfg.states || {};
  var cur = { price: cfg.price, taxRate: cfg.taxRate, insRatePct: cfg.insRatePct };
  var insTouched = false;

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
      return;
    }
    msg.hidden = true;
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
    bar.innerHTML = barHtml(r);
    facts.innerHTML = factsHtml(r, cfg.incomeRatio);
  }

  form.addEventListener('input', function (e) {
    var t = e.target;
    if (t.name === 'state') {
      var s = states[t.value] || cfg.national || cur;
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

  var reset = document.getElementById('reset-btn');
  if (reset) {
    reset.addEventListener('click', function () {
      // An element with id="reset" would shadow form.reset, so call the prototype method.
      HTMLFormElement.prototype.reset.call(form);
      cur = { price: cfg.price, taxRate: cfg.taxRate, insRatePct: cfg.insRatePct };
      insTouched = false;
      render();
    });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
  });
}

function setupFilter(input) {
  var rows = Array.prototype.slice.call(document.querySelectorAll('#state-table tbody tr'));
  var empty = document.getElementById('no-match');
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
  var filter = document.getElementById('state-filter');
  if (filter) setupFilter(filter);
})();
