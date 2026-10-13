/* ===================================================================
   db.js -- persistence layer + seed data for doOS
   Everything lives in localStorage under STORAGE_KEY. No server,
   no build step -- just open index.html.
=================================================================== */

const STORAGE_KEY = 'doos_data_v1';

const DB = (function () {
  let state = null;
  let onSaveErrorHandler = null;

  // ---------------- rotating local auto-backups (IndexedDB) ----------------
  // localStorage quota is only a few MB per origin -- nowhere near enough
  // to hold multiple full copies of a real multi-year course history on
  // top of the live copy (confirmed by hitting QuotaExceededError on a
  // ~4MB real dataset with just ONE extra localStorage copy). IndexedDB's
  // quota is tied to actual free disk space instead, so snapshots live
  // there, in their own database, separate from the live localStorage
  // data. They still do NOT survive clearing this browser's site data or
  // switching devices -- only an exported JSON file (Settings > Backup)
  // survives that. Snapshots are throttled so normal usage doesn't spam
  // the database with near-duplicate copies, and every failure here is
  // non-fatal and silent to the user: this is a secondary safety net, the
  // primary save to localStorage already succeeded either way.
  const AUTO_BACKUP_DB_NAME = 'doos_backups_db';
  const AUTO_BACKUP_STORE = 'snapshots';
  const AUTO_BACKUP_MAX = 5;
  const AUTO_BACKUP_MIN_INTERVAL_MS = 10 * 60 * 1000;
  let autoBackupDbPromise = null;
  let lastAutoBackupAt = 0;

  function openAutoBackupDb() {
    if (autoBackupDbPromise) return autoBackupDbPromise;
    autoBackupDbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(AUTO_BACKUP_DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(AUTO_BACKUP_STORE, { keyPath: 'at' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return autoBackupDbPromise;
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function pruneAutoBackups(db) {
    const keys = await idbRequest(db.transaction(AUTO_BACKUP_STORE, 'readonly').objectStore(AUTO_BACKUP_STORE).getAllKeys());
    const toDelete = keys.slice().sort((a, b) => a - b).slice(0, Math.max(0, keys.length - AUTO_BACKUP_MAX));
    if (!toDelete.length) return;
    const store = db.transaction(AUTO_BACKUP_STORE, 'readwrite').objectStore(AUTO_BACKUP_STORE);
    toDelete.forEach(k => store.delete(k));
  }

  // Fire-and-forget on purpose -- save() stays synchronous for every
  // existing caller; this runs in the background and never blocks or
  // fails the actual save.
  async function maybeAutoBackup() {
    const now = Date.now();
    if (now - lastAutoBackupAt < AUTO_BACKUP_MIN_INTERVAL_MS) return;
    lastAutoBackupAt = now;
    try {
      const db = await openAutoBackupDb();
      const snapshot = JSON.parse(JSON.stringify(state));
      await idbRequest(db.transaction(AUTO_BACKUP_STORE, 'readwrite').objectStore(AUTO_BACKUP_STORE).put({ at: now, data: snapshot }));
      await pruneAutoBackups(db);
    } catch (e) {
      console.warn('doOS: local auto-backup snapshot failed (non-fatal)', e);
    }
  }

  async function getAutoBackups() {
    try {
      const db = await openAutoBackupDb();
      const all = await idbRequest(db.transaction(AUTO_BACKUP_STORE, 'readonly').objectStore(AUTO_BACKUP_STORE).getAll());
      return all.slice().sort((a, b) => b.at - a.at); // newest first
    } catch (e) {
      return [];
    }
  }

  async function restoreAutoBackup(at) {
    try {
      const db = await openAutoBackupDb();
      const record = await idbRequest(db.transaction(AUTO_BACKUP_STORE, 'readonly').objectStore(AUTO_BACKUP_STORE).get(at));
      if (!record) return false;
      replaceAll(JSON.parse(JSON.stringify(record.data)));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Used by clearAll() so "Clear all data" is actually final -- without
  // this, an old auto-backup snapshot of the just-wiped data would still
  // sit one Restore click away in Settings.
  async function clearAutoBackups() {
    try {
      const db = await openAutoBackupDb();
      await idbRequest(db.transaction(AUTO_BACKUP_STORE, 'readwrite').objectStore(AUTO_BACKUP_STORE).clear());
    } catch (e) {
      // IndexedDB unavailable, or already empty -- not fatal either way.
    }
  }

  function setSaveErrorHandler(fn) { onSaveErrorHandler = fn; }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // Format a Date object as YYYY-MM-DD using its LOCAL calendar fields.
  // Never use toISOString() for this -- it converts to UTC first, which
  // silently rolls the date forward or back a day depending on the
  // timezone offset and time-of-day (e.g. any evening hour in a
  // UTC-behind zone, or any morning hour in a UTC-ahead zone).
  function ymd(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Students routinely work past midnight, so the "day" doesn't flip
  // over until 4am, not 12am -- anything before 4am still counts as
  // yesterday for scheduling/overdue/recurrence purposes. This is the
  // single source of truth for "what day is it" -- every other file
  // that needs today's date goes through this function (or derives from
  // its return value), so the 4am shift applies everywhere consistently
  // without needing to be re-implemented per call site.
  function todayISO(offsetDays = 0) {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (now.getHours() < 4) d.setDate(d.getDate() - 1);
    d.setDate(d.getDate() + offsetDays);
    return ymd(d);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function weekdayName(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { weekday: 'long' });
  }

  function dayIndex(iso) {
    // 0 = Sunday ... 6 = Saturday, matches JS Date#getDay()
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).getDay();
  }

  function addDaysISO(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    return ymd(dt);
  }

  function isoCompare(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // "HH:MM" -> "HH:MM" duration in decimal hours. Returns 0 if either is missing/invalid.
  function hoursBetween(startTime, endTime) {
    if (!startTime || !endTime) return 0;
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    if ([sh, sm, eh, em].some(Number.isNaN)) return 0;
    const mins = (eh * 60 + em) - (sh * 60 + sm);
    return mins > 0 ? mins / 60 : 0;
  }

  function timeToDecimalHours(hhmm) {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h + m / 60;
  }

  // A startTime/endTime block as 1-2 same-day [start,end) decimal-hour
  // intervals. A block that crosses midnight (end time <= start time,
  // e.g. 22:00-01:00) splits into its pre-midnight [start,24) piece and
  // post-midnight [0,end) piece, instead of `hoursBetween`'s "negative
  // duration -> 0" behavior silently dropping it.
  function blockIntervals(startTime, endTime) {
    const start = timeToDecimalHours(startTime);
    const end = timeToDecimalHours(endTime);
    if (start == null || end == null) return [];
    return end > start ? [[start, end]] : [[start, 24], [0, end]];
  }

  function clipIntervals(intervals, winStart, winEnd) {
    return intervals
      .map(([s, e]) => [Math.max(winStart, s), Math.min(winEnd, e)])
      .filter(([s, e]) => e > s);
  }

  // Collapses overlapping/touching intervals so shared time only counts
  // once -- e.g. two subscribed calendars both reporting a 2-3pm event
  // shouldn't make that hour count double toward "time blocked out".
  function mergeTimeIntervals(intervals) {
    const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
    const merged = [];
    sorted.forEach(([s, e]) => {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    });
    return merged;
  }

  function sumTimeIntervals(intervals) {
    return intervals.reduce((sum, [s, e]) => sum + (e - s), 0);
  }

  // `base` with every bit that overlaps `subtract` carved out -- used so
  // a task block that happens to overlap an immovable calendar event
  // doesn't get counted as blocked time twice (once as the event, once
  // as the task).
  function subtractTimeIntervals(base, subtract) {
    let result = base.map(iv => iv.slice());
    subtract.forEach(([subS, subE]) => {
      const next = [];
      result.forEach(([s, e]) => {
        if (subE <= s || subS >= e) { next.push([s, e]); return; }
        if (subS > s) next.push([s, Math.min(subS, e)]);
        if (subE < e) next.push([Math.max(subE, s), e]);
      });
      result = next.filter(([s, e]) => e > s);
    });
    return result;
  }

  function fmtTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    if (Number.isNaN(h)) return '';
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
  }

  // Normalizes a task title for history matching: lowercase, digits and
  // punctuation stripped, whitespace collapsed. "PSET 3: Trailblazer" and
  // "pset 3 - trailblazer" both become "pset trailblazer". This is just
  // exact-ish repeat-name matching, not fuzzy NLP -- intentionally simple.
  function normalizeTitleKey(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[0-9]/g, '')
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ---------------- blank starting state ----------------
  // A brand new browser with nothing in it yet gets a small set of example
  // data instead of a blank slate (see js/sample-seed-data.js) -- once you
  // add your own term/courses/tasks (or clear everything), it's gone for
  // good; this never re-injects itself over real content.
  function buildEmptyState() {
    return {
      quarters: [],
      courses: [],
      tasks: [],
      taskHistory: [], // append-only log of completed tasks, for duration estimation -- survives even if the task itself is later deleted
      calendars: [],   // imported/subscribed .ics calendars -- [{id, name, color, source, url, enabled}]
      habits: [],      // simple yes/no daily habit tracking, deliberately separate from the task system -- see mkHabit
      settings: {
        theme: 'light', capacityHoursPerWeek: 30, pomodoroFocusMinutes: 25, pomodoroBreakMinutes: 5,
        pomodoroDesktopNotify: false,
        // Opt-in AI integration (BYOK) -- the one deliberate exception to
        // doOS staying fully local. null until the user sets a provider +
        // key in Settings; see js/ai.js.
        ai: null,
        // Opt-in Canvas integration (BYOK: your institution's Canvas URL +
        // your own personal access token) -- see js/canvas.js. null until
        // configured in Settings.
        canvas: null,
      },
      // The one global clock-in session, or null when nothing is running. Shape:
      // { taskId, timeLogEntryId, startedAt, pomodoroPhase: 'focus'|'break',
      //   pomodoroPhaseStartedAt, pomodoroFocusMinutes, pomodoroBreakMinutes }
      activeSession: null,
    };
  }

  const HISTORY_LIMIT = 500;

  // Only logs a history entry when real clocked time backs it up
  // (task.timeLog has at least one entry) -- a task marked Done with no
  // time log, whatever actualHours shows (0, blank, or a hand-typed
  // after-the-fact guess), tells us nothing real about how long it took
  // and would otherwise quietly poison every future estimate/accuracy
  // prediction that treats this history as measured ground truth.
  function logTaskCompletion(task) {
    if (!(task.timeLog && task.timeLog.length)) return;
    if (!state.taskHistory.some(h => h.sourceTaskId === task.id)) {
      state.taskHistory.push({
        id: uid('h'),
        sourceTaskId: task.id,
        titleKey: normalizeTitleKey(task.title),
        title: task.title,
        type: task.type,
        courseId: task.courseId || '',
        estHours: task.estHours === '' ? null : parseFloat(task.estHours),
        actualHours: parseFloat(task.actualHours) || 0,
        completedAt: Date.now(),
      });
      if (state.taskHistory.length > HISTORY_LIMIT) {
        state.taskHistory = state.taskHistory.slice(state.taskHistory.length - HISTORY_LIMIT);
      }
    }
  }

  // Fills in fields added after this browser's data was first created, so
  // older saved state never crashes newer rendering code that expects them.
  // Operates on the closure's `state` -- callers must assign state first.
  function migrate() {
    if (!Array.isArray(state.taskHistory)) state.taskHistory = [];
    if (!Array.isArray(state.calendars)) state.calendars = [];
    if (!Array.isArray(state.habits)) state.habits = [];
    state.habits.forEach(h => {
      if (!Array.isArray(h.completions)) h.completions = [];
      if (h.archived === undefined) h.archived = false;
      if (h.goalType === undefined) h.goalType = 'daily';
      if (h.weeklyTarget === undefined) h.weeklyTarget = 3;
    });
    if (state.activeSession === undefined) state.activeSession = null;
    if (!state.settings) state.settings = { theme: 'light', capacityHoursPerWeek: 30 };
    if (state.settings.pomodoroFocusMinutes === undefined) state.settings.pomodoroFocusMinutes = 25;
    if (state.settings.pomodoroBreakMinutes === undefined) state.settings.pomodoroBreakMinutes = 5;
    if (state.settings.pomodoroDesktopNotify === undefined) state.settings.pomodoroDesktopNotify = false;
    if (state.settings.ai === undefined) state.settings.ai = null;
    if (state.settings.canvas === undefined) state.settings.canvas = null;
    if (state.settings.canvas) {
      if (state.settings.canvas.autosync === undefined) state.settings.canvas.autosync = false;
      if (state.settings.canvas.lastSyncAt === undefined) state.settings.canvas.lastSyncAt = null;
      // scheduleLeadDays: new imported assignments get scheduled this many
      // days BEFORE their due date (not on the due date itself), so
      // there's working room before the deadline instead of everything
      // landing on the day it's due.
      if (state.settings.canvas.scheduleLeadDays === undefined) state.settings.canvas.scheduleLeadDays = 2;
      // importUndated: Canvas assignments with no due date at all are
      // mostly placeholder/ungraded entries -- off by default so a sync
      // doesn't flood the Inbox with them unless explicitly opted in.
      if (state.settings.canvas.importUndated === undefined) state.settings.canvas.importUndated = false;
      // importWeeksAhead: caps how far into the future a sync pulls in
      // assignments -- a due date further out than this is left for a
      // later sync instead of cluttering the Inbox with things months away.
      if (state.settings.canvas.importWeeksAhead === undefined) state.settings.canvas.importWeeksAhead = 1;
    }
    (state.courses || []).forEach(c => {
      if (!Array.isArray(c.exams)) c.exams = [];
      if (!Array.isArray(c.meetings)) c.meetings = [];
      c.meetings.forEach(m => { if (m.label === undefined) m.label = ''; });
      if (c.canvasCourseId === undefined) c.canvasCourseId = '';
    });
    (state.tasks || []).forEach(t => {
      if (!Array.isArray(t.subtasks)) t.subtasks = [];
      if (t.startTime === undefined) t.startTime = null;
      if (t.endTime === undefined) t.endTime = null;
      if (t.splitGroupId === undefined) t.splitGroupId = null;
      if (t.splitIndex === undefined) t.splitIndex = null;
      if (t.splitTotal === undefined) t.splitTotal = null;
      if (t.autoplanned === undefined) t.autoplanned = false;
      if (t.calendarId === undefined) t.calendarId = null;
      if (t.canvasAssignmentId === undefined) t.canvasAssignmentId = null;
      if (t.canvasOverrideId === undefined) t.canvasOverrideId = null;
      if (!Array.isArray(t.timeLog)) t.timeLog = [];
    });
    // Backfill history from Done tasks that predate the history log existing,
    // so upgrading doesn't throw away duration data already sitting in tasks.
    const known = new Set(state.taskHistory.map(h => h.sourceTaskId));
    state.tasks.forEach(t => {
      if (t.status === 'Done' && !t.isTemplate && !known.has(t.id) && parseFloat(t.actualHours) > 0) {
        logTaskCompletion(t);
      }
    });
  }

  function mkTask(partial) {
    return Object.assign({
      id: uid('t'),
      title: 'Untitled Task',
      type: 'ToDo',
      courseId: '',
      dueDate: null,
      scheduledDate: null,
      // For type 'Study/Review/Practice' this is a flexible time GOAL the
      // student sets for themselves ("2h of review"), not a prediction of
      // total completion time -- see js/ui.js's isGoalBasedType(), which
      // every estimate/capacity/accuracy engine checks before treating
      // this field as a hard commitment. Every other type keeps the
      // original "estimate" meaning.
      estHours: '',
      actualHours: 0,
      energy: 'medium',
      needHelp: false,
      status: 'To Do',
      priority: 'Medium',
      notes: '',
      recurrence: null,
      isTemplate: false,
      seriesId: null,
      startTime: null,     // "HH:MM" -- set => this is a fixed calendar block (class/lecture), not a flexible task
      endTime: null,
      splitGroupId: null,  // shared id across all chunks of a task the planner split across days
      splitIndex: null,    // 1-based position within its split group
      splitTotal: null,    // total chunk count in its split group
      autoplanned: false,  // true if Smart Plan (not the user) chose this task's scheduledDate
      subtasks: [],        // [{id, title, done}]
      calendarId: null,    // set when this task came from an imported/subscribed .ics calendar
      canvasAssignmentId: null, // set when this task came from a Canvas sync -- see js/canvas.js; lets re-sync update instead of duplicate
      canvasOverrideId: null,   // Canvas Planner Override id, once one exists for this assignment -- lets completion push PUT instead of re-POSTing a duplicate override
      timeLog: [],         // [{id, startedAt (ms), endedAt (ms|null), minutes (set only once ended)}]
      createdAt: Date.now(),
    }, partial);
  }

  function mkCourse(partial) {
    return Object.assign({
      id: uid('c'),
      name: 'Untitled Course',
      type: 'Academic Class',
      code: '',
      units: 0,
      location: '',
      instructor: '',
      targetGrade: '',
      quarterId: '',
      status: 'Active',
      color: '#8b5cf6',
      exams: [], // [{id, name, type: 'Midterm'|'Final'|'Quiz', date}]
      // Recurring weekly meeting times (lecture, section, rehearsal, shift,
      // whatever this course/category actually meets for) -- the one source
      // of truth for "is this a class today", used by the Dashboard's class
      // count and workload hours instead of guessing from scheduled tasks.
      meetings: [], // [{id, daysOfWeek: [1=Mon..6=Sat, 0=Sun], startTime: 'HH:MM', endTime: 'HH:MM'}]
      canvasCourseId: '', // set when this course is mapped to a Canvas course -- see js/canvas.js
    }, partial);
  }

  function mkCalendar(partial) {
    return Object.assign({
      id: uid('cal'),
      name: 'Imported Calendar',
      color: '#3b82f6',
      source: 'file', // 'file' | 'url'
      url: null,
      enabled: true,
      importedAt: Date.now(),
    }, partial);
  }

  // Deliberately separate from the task system -- a habit is just "did
  // you do this today, yes or no," tracked as a plain list of the dates
  // it was done. goalType 'daily' means every day counts on its own;
  // 'weekly' means hitting weeklyTarget completions anywhere within a
  // Mon-Sun week counts as that week being met -- the per-day data is the
  // same either way, only the streak/graph logic (js/habits.js) reads it
  // differently.
  function mkHabit(partial) {
    return Object.assign({
      id: uid('hb'),
      name: 'New Habit',
      goalType: 'daily', // 'daily' | 'weekly'
      weeklyTarget: 3,   // only meaningful when goalType === 'weekly'
      color: '#8b5cf6',
      archived: false,
      createdAt: Date.now(),
      completions: [],   // ['YYYY-MM-DD', ...], unsorted, no duplicates
    }, partial);
  }

  // The one place that decides whether a task is currently visible --
  // used by every render function AND the planner, so toggling a calendar
  // off hides its events everywhere at once instead of view-by-view.
  function visibleTasks(s) {
    const disabled = new Set((s.calendars || []).filter(c => !c.enabled).map(c => c.id));
    return s.tasks.filter(t => !(t.calendarId && disabled.has(t.calendarId)));
  }

  // The one source of truth for "is this course actually meeting on this
  // date" -- a course's weekly meeting schedule (set on its edit screen),
  // matched against that date's day of week. Used by the Dashboard's class
  // count and workload hours instead of inferring "class" from whatever
  // happens to have a start time on a scheduled task (which is also true
  // of a task you dragged onto a time slot yourself, or an imported
  // calendar event -- neither of those is "a class").
  function classMeetingsOn(s, dateIso) {
    const dow = dayIndex(dateIso);
    const out = [];
    (s.courses || []).forEach(c => {
      if (c.status !== 'Active') return;
      (c.meetings || []).forEach(m => {
        if ((m.daysOfWeek || []).includes(dow)) out.push({ course: c, meeting: m });
      });
    });
    return out.sort((a, b) => (a.meeting.startTime || '').localeCompare(b.meeting.startTime || ''));
  }

  // Synthetic, read-only "task-shaped" blocks for each course meeting on
  // this date -- NOT real tasks (never added to state.tasks, never
  // persisted), just a convenient shape so the existing fixed-time
  // rendering (Calendar Day/Week/Month views) and scheduling math
  // (Planner's free-hours calc) can treat a class meeting the same way
  // they already treat an immovable task/calendar event, without
  // duplicating that logic. `isScheduleBlock` marks these so callers can
  // route clicks to the course editor instead of a (nonexistent) task,
  // and treat them as immovable the same way a calendarId event is.
  function classMeetingBlocksOn(s, dateIso) {
    return classMeetingsOn(s, dateIso).map(({ course, meeting }) => ({
      id: `scb_${course.id}_${meeting.id}_${dateIso}`,
      title: course.name,
      type: 'Class',
      courseId: course.id,
      scheduledDate: dateIso,
      startTime: meeting.startTime,
      endTime: meeting.endTime,
      status: 'To Do',
      priority: 'Medium',
      isTemplate: false,
      isScheduleBlock: true,
      meetingLabel: meeting.label || '',
    }));
  }

  // Synthetic, read-only blocks for every exam landing on this date --
  // same spirit as classMeetingBlocksOn (not real tasks, never persisted,
  // click routes to the course editor where exams are actually managed),
  // so exams show up on the Calendar the same way a class does. Exams
  // only ever carry a date, never a time, so startTime/endTime stay null
  // -- callers that render a timed hour-grid block skip these and show
  // them in an all-day/no-time lane instead (see isExamBlock in js/ui.js).
  function examBlocksOn(s, dateIso) {
    const out = [];
    (s.courses || []).forEach(c => {
      (c.exams || []).forEach(e => {
        if (e.date !== dateIso) return;
        out.push({
          id: `exb_${c.id}_${e.id}_${dateIso}`,
          title: e.name || e.type || 'Exam',
          type: 'Exam/Quiz',
          courseId: c.id,
          scheduledDate: dateIso,
          startTime: null,
          endTime: null,
          status: 'To Do',
          priority: 'High',
          isTemplate: false,
          isExamBlock: true,
          examType: e.type || '',
        });
      });
    });
    return out;
  }

  // ---------------- load / save ----------------
  const SAMPLE_SEED_FLAG = 'doos_sample_seed_done';

  // One-time, automatic: if this browser's doOS has never held any real
  // content (no quarters/courses/tasks) and a SAMPLE_SEED_DATA bundle is
  // present (js/sample-seed-data.js), load it instead of staying blank --
  // no manual Restore-from-Backup click needed. Runs at most once ever,
  // tracked by its own flag, so a later "Clear all data" stays a real clear
  // (it won't silently repopulate itself).
  function maybeBootstrapSampleSeed() {
    if (localStorage.getItem(SAMPLE_SEED_FLAG)) return;
    localStorage.setItem(SAMPLE_SEED_FLAG, '1');
    if (typeof SAMPLE_SEED_DATA === 'undefined') return;
    const isBlank = state.quarters.length === 0 && state.courses.length === 0 && state.tasks.length === 0;
    if (!isBlank) return; // don't clobber anything the user already entered themselves
    state = JSON.parse(JSON.stringify(SAMPLE_SEED_DATA)); // clone -- never mutate the embedded const
    migrate();
    save();
  }

  // ---------------- Tauri-backed durability (desktop build only) ----------------
  // Everything above still works exactly as a plain static site -- this
  // section only activates when actually running inside the Tauri shell,
  // and never changes load()/save()'s own behavior or signature. Inside
  // Tauri, WKWebView's localStorage is still real but is disk-pressure
  // evictable and already near its quota on a real multi-year dataset
  // (see maybeAutoBackup's comment above) -- a plain JSON file via
  // tauri-plugin-store is the durable copy. localStorage stays the fast,
  // always-synchronous *working* copy the rest of this app already
  // assumes everywhere (every call site treats save()/get() as sync).
  const TAURI_STORE_FILE = 'doos-data.json';
  const TAURI_STATE_KEY = 'state';
  let tauriStorePromise = null;

  function isTauriEnv() {
    if (typeof window === 'undefined') return false;
    if (typeof window.isTauri === 'function') return window.isTauri();
    return !!window.__TAURI_INTERNALS__;
  }

  // Tauri's injected globals can land a few milliseconds after
  // DOMContentLoaded fires (confirmed empirically: checking isTauriEnv()
  // synchronously at startup sometimes reads false even inside the
  // desktop build, silently skipping hydration for that launch). Poll
  // briefly rather than checking once. Resolves almost instantly either
  // way in a plain browser (isTauriEnv() never becomes true there).
  function waitForTauriEnv(timeoutMs = 2000) {
    return new Promise(resolve => {
      const start = Date.now();
      (function poll() {
        if (isTauriEnv()) { resolve(true); return; }
        if (Date.now() - start >= timeoutMs) { resolve(false); return; }
        setTimeout(poll, 20);
      })();
    });
  }

  function getTauriStore() {
    if (!tauriStorePromise) {
      tauriStorePromise = window.__TAURI__.store.load(TAURI_STORE_FILE, { autoSave: false });
    }
    return tauriStorePromise;
  }

  // Holds the durable copy in memory when it's too large for localStorage
  // (see below) -- load() checks this first, once, before falling back
  // to its normal localStorage read.
  let tauriHydratedState = null;

  // Called once, before the first load(), ONLY when running inside Tauri:
  // pulls the durable on-disk copy so the existing synchronous load()
  // reads the right thing without itself becoming async. A no-op
  // (resolves quickly) in a plain browser.
  async function hydrateFromTauri() {
    const inTauri = await waitForTauriEnv();
    if (!inTauri) return;
    try {
      const store = await getTauriStore();
      const saved = await store.get(TAURI_STATE_KEY);
      if (!saved) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      } catch (e) {
        // Confirmed by testing against the real ~7MB dataset: WKWebView's
        // localStorage has the same ~5MB-per-origin ceiling as any
        // browser (this is exactly the problem tauri-plugin-store was
        // brought in to get away from), so mirroring a large hydrated
        // blob into localStorage can itself throw QuotaExceededError.
        // The file read above has no such limit -- just hand the object
        // to load() directly instead of round-tripping it through
        // localStorage.
        tauriHydratedState = saved;
      }
    } catch (e) {
      console.warn('doOS: could not read Tauri-stored data, falling back to local cache', e);
    }
  }

  // Fire-and-forget on purpose, same pattern as maybeAutoBackup -- save()
  // stays synchronous for every existing caller (drag-and-drop handlers,
  // autosave-on-modal-close, etc. all expect this), this just mirrors the
  // already-saved state out to the durable file in the background.
  function persistToTauriIfNeeded() {
    if (!isTauriEnv()) return;
    getTauriStore()
      .then(store => store.set(TAURI_STATE_KEY, JSON.parse(JSON.stringify(state))).then(() => store.save()))
      .catch(e => console.warn('doOS: Tauri file persist failed (localStorage copy is still current)', e));
  }

  function load() {
    if (tauriHydratedState) {
      // Too large for localStorage -- hydrateFromTauri() handed it to us
      // directly instead (see its comment). The SAMPLE_SEED_FLAG check
      // inside maybeBootstrapSampleSeed still reads localStorage, which
      // is fine -- that flag alone is tiny and never hits the quota.
      state = tauriHydratedState;
      tauriHydratedState = null;
      migrate();
      maybeBootstrapSampleSeed();
      return state;
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        state = JSON.parse(raw);
        migrate();
        maybeBootstrapSampleSeed();
        return state;
      } catch (e) {
        console.warn('Corrupt doOS data, starting fresh.', e);
      }
    }
    state = buildEmptyState();
    save();
    maybeBootstrapSampleSeed();
    return state;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // localStorage can throw (quota exceeded, private-browsing lockdown,
      // storage disabled). Inside Tauri this is non-fatal and expected
      // once a dataset outgrows localStorage's ~5MB ceiling (confirmed by
      // testing against the real ~7MB dataset) -- persistToTauriIfNeeded()
      // below writes the actual durable copy to a real file with no such
      // limit, so don't alarm the user over the mirror failing. Outside
      // Tauri, localStorage IS the only durable copy, so a failure here
      // really does mean the change may be lost -- surface it.
      if (isTauriEnv()) {
        console.warn('doOS: localStorage mirror skipped (over quota) -- relying on the Tauri-persisted file instead', e);
      } else {
        console.error('doOS: local save failed -- this change may be lost on reload', e);
        if (onSaveErrorHandler) onSaveErrorHandler(e);
        return false;
      }
    }
    maybeAutoBackup();
    persistToTauriIfNeeded();
    return true;
  }

  function get() { return state; }

  // Wipes every term/course/task/habit/calendar -- the student's own
  // settings (theme, capacity, pomodoro, and their own AI/Canvas BYOK
  // credentials) are deliberately preserved, since this is meant as
  // "start my academic data over," not "make me re-enter my API keys
  // and Canvas token too." Also clears the local IndexedDB auto-backup
  // snapshots (fire-and-forget, same convention as maybeAutoBackup) so
  // this is actually final -- otherwise an old snapshot of exactly what
  // was just wiped would still sit one Restore click away.
  function clearAll() {
    const keepSettings = state.settings;
    state = buildEmptyState();
    state.settings = keepSettings;
    save();
    clearAutoBackups();
    return state;
  }

  function replaceAll(newState) {
    state = newState;
    migrate();
    save();
  }

  // ---------------- generic CRUD ----------------
  function upsertTask(task) {
    if (!task.id) task.id = uid('t');
    const idx = state.tasks.findIndex(t => t.id === task.id);
    const wasDone = idx >= 0 && state.tasks[idx].status === 'Done';
    if (idx >= 0) state.tasks[idx] = task; else state.tasks.push(task);
    if (task.status === 'Done' && !wasDone && !task.isTemplate) logTaskCompletion(task);
    save();
    return task;
  }
  function deleteTask(id) {
    state.tasks = state.tasks.filter(t => t.id !== id && t.seriesId !== id); // also drop its generated instances
    save();
  }

  // Deletes one recurring occurrence AND every later-dated occurrence in
  // the same series, and caps the template's recurrence so it never
  // generates anything from this date onward again -- earlier (already
  // past) occurrences are left untouched. Used for the "this and every
  // future occurrence" choice (see js/main.js's resolveRecurrenceAction);
  // "just this occurrence" is a plain deleteTask(instanceId) instead.
  function deleteSeriesFrom(instanceId) {
    const instance = state.tasks.find(t => t.id === instanceId);
    if (!instance || !instance.seriesId) return;
    const cutoff = instance.dueDate;
    const tpl = state.tasks.find(t => t.id === instance.seriesId);
    state.tasks = state.tasks.filter(t => {
      if (t.id === instanceId) return false;
      if (t.seriesId === instance.seriesId && cutoff && t.dueDate && isoCompare(t.dueDate, cutoff) >= 0) return false;
      return true;
    });
    capRecurrenceEndDate(tpl, cutoff);
    save();
  }

  // Same scope as deleteSeriesFrom, but cancels instead of removing --
  // keeps every record (this and every future occurrence) rather than
  // deleting it, matching Cancel's "instead of delete, it keeps it but
  // cancels" rule everywhere else in this app.
  function cancelSeriesFrom(instanceId) {
    const instance = state.tasks.find(t => t.id === instanceId);
    if (!instance || !instance.seriesId) return;
    const cutoff = instance.dueDate;
    const tpl = state.tasks.find(t => t.id === instance.seriesId);
    state.tasks.forEach(t => {
      if (t.id === instanceId || (t.seriesId === instance.seriesId && cutoff && t.dueDate && isoCompare(t.dueDate, cutoff) >= 0)) {
        t.status = 'Cancelled';
      }
    });
    capRecurrenceEndDate(tpl, cutoff);
    save();
  }

  function capRecurrenceEndDate(tpl, cutoff) {
    if (!tpl || !tpl.recurrence || !cutoff) return;
    const dayBefore = addDaysISO(cutoff, -1);
    if (!tpl.recurrence.endDate || isoCompare(dayBefore, tpl.recurrence.endDate) < 0) {
      tpl.recurrence.endDate = dayBefore;
    }
  }

  function upsertCourse(course) {
    if (!course.id) course.id = uid('c');
    const idx = state.courses.findIndex(c => c.id === course.id);
    if (idx >= 0) state.courses[idx] = course; else state.courses.push(course);
    save();
    return course;
  }
  function deleteCourse(id) {
    state.courses = state.courses.filter(c => c.id !== id);
    save();
  }
  function upsertQuarter(q) {
    if (!q.id) q.id = uid('q');
    const idx = state.quarters.findIndex(x => x.id === q.id);
    if (idx >= 0) state.quarters[idx] = q; else state.quarters.push(q);
    save();
    return q;
  }
  function deleteQuarter(id) {
    state.quarters = state.quarters.filter(q => q.id !== id);
    save();
  }
  function upsertCalendar(cal) {
    if (!cal.id) cal.id = uid('cal');
    const idx = state.calendars.findIndex(c => c.id === cal.id);
    if (idx >= 0) state.calendars[idx] = cal; else state.calendars.push(cal);
    save();
    return cal;
  }
  function deleteCalendar(id) {
    state.calendars = state.calendars.filter(c => c.id !== id);
    state.tasks = state.tasks.filter(t => t.calendarId !== id); // its imported events go with it
    save();
  }
  // Removes every task previously imported from this calendar, without
  // touching the calendar record itself -- used before a refresh re-syncs.
  function clearCalendarEvents(id) {
    state.tasks = state.tasks.filter(t => t.calendarId !== id);
    save();
  }

  function upsertHabit(habit) {
    if (!habit.id) habit.id = uid('hb');
    const idx = state.habits.findIndex(h => h.id === habit.id);
    if (idx >= 0) state.habits[idx] = habit; else state.habits.push(habit);
    save();
    return habit;
  }
  function deleteHabit(id) {
    state.habits = state.habits.filter(h => h.id !== id);
    save();
  }
  // Toggles one day on/off for a habit -- the only mutation its daily
  // check-in UI and its heatmap cells both ever need.
  function toggleHabitCompletion(habitId, dateIso) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return null;
    const idx = habit.completions.indexOf(dateIso);
    if (idx >= 0) habit.completions.splice(idx, 1);
    else habit.completions.push(dateIso);
    save();
    return habit;
  }

  // ---------------- time tracking / Pomodoro ----------------
  // actualHours is deliberately re-derived from timeLog every time it
  // changes, instead of being hand-entered, so Clock In/Out (and any later
  // edit to a logged entry) automatically feeds real tracked time into the
  // Smart Estimate engine without the student doing anything extra.
  function recomputeActualHours(task) {
    const totalMinutes = (task.timeLog || []).reduce((sum, e) => sum + (parseFloat(e.minutes) || 0), 0);
    task.actualHours = Math.round((totalMinutes / 60) * 100) / 100;
    // taskHistory is normally written once, at the moment status first
    // becomes Done, then frozen -- so tracking/editing time on a task
    // that's already Done (logging forgotten time, fixing a mistaken
    // entry) would otherwise leave the Smart Estimate engine learning
    // from a permanently stale number. Keep the matching record current.
    if (task.status === 'Done') {
      const hist = state.taskHistory.find(h => h.sourceTaskId === task.id);
      if (hist) hist.actualHours = task.actualHours;
    }
    return task.actualHours;
  }

  // Starts the one global session for this task, cleanly clocking out of
  // whatever else was running first (a task can't run two sessions, and
  // doOS never has more than one active session at a time).
  function clockIn(taskId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return null;
    if (state.activeSession) {
      if (state.activeSession.taskId === taskId) return state.activeSession; // already the active task
      clockOut();
    }
    if (!Array.isArray(task.timeLog)) task.timeLog = [];
    const entry = { id: uid('tl'), startedAt: Date.now(), endedAt: null, minutes: null };
    task.timeLog.push(entry);
    const now = Date.now();
    state.activeSession = {
      taskId,
      timeLogEntryId: entry.id,
      startedAt: now,
      pomodoroPhase: 'focus',
      pomodoroPhaseStartedAt: now,
      pomodoroFocusMinutes: state.settings.pomodoroFocusMinutes || 25,
      pomodoroBreakMinutes: state.settings.pomodoroBreakMinutes || 5,
    };
    save();
    return state.activeSession;
  }

  // Ends the active session (if any): closes its timeLog entry, recomputes
  // that task's actualHours from ALL its timeLog entries, and clears
  // activeSession. Pomodoro phase never pauses or alters this -- only
  // Clock Out ends real tracked time.
  function clockOut() {
    const session = state.activeSession;
    if (!session) return null;
    const task = state.tasks.find(t => t.id === session.taskId);
    if (task) {
      const entry = (task.timeLog || []).find(e => e.id === session.timeLogEntryId);
      if (entry && entry.endedAt === null) {
        entry.endedAt = Date.now();
        entry.minutes = Math.round((entry.endedAt - entry.startedAt) / 60000);
      }
      recomputeActualHours(task);
    }
    state.activeSession = null;
    save();
    return task || null;
  }

  // Pure timestamp math, never interval-dependent: fast-forwards the
  // active session's Pomodoro phase through however many focus/break
  // cycles have actually elapsed since pomodoroPhaseStartedAt (covers a
  // page reload, a backgrounded tab, or the clock just being left open).
  // Returns the list of phases flipped INTO, in order, so a caller can
  // toast about the transition(s) -- empty array if nothing changed.
  function syncActiveSessionPhase() {
    const session = state.activeSession;
    if (!session) return [];
    const flips = [];
    let guard = 0;
    while (guard++ < 10000) { // safety valve against a corrupt/zero duration looping forever
      const durMin = session.pomodoroPhase === 'focus'
        ? (session.pomodoroFocusMinutes || 25)
        : (session.pomodoroBreakMinutes || 5);
      const durMs = Math.max(1, durMin) * 60000;
      const elapsed = Date.now() - session.pomodoroPhaseStartedAt;
      if (elapsed < durMs) break;
      session.pomodoroPhaseStartedAt += durMs;
      session.pomodoroPhase = session.pomodoroPhase === 'focus' ? 'break' : 'focus';
      flips.push(session.pomodoroPhase);
    }
    if (flips.length) save();
    return flips;
  }

  // Edits are deliberately immediate (not deferred to a form save) so the
  // same re-derivation path as Clock Out always applies.
  function updateTimeLogEntry(taskId, entryId, minutes) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return null;
    const entry = (task.timeLog || []).find(e => e.id === entryId);
    if (!entry) return null;
    const parsed = parseFloat(minutes);
    entry.minutes = Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
    recomputeActualHours(task);
    save();
    return task;
  }

  function deleteTimeLogEntry(taskId, entryId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return null;
    task.timeLog = (task.timeLog || []).filter(e => e.id !== entryId);
    recomputeActualHours(task);
    save();
    return task;
  }

  // ---------------- batch-change undo ----------------
  // A single-slot undo buffer for a whole-batch operation (Smart Replan,
  // AI Smart Reschedule, bulk AI estimate) -- deliberately NOT wired into
  // every single-task edit (toggling Done, saving the task modal, etc.),
  // since those are easy to fix by hand and undoing them silently would
  // be surprising. Snapshotting the full tasks array (not a diff) is
  // simpler and safer than tracking per-field changes, and cheap enough
  // at this dataset's size. In-memory only (not persisted) -- lost on
  // reload, which is an acceptable tradeoff for a "just made a mistake"
  // safety net, not a durable history feature.
  let lastBatchSnapshot = null;

  // Courses are included too -- AI Add/Edit Task can auto-create a
  // course via findOrCreateCourseByName for a task the student then
  // denies/undoes, and without this it'd survive as an orphan with no
  // tasks pointing at it. Still small/cheap to snapshot alongside tasks.
  function snapshotForUndo(label) {
    lastBatchSnapshot = { label, tasksJSON: JSON.stringify(state.tasks), coursesJSON: JSON.stringify(state.courses), takenAt: Date.now() };
  }

  function undoLastBatch() {
    if (!lastBatchSnapshot) return null;
    const { label, tasksJSON, coursesJSON } = lastBatchSnapshot;
    state.tasks = JSON.parse(tasksJSON);
    if (coursesJSON) state.courses = JSON.parse(coursesJSON);
    lastBatchSnapshot = null;
    save();
    return label;
  }

  return {
    uid, todayISO, fmtDate, weekdayName, dayIndex, addDaysISO, isoCompare, ymd, hoursBetween, fmtTime, normalizeTitleKey,
    timeToDecimalHours, blockIntervals, clipIntervals, mergeTimeIntervals, sumTimeIntervals, subtractTimeIntervals,
    load, save, get, clearAll, replaceAll, mkTask, mkCourse, mkCalendar, mkHabit, visibleTasks, classMeetingsOn, classMeetingBlocksOn, examBlocksOn,
    upsertTask, deleteTask, deleteSeriesFrom, cancelSeriesFrom, upsertCourse, deleteCourse, upsertQuarter, deleteQuarter,
    upsertCalendar, deleteCalendar, clearCalendarEvents,
    upsertHabit, deleteHabit, toggleHabitCompletion,
    setSaveErrorHandler, getAutoBackups, restoreAutoBackup,
    isTauriEnv, hydrateFromTauri,
    clockIn, clockOut, syncActiveSessionPhase, updateTimeLogEntry, deleteTimeLogEntry, recomputeActualHours,
    snapshotForUndo, undoLastBatch,
  };
})();
