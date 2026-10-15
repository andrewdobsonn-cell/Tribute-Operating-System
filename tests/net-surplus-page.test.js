/* Net Surplus page — assertions against the SHIPPED inline script.
 *
 * Run: node tests/net-surplus-page.test.js
 *
 * tests/net-surplus.test.js covers the model in availability_core.js. This
 * covers the part that only exists on the page: which caregivers are held out,
 * how the three sections combine into a net, and the handling of a caregiver
 * whose distance we do not know.
 *
 * Fixtures are synthetic. Real feeds carry caregiver and client names, and
 * those do not belong in the repo.
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'availability_core.js'));
const A = globalThis.TributeAvailability;

const html = fs.readFileSync(path.join(root, 'net_surplus.html'), 'utf8');
const src = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/)[1];

const els = {};
const el = id => els[id] || (els[id] = { id, value: '', innerHTML: '', textContent: '',
  style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {} });
const ctx = {
  console, Date, Math, JSON, Set, Array, String, Number, Object, Boolean,
  isFinite, isNaN, parseInt, parseFloat, Promise, URL: { createObjectURL: () => '' }, Blob: function () {},
  document: { getElementById: el, createElement: () => ({ style: {}, click() {} }) },
  // The debounce is real behaviour; capture the pending callback instead of
  // firing it, so a test can assert nothing was scheduled for a short query.
  setTimeout: (fn, ms) => { ctx._pending = { fn, ms }; return 1; },
  clearTimeout: () => { ctx._pending = null; },
  localStorage: { getItem: () => null, setItem() {} },
  fetch: async () => ({ ok: false, status: 0 })
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.window.TributeAvailability = A;
vm.createContext(ctx);
vm.runInContext(src, ctx, { timeout: 5000 });

let pass = 0, fail = 0;
const t = (n, c) => { c ? pass++ : (fail++, console.log('  FAIL: ' + n)); };

// ── Fixtures ────────────────────────────────────────────────────────────────
// Boston's center is downtown. "near" is a couple of miles out, "far" is well
// past any radius we would use.
const NEAR = 4.2;     // driving miles from downtown Boston
const FAR  = 48.0;

const cg = (id, o) => Object.assign({
  id, name: 'CG ' + id, market: 'Boston', state: 'Massachusetts', status: 'hired',
  availNotes: 'Long Hour Days = M, T, W', tags: '', driveMiles: NEAR
}, o || {});

// Centres and driveMiles both arrive on the feed now, exactly as the server
// sends them, so the page never computes a distance of its own.
const CENTERS = { Boston: { lat: 42.3601, lng: -71.0589, note: 'Downtown Boston' },
                  Baltimore: { lat: 39.2904, lng: -76.6122, note: 'Downtown Baltimore' } };

function seed(caregivers, sets, recur) {
  vm.runInContext(
    'data.supply = ' + JSON.stringify({ caregivers, marketCenters: CENTERS, generatedAt: '2026-10-15T00:00:00Z' }) + ';' +
    'data.sets = ' + JSON.stringify({ bookingSets: sets || [], generatedAt: '2026-10-15T00:00:00Z' }) + ';' +
    'data.recur = ' + JSON.stringify(recur || { recurringDays: {}, timeOffDays: {}, tempUnavail: {} }) + ';' +
    'state.market = "Boston"; state.radius = 25; miles.cg = {}; miles.client = {}; null', ctx);
  vm.runInContext('readDistances(); null', ctx);
  return vm.runInContext('compute("Boston")', ctx);
}

const G = (r, section, zone, bucket, type) => r.grid[section][zone][bucket][type];
const LH = 'Long Hours', ON = 'Overnight';

// ── Who is held out, and why ────────────────────────────────────────────────
{
  const r = seed([
    cg('a'),
    cg('b', { tags: 'prn, MWB' }),                       // PRN: no reliable ongoing availability
    cg('c', { availNotes: '' }),                         // nothing parseable
    cg('d', { status: 'terminated' }),                   // not on the roster
    cg('e', { market: 'Baltimore' })                     // another market
  ], [], { recurringDays: {}, timeOffDays: {}, tempUnavail: {} });
  t('only the one eligible caregiver counts', r.counts.people === 1);
  t('PRN held out and counted', r.counts.prn === 1);
  t('unparseable notes held out and counted', r.counts.noNotes === 1);
  t('three weekday slots from one caregiver', G(r, 'free', 'central', 'Weekday', LH) === 3);
}
{
  // Long temp unavailability hides someone; a short hold does not. Megan
  // Stewart's rule, 2026-08-27 — most holds on file are a week or less.
  const longHold  = { from: '2026-10-01', until: '2026-11-30' };
  const shortHold = { from: '2026-10-20', until: '2026-10-22' };
  const r = seed([cg('a'), cg('b')], [], {
    recurringDays: {}, timeOffDays: {}, tempUnavail: { a: longHold, b: shortHold }
  });
  t('a hold over a week removes the caregiver', r.counts.longTU === 1);
  t('a short hold leaves them in', r.counts.people === 1 && G(r, 'free', 'central', 'Weekday', LH) === 3);
}
{
  // The Analyzer's own busy set. A day already carrying a recurring visit is
  // not spare, and neither is a day with time off booked.
  const r = seed([cg('a')], [], {
    recurringDays: { a: [1, 2] }, timeOffDays: { a: [3] }, tempUnavail: {}
  });
  t('recurring and time-off days both drop out', G(r, 'free', 'central', 'Weekday', LH) === 0);
}

// ── Central, edges, and unknown ─────────────────────────────────────────────
{
  const r = seed([
    cg('near'),
    cg('far', { driveMiles: FAR }),
    cg('nogeo', { driveMiles: null })
  ], [], null);
  t('a nearby caregiver is central', G(r, 'free', 'central', 'Weekday', LH) === 3);
  t('a distant caregiver is edges', G(r, 'free', 'edges', 'Weekday', LH) === 3);
  t('a caregiver with no drive figure is unknown, not edges',
    G(r, 'free', 'unknown', 'Weekday', LH) === 3 && r.counts.unknownZone === 1);
  t('unknown is never folded into edges', G(r, 'free', 'edges', 'Weekday', LH) === 3);
}

// ── Demand, and the subtraction ─────────────────────────────────────────────
{
  const sets = [{
    cid: 'c1', market: 'Boston', state: 'Massachusetts', driveMiles: NEAR,
    dayPattern: {
      Monday: { long: 1, short: 2, overnight: 0, livein: 0, biweekly: false },
      Sunday: { long: 0, short: 0, overnight: 1, livein: 0, biweekly: false }
    }
  }];
  const r = seed([cg('a', { availNotes: 'Long Hour Days = M, T, W; Overnights = Su' })], sets, null);
  t('open long-hours demand lands', G(r, 'open', 'central', 'Weekday', LH) === 1);
  t('open overnight demand lands on Sunday', G(r, 'open', 'central', 'Sunday', ON) === 1);
  t('short hours never enter the model', G(r, 'open', 'central', 'Weekday', ON) === 0);
  // The semicolon fix matters here: without it the Long Hour Days entry is lost
  // and weekday supply silently reads zero.
  t('supply parsed across the semicolon', G(r, 'free', 'central', 'Weekday', LH) === 3);
  t('net weekday day is +2', G(r, 'free', 'central', 'Weekday', LH) - G(r, 'open', 'central', 'Weekday', LH) === 2);
  t('net Sunday night is zero, which is the signal',
    G(r, 'free', 'central', 'Sunday', ON) - G(r, 'open', 'central', 'Sunday', ON) === 0);
}

// ── By address ──────────────────────────────────────────────────────────────
// The address view scopes by DISTANCE alone. Market and state are description.
// A Framingham address draws on four markets and a Bethesda one crosses into
// Virginia, so filtering by either would drop reachable caregivers.
function seedAddress(caregivers, sets, cgMiles, clMiles, recur) {
  vm.runInContext(
    'data.supply = ' + JSON.stringify({ caregivers, marketCenters: CENTERS, generatedAt: '2026-10-15T00:00:00Z' }) + ';' +
    'data.sets = ' + JSON.stringify({ bookingSets: sets || [], marketCenters: CENTERS, generatedAt: '2026-10-15T00:00:00Z' }) + ';' +
    'data.recur = ' + JSON.stringify(recur || { recurringDays: {}, timeOffDays: {}, tempUnavail: {} }) + ';' +
    'addrResult = ' + JSON.stringify({ query: { address: 'x', display: 'x', radius: 25 },
      caregiverMiles: cgMiles, clientMiles: clMiles || {}, stats: {} }) + ';' +
    "state.view = 'address'; null", ctx);
  return vm.runInContext('computeAddress()', ctx);
}
{
  // Four caregivers in three markets and two states; only the three with a
  // mileage are in range. Market and state must not exclude anyone.
  const r = seedAddress([
    cg('a', { market: 'Baltimore', state: 'Maryland' }),
    cg('b', { market: 'Bethesda',  state: 'Maryland' }),
    cg('c', { market: 'Virginia',  state: 'Virginia' }),
    cg('d', { market: 'Boston',    state: 'Massachusetts' })
  ], [], { a: 5, b: 9, c: 18 }, {});
  t('counts everyone in range regardless of market', r.counts.people === 3);
  t('a different state is still counted', !!r.byState.Virginia);
  t('out-of-range caregivers are dropped', !r.byMarket.Boston);
  t('three markets reported as description', Object.keys(r.byMarket).length === 3);
  t('supply totals across markets', r.free.Weekday['Long Hours'] === 9);
}
{
  // The net is the point: nearby vacancies are already chasing these people.
  const sets = [{ cid: 'c1', market: 'Boston', dayPattern: { Sunday: { long: 2 } } },
                { cid: 'c2', market: 'Boston', dayPattern: { Sunday: { long: 1 } } }];
  const r = seedAddress([cg('a', { availNotes: 'Long Hour Days = Su, M' })],
                        sets, { a: 4 }, { c1: 6, c2: 11 });
  t('both nearby vacancies counted', r.counts.sets === 2);
  t('free Sunday slot is 1', r.free.Sunday['Long Hours'] === 1);
  t('demand Sunday is 3', r.open.Sunday['Long Hours'] === 3);
  t('net is negative, so we cannot take it',
    r.free.Sunday['Long Hours'] - r.open.Sunday['Long Hours'] === -2);
}
{
  // A booking set out of range must not reduce the answer.
  const r = seedAddress([cg('a', { availNotes: 'Long Hour Days = M' })],
                        [{ cid: 'far', market: 'Boston', dayPattern: { Monday: { long: 5 } } }],
                        { a: 3 }, {});
  t('a vacancy outside the radius does not compete', r.counts.sets === 0 && r.open.Weekday['Long Hours'] === 0);
}
{
  // Same hold-out rules as the market view.
  const r = seedAddress([cg('a'), cg('p', { tags: 'prn' }), cg('n', { availNotes: '' })],
                        [], { a: 2, p: 3, n: 4 }, {});
  t('PRN and unparseable notes held out by address too',
    r.counts.people === 1 && r.counts.prn === 1 && r.counts.noNotes === 1);
}

// ── Address typeahead ───────────────────────────────────────────────────────
// Each suggestion carries the nearest market and its distance, because a town
// name alone does not say whether we could staff it. Picking one hands over
// coordinates so the capacity lookup skips geocoding.
{
  const SUGS = [
    { address: '1305 Hancock St, Quincy, MA 02169, USA', lat: 42.25, lng: -71.00, near: { market: 'South of Boston', miles: 3 } },
    { address: '657 Hancock St, Quincy, MA 02170, USA',  lat: 42.27, lng: -71.01, near: { market: 'South of Boston', miles: 4 } },
    { address: 'Quincy, MA 02169, USA',                  lat: 42.25, lng: -71.00, near: { market: 'South of Boston', miles: 3 } }
  ];
  const setSugs = () => vm.runInContext('suggItems = ' + JSON.stringify(SUGS) + '; suggIdx = -1; null', ctx);

  setSugs();
  vm.runInContext('drawSuggest(); null', ctx);
  const html = els['sugg'].innerHTML;
  t('every suggestion shows its market and distance',
    (html.match(/mi from South of Boston/g) || []).length === 3);
  t('the address itself is shown', html.indexOf('1305 Hancock St') >= 0);

  // Arrow keys wrap in both directions.
  setSugs();
  const key = k => vm.runInContext("onAddrKey({key:'" + k + "', preventDefault:function(){}}); suggIdx", ctx);
  t('ArrowDown from nothing selects the first', key('ArrowDown') === 0);
  t('ArrowDown advances', key('ArrowDown') === 1);
  t('ArrowUp goes back', key('ArrowUp') === 0);
  t('ArrowUp from the first wraps to the last', key('ArrowUp') === 2);
  t('ArrowDown from the last wraps to the first', key('ArrowDown') === 0);

  // Picking one captures its point and fills the box.
  setSugs();
  vm.runInContext('pickSuggest(1); null', ctx);
  t('picking fills the input with the full address',
    els['addr'].value === '657 Hancock St, Quincy, MA 02170, USA');
  t('picking captures the coordinates so no geocode is needed',
    vm.runInContext('pickedPoint && pickedPoint.lat === 42.27 && pickedPoint.lng === -71.01', ctx));
  t('the list closes after a pick', els['sugg'].hidden === true);

  // Typing again invalidates the captured point: the box no longer matches it.
  vm.runInContext("document.getElementById('addr').value = '657 Hancock St, Quincy, MA 021'; onAddrInput(); null", ctx);
  t('typing clears the captured point', vm.runInContext('pickedPoint === null', ctx));

  // Nothing is sent for a short query; every keystroke past the floor is billed.
  ctx._pending = null;
  vm.runInContext("document.getElementById('addr').value = 'abc'; onAddrInput(); null", ctx);
  t('under four characters schedules no lookup and closes the list',
    els['sugg'].hidden === true && ctx._pending === null && vm.runInContext('suggItems.length', ctx) === 0);
  ctx._pending = null;
  vm.runInContext("document.getElementById('addr').value = '1305 Hancock'; onAddrInput(); null", ctx);
  t('a long enough query is debounced, not sent at once',
    ctx._pending !== null && ctx._pending.ms === 300);

  // An empty result still offers the free-text escape hatch.
  vm.runInContext('suggItems = []; drawSuggest(); null', ctx);
  t('no matches still invites a direct search',
    els['sugg'].innerHTML.indexOf('Press Enter to search it anyway') >= 0);
}

// ── The sign convention ─────────────────────────────────────────────────────
// Galip's sheet writes "Open + Not Working + Starting". Run his own worked
// example that way and it does not reconcile; open has to subtract.
{
  const signs = vm.runInContext('SECTIONS.map(function(s){return s.key+":"+s.sign;}).join(",")', ctx);
  t('open subtracts, the two supply rows add', signs === 'open:-1,free:1,starting:1');
}

console.log((fail ? 'FAIL' : 'PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
