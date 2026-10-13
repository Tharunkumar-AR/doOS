/* ===================================================================
   istudiez.js -- client-side parser for iStudiez Pro exports.
   Handles .ics (VEVENT + RRULE -> real doOS recurrence) and loose
   .csv assignment exports. Pure browser JS, no python required.
=================================================================== */

const IStudiez = (function () {
  const BYDAY_MAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  const TYPE_MAP = [
    [/assignment|homework|problem ?set|pset/i, 'PSET'],
    [/lab|prelab|discussion|section/i, 'Lab/Prelab'],
    [/lecture/i, 'Lecture Videos'],
    [/exam|quiz|midterm|final|test/i, 'Exam/Quiz'],
    [/reading|paper|essay/i, 'Reading'],
    [/meeting|club|event/i, 'Club Meeting'],
    [/project|milestone/i, 'Project Milestone'],
    [/habit|routine/i, 'Habit'],
    [/study|review|practice/i, 'Study/Review/Practice'],
  ];

  function guessType(...texts) {
    const hay = texts.join(' ');
    for (const [re, type] of TYPE_MAP) if (re.test(hay)) return type;
    return 'ToDo';
  }

  function unfold(raw) {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    for (const line of lines) {
      if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
        out[out.length - 1] += line.slice(1);
      } else {
        out.push(line);
      }
    }
    return out;
  }

  function icsDateToISO(raw) {
    if (!raw) return null;
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }

  // For a given UTC instant, how many minutes ahead of UTC is `timeZone`'s
  // wall clock right now -- read off via Intl (which ships the full IANA
  // database in every modern browser, so no bundled tz data needed here).
  function tzOffsetMinutes(utcMillis, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const map = {};
    dtf.formatToParts(new Date(utcMillis)).forEach(p => { map[p.type] = p.value; });
    const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
    return (asUTC - utcMillis) / 60000;
  }

  // Given a wall-clock date/time that's meant to represent local time *in
  // `timeZone`* (e.g. the DTSTART;TZID=America/Los_Angeles case), find the
  // actual UTC instant it refers to. Two passes handles DST transitions.
  function zonedWallTimeToUtcDate(y, mo, d, h, mi, s, timeZone) {
    try {
      let utcGuess = Date.UTC(y, mo - 1, d, h, mi, s);
      for (let i = 0; i < 2; i++) {
        utcGuess = Date.UTC(y, mo - 1, d, h, mi, s) - tzOffsetMinutes(utcGuess, timeZone) * 60000;
      }
      return new Date(utcGuess);
    } catch (e) {
      return null; // unrecognized/invalid IANA zone name
    }
  }

  // Parses an ICS date or date-time value into { dateIso, timeHHMM } in
  // *this browser's* local timezone -- the one thing the previous version
  // of this importer got wrong: it took DTSTART/DTEND digits at face value
  // as wall-clock time regardless of a trailing "Z" (UTC) or a TZID param,
  // which silently shifted every imported class/event by the UTC offset
  // whenever the source calendar exported in UTC (common for Google/iCloud
  // exports and iStudiez on some setups). All-day values (no "T" segment)
  // have no timezone concept and pass through unchanged.
  function parseICSDateTime(raw, tzid) {
    if (!raw) return null;
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, z] = m;
    if (h === undefined) return { dateIso: `${y}-${mo}-${d}`, timeHHMM: null };

    let instant = null;
    if (z) {
      instant = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)));
    } else if (tzid) {
      instant = zonedWallTimeToUtcDate(+y, +mo, +d, +h, +mi, +(s || 0), tzid);
    }
    if (!instant) {
      // Floating time (no TZID, no Z) -- most calendar exports use this to
      // mean "the device's own local wall-clock time" already, so no
      // conversion is needed (or possible, for an unrecognized TZID).
      return { dateIso: `${y}-${mo}-${d}`, timeHHMM: `${h}:${mi}` };
    }
    // Read the absolute instant back out in *this* browser's local zone.
    const ly = instant.getFullYear(), lmo = instant.getMonth() + 1, ld = instant.getDate();
    const lh = instant.getHours(), lmi = instant.getMinutes();
    return {
      dateIso: `${ly}-${String(lmo).padStart(2, '0')}-${String(ld).padStart(2, '0')}`,
      timeHHMM: `${String(lh).padStart(2, '0')}:${String(lmi).padStart(2, '0')}`,
    };
  }

  function parseRRule(rr, dtstartISO) {
    if (!rr) return null;
    const parts = {};
    rr.split(';').forEach(p => {
      const [k, v] = p.split('=');
      if (k && v) parts[k.toUpperCase()] = v;
    });
    const freq = parts.FREQ === 'DAILY' ? 'daily' : parts.FREQ === 'WEEKLY' ? 'weekly' : null;
    if (!freq) return null; // MONTHLY/YEARLY not modeled in doOS yet

    const rule = {
      freq,
      interval: parts.INTERVAL ? parseInt(parts.INTERVAL, 10) : 1,
      startDate: dtstartISO,
      endDate: null,
      count: parts.COUNT ? parseInt(parts.COUNT, 10) : null,
      daysOfWeek: null,
    };
    if (parts.UNTIL) rule.endDate = icsDateToISO(parts.UNTIL);
    if (parts.BYDAY) {
      rule.daysOfWeek = parts.BYDAY.split(',').map(d => BYDAY_MAP[d.trim().toUpperCase()]).filter(n => n !== undefined);
    }
    return rule;
  }

  function extractVEvents(text) {
    const lines = unfold(text);
    const events = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
      if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
      if (!cur) continue;
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const keyPart = line.slice(0, idx);
      const value = line.slice(idx + 1);
      const segments = keyPart.split(';');
      const key = segments[0].toUpperCase();
      cur[key] = value;
      // capture DTSTART;TZID=America/Los_Angeles: ... -> cur.DTSTART_TZID
      segments.slice(1).forEach(seg => {
        const eq = seg.indexOf('=');
        if (eq < 0) return;
        if (seg.slice(0, eq).toUpperCase() === 'TZID') cur[key + '_TZID'] = seg.slice(eq + 1);
      });
    }
    return events;
  }

  function parseICS(text) {
    const events = extractVEvents(text);

    return events.map(ev => {
      const title = (ev.SUMMARY || 'Untitled iStudiez Event').trim();
      const category = (ev.CATEGORIES || '').trim();
      const location = (ev.LOCATION || '').trim();
      const description = (ev.DESCRIPTION || '').replace(/\\n/g, ' ').replace(/\\,/g, ',').trim();
      const start = parseICSDateTime(ev.DTSTART, ev.DTSTART_TZID);
      const end = parseICSDateTime(ev.DTEND, ev.DTEND_TZID);
      const dueDate = start ? start.dateIso : null;
      const recurrence = parseRRule(ev.RRULE, dueDate);
      const notesParts = [description, location ? `Location: ${location}` : ''].filter(Boolean);
      const startTime = start ? start.timeHHMM : null;
      const endTime = startTime && end ? end.timeHHMM : null;
      // A timed event with no specific assignment/exam keyword is almost
      // always a lecture/section meeting -- treat it as a fixed Class block
      // rather than guessType's generic ToDo fallback.
      const guessed = guessType(category, title);
      const type = (startTime && guessed === 'ToDo') ? 'Class' : guessed;

      return {
        title,
        type,
        courseName: category || '',
        dueDate,
        scheduledDate: dueDate,
        recurrence,
        notes: notesParts.join(' | '),
        startTime,
        endTime,
        include: true,
      };
    }).filter(r => r.dueDate); // skip undated junk
  }

  // Generic personal-calendar feed parser (Google/Apple/Outlook .ics,
  // or anything standard-shaped) -- deliberately skips the academic
  // keyword guessing in parseICS, since a subscribed personal calendar
  // is not an iStudiez-style assignment list. Timed events become fixed
  // Class blocks; all-day events become plain undated-time ToDo tasks
  // scheduled on that date.
  function parseCalendarICS(text) {
    const events = extractVEvents(text);
    return events.map(ev => {
      const title = (ev.SUMMARY || 'Untitled Event').trim();
      const location = (ev.LOCATION || '').trim();
      const description = (ev.DESCRIPTION || '').replace(/\\n/g, ' ').replace(/\\,/g, ',').trim();
      const start = parseICSDateTime(ev.DTSTART, ev.DTSTART_TZID);
      const end = parseICSDateTime(ev.DTEND, ev.DTEND_TZID);
      const dueDate = start ? start.dateIso : null;
      const recurrence = parseRRule(ev.RRULE, dueDate);
      const startTime = start ? start.timeHHMM : null;
      const endTime = startTime && end ? end.timeHHMM : null;
      const notesParts = [description, location ? `Location: ${location}` : ''].filter(Boolean);
      return {
        title,
        type: startTime ? 'Class' : 'ToDo',
        dueDate,
        scheduledDate: dueDate,
        recurrence,
        notes: notesParts.join(' | '),
        startTime,
        endTime,
      };
    }).filter(r => r.dueDate);
  }

  const CSV_ALIASES = {
    title: ['title', 'name', 'assignment', 'summary', 'task'],
    type: ['type', 'category', 'categories', 'kind'],
    course: ['course', 'class', 'subject'],
    dueDate: ['due date', 'due', 'date', 'deadline'],
    notes: ['notes', 'description', 'details', 'note'],
    priority: ['priority', 'importance'],
    estHours: ['est. hours', 'est hours', 'estimated hours', 'hours', 'duration'],
    status: ['status'],
  };

  function normalizePriority(value) {
    const v = (value || '').trim().toLowerCase();
    if (v.startsWith('h') || v === '1' || v === 'p1') return 'High';
    if (v.startsWith('l')) return 'Low';
    if (v.startsWith('m') || v === '2' || v === 'p2') return 'Medium';
    return '';
  }

  function splitCSVLine(line) {
    // minimal RFC4180-ish split supporting quoted fields with commas
    const out = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else cur += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  function parseAnyDate(value) {
    if (!value) return null;
    value = value.trim();
    let m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      let [, mo, da, yr] = m;
      if (yr.length === 2) yr = `20${yr}`;
      return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
    }
    const d = new Date(value);
    if (!isNaN(d.getTime())) return DB.ymd(d); // local calendar fields, not UTC -- avoids a timezone day-shift
    return null;
  }

  function parseCSV(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim().length);
    if (!lines.length) return [];
    const headers = splitCSVLine(lines[0]).map(h => h.toLowerCase());
    const colIndex = {};
    Object.entries(CSV_ALIASES).forEach(([field, aliases]) => {
      colIndex[field] = -1;
      for (const alias of aliases) {
        const i = headers.indexOf(alias);
        if (i >= 0) { colIndex[field] = i; break; }
      }
    });

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCSVLine(lines[i]);
      const get = (field) => colIndex[field] >= 0 ? (cells[colIndex[field]] || '').trim() : '';
      const title = get('title') || 'Untitled iStudiez Task';
      const dueDate = parseAnyDate(get('dueDate'));
      const estHoursRaw = get('estHours');
      const estHours = estHoursRaw && !isNaN(parseFloat(estHoursRaw)) ? parseFloat(estHoursRaw) : '';
      rows.push({
        title,
        type: guessType(get('type'), title),
        courseName: get('course'),
        dueDate,
        scheduledDate: dueDate,
        recurrence: null,
        notes: get('notes'),
        priority: normalizePriority(get('priority')),
        estHours,
        status: get('status'),
        include: true,
      });
    }
    return rows;
  }

  function parse(filename, text) {
    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'ics') return parseICS(text);
    if (ext === 'csv') return parseCSV(text);
    throw new Error('Unsupported file type: ' + ext);
  }

  return { parse, parseICS, parseCSV, parseCalendarICS, guessType };
})();
