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

  function parseAvailNotes(notes) {
    if (!notes) return [];
    var entries = [];
    var typePattern = /((?:TS\d+\s+)?(?:Overnight|Long\s*[Hh]our(?:\s*[Dd]ay)?|Short\s*[Hh]our(?:\s*[Dd]ay)?|Live[\s-]?[Ii]n)s?)[\s:=]+([^;]*?)(?=(?:(?:TS\d+\s+)?(?:Overnight|Long\s*[Hh]our|Short\s*[Hh]our|Live[\s-]?[Ii]n))|$)/gi;
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

  root.TributeAvailability = {
    DAYS: DAYS, DAY_ABBR: DAY_ABBR, DAY_MAP: DAY_MAP, TYPES: TYPES,
    CERT_TAGS: CERT_TAGS, CERT_LABEL: CERT_LABEL, TU_LONG_DAYS: TU_LONG_DAYS,
    cgTags: cgTags, certsOf: certsOf, isPRN: isPRN,
    parseDays: parseDays, parseAvailNotes: parseAvailNotes,
    tuSpanDays: tuSpanDays, isLongTU: isLongTU, awayOnDate: awayOnDate,
    dayNames: dayNames
  };
})(typeof window !== 'undefined' ? window : globalThis);
