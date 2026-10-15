/* availability_core.js — the single source of truth for reading a caregiver's
 * availability out of Viv.
 *
 * These are the parts that are easy to get subtly wrong and expensive to have
 * disagree between pages: the day vocabulary, the every-other-week shorthand,
 * and the rule for what counts as extended time off. The Availability Analyzer
 * and Scheduling Fill both need them, and if they ever fork, the same caregiver
 * reads as available on one page and not on the other — which is precisely the
 * "different answers in different places" complaint the tools exist to fix.
 *
 * Entry assembly stays in each page: the fields a page needs differ, and that
 * part is plain mapping with nothing to get wrong.
 */
(function (root) {
  'use strict';

  var DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var DAY_ABBR = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var TYPES = ['Overnight','Long Hours','Short Hours','Live-In'];

  var DAY_MAP = {'su':0,'sun':0,'sunday':0,'m':1,'mo':1,'mon':1,'monday':1,'t':2,'tu':2,'tue':2,'tues':2,'tuesday':2,'w':3,'we':3,'wed':3,'wednesday':3,'th':4,'thu':4,'thur':4,'thurs':4,'thursday':4,'f':5,'fr':5,'fri':5,'friday':5,'sa':6,'sat':6,'saturday':6};

  // Viv tags arrive as one comma-joined string mixing markets, TS levels, pay
  // type and certifications. Only these two are certifications today, and every
  // caregiver carrying one is in Maryland.
  var CERT_TAGS = ['med-tech','cna'];
  var CERT_LABEL = {'med-tech':'Med-Tech','cna':'CNA'};

  // "more than a week" — Megan Stewart, 2026-08-27. A caregiver is only pulled
  // out of the available list for EXTENDED time off; short absences stay visible
  // with the dates called out.
  var TU_LONG_DAYS = 7;

  function cgTags(cg) {
    return String((cg && cg.tags) || '').split(',')
      .map(function (t) { return t.trim().toLowerCase(); })
      .filter(Boolean);
  }

  function certsOf(cg) {
    return cgTags(cg).filter(function (t) { return CERT_TAGS.indexOf(t) >= 0; });
  }

  function isPRN(cg) {
    return cgTags(cg).indexOf('prn') >= 0;
  }

  /* "e/o" is the house shorthand for every-other. It used to be stripped, which
   * made an every-other-Saturday caregiver read as available EVERY Saturday —
   * 38 caregivers write it, 34 of them in Maryland.
   *
   * Scope: e/o binds to the day token that immediately follows it. Where someone
   * means it on more than one day they write it again ("e/o Su, e/o Sa"), so
   * binding it to the whole list would over-apply it. */
  function parseDays(str) {
    var days = new Set(), eo = new Set();
    String(str || '').split(/[,;]+/).forEach(function (seg) {
      var isEO = /\be\/o\b/i.test(seg);
      seg.replace(/e\/o/gi, ' ').split(/\s+/).forEach(function (t) {
        var tl = t.toLowerCase().replace(/[^a-z]/g, '');
        if (DAY_MAP[tl] !== undefined) { days.add(DAY_MAP[tl]); if (isEO) eo.add(DAY_MAP[tl]); }
      });
    });
    return { days: Array.from(days), eoDays: Array.from(eo) };
  }

  /* A note names a type, then the days for it, and may name several.
   *
   * The day list stops at a semicolon, at the next type keyword, or at the end.
   * The semicolon used to be missing from that list, and because the day
   * capture cannot cross one, the whole entry before it failed to match and was
   * dropped in silence -- "Overnights = Su, M, F, Sa; Long Hour Days = W, Th"
   * read as overnights only, losing two long-hour days. Three caregivers on
   * file were written that way (2026-10-15).
   *
   * Note what is NOT fixed here. Six caregivers write "Overnights and/or Long
   * Hour Days = ...", and only the last type is taken. That one is left alone
   * on purpose: those days are ONE slot the caregiver will fill one way, so
   * crediting both types would invent capacity that does not exist.
   */
  function parseAvailNotes(notes) {
    if (!notes) return [];
    var entries = [];
    var typePattern = /((?:TS\d+\s+)?(?:Overnight|Long\s*[Hh]our(?:\s*[Dd]ay)?|Short\s*[Hh]our(?:\s*[Dd]ay)?|Live[\s-]?[Ii]n)s?)[\s:=]+([^;]*?)(?=\s*;|(?:(?:TS\d+\s+)?(?:Overnight|Long\s*[Hh]our|Short\s*[Hh]our|Live[\s-]?[Ii]n))|$)/gi;
    var match;
    while ((match = typePattern.exec(notes)) !== null) {
      var rawType = match[1].trim();
      var rawDays = match[2].trim();
      var type = 'Short Hours';
      var rtl = rawType.toLowerCase();
      if (rtl.indexOf('overnight') >= 0) type = 'Overnight';
      else if (rtl.indexOf('long') >= 0) type = 'Long Hours';
      else if (rtl.indexOf('short') >= 0) type = 'Short Hours';
      else if (rtl.indexOf('live') >= 0) type = 'Live-In';
      var pd = parseDays(rawDays);
      if (pd.days.length > 0) entries.push({ type: type, days: pd.days, eoDays: pd.eoDays });
    }
    if (entries.length === 0) {
      var nl = notes.toLowerCase().trim();
      if (nl === 'live-in' || nl === 'live in') {
        entries.push({ type: 'Live-In', days: [0,1,2,3,4,5,6], eoDays: [] });
      }
    }
    return entries;
  }

  // Inclusive span of a temp-unavailability hold, or null when it cannot be measured.
  function tuSpanDays(tu) {
    if (!tu || !tu.from || !tu.until) return null;
    var a = Date.parse(tu.from + 'T00:00:00Z'), b = Date.parse(tu.until + 'T00:00:00Z');
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000) + 1;
  }

  // A hold we cannot measure stays treated as long: never assume it is short.
  function isLongTU(tu) {
    if (!tu) return false;
    var n = tuSpanDays(tu);
    return n === null ? true : n > TU_LONG_DAYS;
  }

  // True when the caregiver is away on this specific date (any hold, however
  // short). Hiding someone from a list and blocking a date are separate
  // decisions — this is the date one.
  function awayOnDate(tu, dateStr) {
    if (!tu || !dateStr) return false;
    if (tu.from && dateStr >= tu.from && tu.until && dateStr <= tu.until) return true;
    if (!tu.from && tu.until && dateStr <= tu.until) return true;
    return false;
  }

  function dayNames(dows, eoDays) {
    var eo = eoDays || [];
    return (dows || []).map(function (d) {
      return DAY_ABBR[d] + (eo.indexOf(d) >= 0 ? ' (e/o)' : '');
    }).join(', ');
  }

  /* ── Net surplus model (Galip Gencer, 2026-10-14) ──────────────────────────
   *
   * Supply and demand in one unit: DAY-SLOTS PER WEEK. A client pattern
   * needing Tue and Thu is 2 weekday slots; a caregiver free Mon/Wed/Fri is 3.
   * They subtract because this model is long-hours only, where one caregiver
   * covers one visit on a day. It would be wrong for short hours, where one
   * person covers several.
   *
   * The two sides already share a vocabulary and that is not an accident:
   * parseAvailNotes above reads "Long Hours" and "Overnight" off the caregiver,
   * and open_booking_sets classifies each vacant pattern into the same words.
   * Keep them spelled the same or the subtraction silently reads zero.
   */

  var DAY_BUCKETS = ['Weekday', 'Saturday', 'Sunday'];

  // Galip's sheet counts a day as a weekday, a Saturday or a Sunday. The two
  // weekend days stay apart because they behave nothing alike: Sunday is where
  // the surplus collapses and Saturday usually has room.
  function dayBucket(dow) {
    var d = Number(dow);
    if (d === 0) return 'Sunday';
    if (d === 6) return 'Saturday';
    return 'Weekday';
  }

  // Booking sets name their days ('Sunday'...), caregivers number them (0..6).
  function dowOf(day) {
    if (typeof day === 'number') return day;
    var i = DAYS.indexOf(String(day));
    if (i >= 0) return i;
    var m = DAY_MAP[String(day).toLowerCase().replace(/[^a-z]/g, '')];
    return m === undefined ? null : m;
  }

  // Long hours, split day from night. The caregiver's note carries a CATEGORY
  // and never a duration, so the 10-hour cut Galip's sheet asks for cannot be
  // applied to supply at all -- there is no number there to test. Both sides
  // therefore use the booking-set classifier's own thresholds: overnight is 9h+
  // starting in the evening or crossing midnight, long is 5h+ in the day.
  var LH_TYPES = ['Long Hours', 'Overnight'];
  var LH_DEMAND_KEY = { 'Long Hours': 'long', 'Overnight': 'overnight' };

  function emptyGrid() {
    var g = {};
    DAY_BUCKETS.forEach(function (b) {
      g[b] = {};
      LH_TYPES.forEach(function (t) { g[b][t] = 0; });
    });
    return g;
  }

  function addGrid(into, from) {
    DAY_BUCKETS.forEach(function (b) {
      LH_TYPES.forEach(function (t) { into[b][t] += from[b][t]; });
    });
    return into;
  }

  /* Free long-hours day-slots for one caregiver.
   *
   * `entries` is parseAvailNotes output; `busyDows` is the Analyzer's own
   * recurringDays + timeOffDays. Deliberately the Analyzer's definition and not
   * a second one: a day already carrying a recurring visit is not spare
   * capacity, and a day with time off booked is not either.
   *
   * An every-other-week day is half a slot. 38 caregivers write "e/o", 34 of
   * them in Maryland, and counting those whole would invent a weekly caregiver
   * out of a fortnightly one.
   */
  function supplySlots(entries, busyDows) {
    var grid = emptyGrid();
    var busy = {};
    (busyDows || []).forEach(function (d) { busy[dowOf(d)] = true; });
    (entries || []).forEach(function (e) {
      if (LH_TYPES.indexOf(e.type) < 0) return;
      (e.days || []).forEach(function (d) {
        if (busy[d]) return;
        var eo = (e.eoDays || []).indexOf(d) >= 0;
        grid[dayBucket(d)][e.type] += eo ? 0.5 : 1;
      });
    });
    return grid;
  }

  /* Vacant long-hours day-slots for one open booking set.
   *
   * `dayPattern` comes straight off open_booking_sets: per weekday, a count of
   * unassigned patterns by type plus a biweekly flag. Biweekly halves for the
   * same reason e/o does on the supply side.
   */
  function demandSlots(dayPattern) {
    var grid = emptyGrid();
    Object.keys(dayPattern || {}).forEach(function (day) {
      var d = dowOf(day);
      if (d === null) return;
      var p = dayPattern[day] || {};
      var w = p.biweekly ? 0.5 : 1;
      LH_TYPES.forEach(function (t) {
        var n = p[LH_DEMAND_KEY[t]] || 0;
        if (n) grid[dayBucket(d)][t] += n * w;
      });
    });
    return grid;
  }

  /* Market centres are NOT here.
   *
   * They live server-side in vivProxy and ride down on the feeds as
   * `marketCenters`, together with a `driveMiles` already computed for every
   * caregiver and every booking set. Two reasons, and the second is the one
   * that matters.
   *
   * Speed: a page that held its own centres would have to fetch the feeds,
   * work out which distances it needed, and then ask for them -- a second
   * round trip on the critical path before anything can render.
   *
   * Agreement: there were two copies of this table in this repo, in
   * caregiver_supply_map.html and availability_analyzer.html, and they had
   * drifted ~7 and ~12 miles apart. Harmless while the number only sorted a
   * list; not harmless when it decides whether a caregiver is central or
   * edges. One copy, on the server, is the only arrangement that cannot drift.
   * Those two pages still carry their own and should be moved onto the feed.
   */

  var DEFAULT_RADIUS_MILES = 25;

  /* Central or edges, by DRIVING miles from the market center.
   *
   * Andrew, 2026-10-15: driving distance, not straight line. A caregiver 20
   * miles away across a harbor is not 20 minutes away, and the whole point of
   * the bucket is whether somebody can realistically work the case.
   *
   * Returns 'unknown' when we have no drive figure, and 'unknown' must never be
   * folded into 'edges': an unmeasured caregiver is not a far one.
   */
  function zoneOf(driveMiles, radiusMiles) {
    if (driveMiles === null || driveMiles === undefined || isNaN(driveMiles)) return 'unknown';
    return Number(driveMiles) <= (radiusMiles || DEFAULT_RADIUS_MILES) ? 'central' : 'edges';
  }

  // Straight-line miles. Kept only as a labelled fallback for records with
  // coordinates but no drive figure yet -- never silently mixed into a column
  // of driving miles.
  function haversineMiles(lat1, lng1, lat2, lng2) {
    if ([lat1, lng1, lat2, lng2].some(function (v) { return v === null || v === undefined || isNaN(v); })) return null;
    var R = 3958.8, toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
  }

  root.TributeAvailability = {
    DAYS: DAYS, DAY_ABBR: DAY_ABBR, DAY_MAP: DAY_MAP, TYPES: TYPES,
    CERT_TAGS: CERT_TAGS, CERT_LABEL: CERT_LABEL, TU_LONG_DAYS: TU_LONG_DAYS,
    cgTags: cgTags, certsOf: certsOf, isPRN: isPRN,
    parseDays: parseDays, parseAvailNotes: parseAvailNotes,
    tuSpanDays: tuSpanDays, isLongTU: isLongTU, awayOnDate: awayOnDate,
    dayNames: dayNames,
    DAY_BUCKETS: DAY_BUCKETS, LH_TYPES: LH_TYPES, LH_DEMAND_KEY: LH_DEMAND_KEY,
    DEFAULT_RADIUS_MILES: DEFAULT_RADIUS_MILES,
    dayBucket: dayBucket, dowOf: dowOf,
    emptyGrid: emptyGrid, addGrid: addGrid,
    supplySlots: supplySlots, demandSlots: demandSlots,
    zoneOf: zoneOf, haversineMiles: haversineMiles
  };
})(typeof window !== 'undefined' ? window : globalThis);
