/* Net surplus model — assertions against availability_core.js.
 *
 * Run: node tests/net-surplus.test.js
 *
 * The model subtracts caregiver day-slots from vacant client day-slots. Every
 * test here guards a way that subtraction can read zero while looking fine:
 * the two sides spelling a type differently, a fortnightly commitment counted
 * as a weekly one, a day that is already worked counted as spare, or an
 * unmeasured distance quietly becoming "edges".
 */
const path = require('path');
require(path.join(__dirname, '..', 'availability_core.js'));
const A = globalThis.TributeAvailability;

let pass = 0, fail = 0;
const t = (n, c) => { c ? pass++ : (fail++, console.log('  FAIL: ' + n)); };
const g = (grid, bucket, type) => grid[bucket][type];

// ── The contract between the two sides ──────────────────────────────────────
// parseAvailNotes emits these exact strings; open_booking_sets emits the keys
// they map to. If either side is renamed, every cell silently reads zero
// instead of erroring, so pin both.
t('supply type names match the notes parser',
  A.parseAvailNotes('Long Hours: M, W; Overnight: Sa')
   .every(e => A.LH_TYPES.indexOf(e.type) >= 0 || e.type === 'Short Hours'));
t('demand keys are the booking-set classifier words',
  A.LH_DEMAND_KEY['Long Hours'] === 'long' && A.LH_DEMAND_KEY['Overnight'] === 'overnight');

// ── The semicolon bug (found 2026-10-15, fixed in availability_core.js) ─────
// A day list cannot cross a semicolon, and the pattern used to require the
// NEXT type keyword or end-of-string straight after it. So every entry before
// a semicolon failed to match and vanished without an error. Three caregivers
// on file write their notes this way; all three lost real availability.
{
  const e = A.parseAvailNotes('TS40 Overnights = Su, M, F, Sa; Long Hour Days = W, Th');
  t('a semicolon no longer swallows the entry before it', e.length === 2);
  t('both sides of the semicolon keep their own days',
    e.some(x => x.type === 'Overnight' && x.days.length === 4) &&
    e.some(x => x.type === 'Long Hours' && x.days.join() === '3,4'));
}
// Deliberately NOT fixed: "A and/or B = days" credits only the last type.
// Those days are one slot the caregiver fills one way, so crediting both would
// invent capacity. Six caregivers write it; pin the behaviour so nobody
// "improves" it into double counting.
t('and/or stays one entry, never two',
  A.parseAvailNotes('Overnights and/or Long Hour Days = Su, M, T').length === 1);

// ── Day bucketing ───────────────────────────────────────────────────────────
// Every day of the week stands alone (Andrew, 2026-10-16). Monday to Friday
// used to collapse into one "Weekday" column, which hid the thing the model
// exists to find: being free on Monday does nothing for a Thursday vacancy.
t('seven buckets, Sunday first', A.DAY_BUCKETS.length === 7 && A.DAY_BUCKETS[0] === 'Sunday' && A.DAY_BUCKETS[6] === 'Saturday');
t('Sunday is 0, Saturday is 6, Viv convention', A.dayBucket(0) === 'Sunday' && A.dayBucket(6) === 'Saturday');
t('each midweek day is its own bucket',
  A.dayBucket(1) === 'Monday' && A.dayBucket(3) === 'Wednesday' && A.dayBucket(4) === 'Thursday');
t('no Weekday bucket survives', A.DAY_BUCKETS.indexOf('Weekday') < 0);
t('an out-of-range day is refused, not bucketed', A.dayBucket(7) === null && A.dayBucket(-1) === null);
t('booking sets name their days', A.dowOf('Sunday') === 0 && A.dowOf('Saturday') === 6 && A.dowOf('Wednesday') === 3);
t('caregivers number theirs', A.dowOf(0) === 0 && A.dowOf(6) === 6);

// ── Supply ──────────────────────────────────────────────────────────────────
{
  const e = A.parseAvailNotes('Long Hours: M, W, F; Overnight: Sa, Su');
  const grid = A.supplySlots(e, []);
  t('each named weekday carries its own slot',
    g(grid, 'Monday', 'Long Hours') === 1 && g(grid, 'Wednesday', 'Long Hours') === 1 &&
    g(grid, 'Friday', 'Long Hours') === 1);
  t('days not named stay empty',
    g(grid, 'Tuesday', 'Long Hours') === 0 && g(grid, 'Thursday', 'Long Hours') === 0);
  t('Saturday and Sunday split apart',
    g(grid, 'Saturday', 'Overnight') === 1 && g(grid, 'Sunday', 'Overnight') === 1);
  t('short hours never reach the long-hours grid',
    g(A.supplySlots(A.parseAvailNotes('Short Hours: M, T, W'), []), 'Monday', 'Long Hours') === 0);
}
{
  // Every-other-week. 38 caregivers write it, 34 in Maryland; counting one
  // whole turns a fortnightly caregiver into a weekly one.
  const grid = A.supplySlots(A.parseAvailNotes('Long Hours: e/o Sa, M'), []);
  t('e/o Saturday is half a slot', g(grid, 'Saturday', 'Long Hours') === 0.5);
  t('e/o binds only to the day it precedes', g(grid, 'Monday', 'Long Hours') === 1);
}
{
  // A day already carrying a recurring visit is not spare capacity. This is the
  // Analyzer's own busy set (recurringDays + timeOffDays), not a second rule.
  const e = A.parseAvailNotes('Long Hours: M, W, F');
  const afterBusy = A.supplySlots(e, [1, 3]);
  t('busy days drop out, by day',
    g(afterBusy, 'Monday', 'Long Hours') === 0 && g(afterBusy, 'Wednesday', 'Long Hours') === 0 &&
    g(afterBusy, 'Friday', 'Long Hours') === 1);
  t('busy days accept day names too',
    g(A.supplySlots(e, ['Monday', 'Wednesday']), 'Friday', 'Long Hours') === 1);
}

// ── Demand ──────────────────────────────────────────────────────────────────
{
  const grid = A.demandSlots({
    Monday:   { long: 1, short: 3, overnight: 0, livein: 0, biweekly: false },
    Thursday: { long: 1, short: 0, overnight: 0, livein: 0, biweekly: false },
    Sunday:   { long: 0, short: 0, overnight: 2, livein: 0, biweekly: false }
  });
  t('demand lands on the named days',
    g(grid, 'Monday', 'Long Hours') === 1 && g(grid, 'Thursday', 'Long Hours') === 1 &&
    g(grid, 'Tuesday', 'Long Hours') === 0);
  t('Sunday overnights counted', g(grid, 'Sunday', 'Overnight') === 2);
  t('short hours excluded from demand too', g(grid, 'Monday', 'Overnight') === 0);
  t('live-in is its own product, not long hours',
    g(A.demandSlots({ Monday: { livein: 4 } }), 'Monday', 'Long Hours') === 0);
}
t('a biweekly pattern is half a slot',
  g(A.demandSlots({ Tuesday: { long: 1, biweekly: true } }), 'Tuesday', 'Long Hours') === 0.5);

// ── The subtraction ─────────────────────────────────────────────────────────
{
  // Galip's own worked example, in his units: 4 clients needing 2 weekdays and
  // 1 Sunday against 2 caregivers free 3 weekdays, one of them free Saturday.
  const demand = A.emptyGrid();
  for (let i = 0; i < 4; i++) {
    A.addGrid(demand, A.demandSlots({
      Monday: { long: 1 }, Tuesday: { long: 1 }, Sunday: { long: 1 }
    }));
  }
  const supply = A.emptyGrid();
  A.addGrid(supply, A.supplySlots(A.parseAvailNotes('Long Hours: M, T, W'), []));
  A.addGrid(supply, A.supplySlots(A.parseAvailNotes('Long Hours: M, T, W, Sa'), []));
  // Same totals as the collapsed version, now attributable to a day. Four
  // clients needing Mon and Tue is 4 on Monday and 4 on Tuesday, not 8 lumped
  // into a week -- and a caregiver free Wednesday answers neither.
  t('demand is 4 on Monday, 4 on Tuesday, 4 on Sunday',
    g(demand, 'Monday', 'Long Hours') === 4 && g(demand, 'Tuesday', 'Long Hours') === 4 &&
    g(demand, 'Sunday', 'Long Hours') === 4);
  t('demand totals still sum to the old weekday 8',
    ['Monday','Tuesday','Wednesday','Thursday','Friday']
      .reduce((n, d) => n + g(demand, d, 'Long Hours'), 0) === 8);
  t('supply is 2 on Monday and 1 on Saturday',
    g(supply, 'Monday', 'Long Hours') === 2 && g(supply, 'Saturday', 'Long Hours') === 1);
  t('Wednesday supply answers no Monday or Tuesday demand',
    g(supply, 'Wednesday', 'Long Hours') === 2 && g(demand, 'Wednesday', 'Long Hours') === 0);
  t('net Sunday is the finding: -4 before starters',
    g(supply, 'Sunday', 'Long Hours') - g(demand, 'Sunday', 'Long Hours') === -4);
}

// ── Central vs edges ────────────────────────────────────────────────────────
t('inside the radius is central', A.zoneOf(12, 25) === 'central');
t('the radius itself is central', A.zoneOf(25, 25) === 'central');
t('outside is edges', A.zoneOf(25.1, 25) === 'edges');
t('the radius is adjustable', A.zoneOf(28, 25) === 'edges' && A.zoneOf(28, 30) === 'central');
// An unmeasured caregiver is not a far one. Folding unknown into edges would
// quietly invent surplus out at the edges of every market.
t('no drive figure is unknown, never edges',
  A.zoneOf(null, 25) === 'unknown' && A.zoneOf(undefined, 25) === 'unknown' && A.zoneOf(NaN, 25) === 'unknown');

// ── Market centers are not in this module ──────────────────────────────────
// They live server-side and arrive on the feed, so the page cannot hold a
// copy that drifts from the one distances were measured against. Two copies in
// this repo had already drifted ~7 and ~12 miles apart.
t('the module holds no market centers', A.MARKET_CENTERS === undefined);
t('zoneOf works on a mileage alone, whoever measured it',
  A.zoneOf(10, 25) === 'central' && A.zoneOf(40, 25) === 'edges');
t('haversine is a labelled fallback, not a drive figure',
  A.haversineMiles(42.3601, -71.0589, 42.2793, -71.4162) > 15 &&
  A.haversineMiles(42.3601, -71.0589, 42.2793, -71.4162) < 22 &&
  A.haversineMiles(null, 0, 0, 0) === null);

console.log((fail ? 'FAIL' : 'PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
