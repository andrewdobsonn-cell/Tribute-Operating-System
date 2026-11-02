/* Medical-restriction rule — assertions against availability_core.js.
 *
 * Run: node tests/restrictions.test.js
 *
 * The Availability Analyzer and Caregiver Utilization must flag the same
 * people. Every test here is a way the cohort went wrong once in August 2026:
 * the leave form matching /injury/, an injury form with no restriction answer
 * counting as restricted, a stale answer counting as current, and a name join
 * that fails on an apostrophe.
 */
const path = require('path');
require(path.join(__dirname, '..', 'availability_core.js'));
const A = globalThis.TributeAvailability;

let pass = 0, fail = 0;
const t = (n, c) => { c ? pass++ : (fail++, console.log('  FAIL: ' + n)); };
const NOW = Date.parse('2026-11-02T12:00:00Z');
const day = d => new Date(NOW - d * 86400000).toISOString();
const Q = 'Is the Caregiver able to meet all physical requirements of their position following this incident?';
const form = (title, ans, ageDays, extra) => ({ title, submittedAt: day(ageDays),
  fields: (ans == null ? [] : [{ q: Q, a: ans }]).concat(extra || []) });

t('leave form titled non-injury is not an injury form', !A.isInjuryForm('Massachusetts HR Absence (leave - non-injury)'));
t('non-work-related injury report is', A.isInjuryForm('Chicago HR Non-Work-Related Injury Report'));
t('work-related injury report is', A.isInjuryForm('HR Work-Related Injury Report'));

t('No within a year = restricted', A.formSaysRestricted(form('x', 'No', 74), NOW));
t('No, lower case with trailing text, still counts', A.formSaysRestricted(form('x', 'no - lifting limit', 10), NOW));
t('Yes = not restricted', !A.formSaysRestricted(form('x', 'Yes', 10), NOW));
t('No older than a year is not trusted', !A.formSaysRestricted(form('x', 'No', 374), NOW));
t('form without the question (work-related) never flags', !A.formSaysRestricted(form('x', null, 10), NOW));
t('a passed return date ends it', A.formEnded(form('x', 'No', 10, [{ q: 'Please list the anticipated return date:', a: day(2) }]), NOW));
t('a future return date does not', !A.formEnded(form('x', 'No', 10, [{ q: 'Please list the anticipated return date:', a: day(-20) }]), NOW));

const rows = [
  { id: 'v1', name: "Rosalind 'Roz' Example", forms: [form('Chicago HR Non-Work-Related Injury Report', 'No', 98)] },
  { id: 'v2', name: 'Yes Answer', forms: [form('Massachusetts HR Non-Work-Related Injury Report', 'Yes', 101)] },
  { id: 'v3', name: 'Leave Form Only', forms: [form('Massachusetts HR Absence (leave - non-injury)', 'No', 5)] },
  { id: 'v4', name: 'Aged Out', forms: [form('HR Non-Work-Related Injury Report', 'No', 374)] },
  { id: 'v5', name: 'Two Forms', forms: [form('HR Non-Work-Related Injury Report', 'No', 60), form('HR Non-Work-Related Injury Report', 'No', 20)] },
];
const m = A.restrictionsFromLeaveRows(rows, NOW);
t('restricted caregiver is in byId', !!m.byId.v1);
t('Yes answer is not', !m.byId.v2);
t('leave form No is not (title guard)', !m.byId.v3);
t('aged-out No is not', !m.byId.v4);
t('newest qualifying form supplies the date', m.byId.v5.date === day(20).slice(0, 10));
t('date is a plain YYYY-MM-DD, never the narrative', /^\d{4}-\d{2}-\d{2}$/.test(m.byId.v1.date) && Object.keys(m.byId.v1).join() === 'date');
t('lookup by Viv id', A.restrictionFor(m, 'v1', '') === m.byId.v1);
t('lookup by name ignores quotes and case', A.restrictionFor(m, null, 'rosalind roz example') === m.byId.v1);
t('unknown caregiver is null', A.restrictionFor(m, 'nope', 'Nobody Here') === null);
t('no maps (feed failed) is null, not a crash', A.restrictionFor(null, 'v1', 'x') === null);

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
