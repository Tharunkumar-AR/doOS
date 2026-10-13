/* ===================================================================
   ui.js -- rendering for every view. Reads fresh from DB.get() each
   call so it always reflects the latest saved state.
=================================================================== */

const TASK_TYPES = ['PSET', 'Lab/Prelab', 'Exam/Quiz', 'Reading', 'Lecture Videos', 'Club Meeting', 'Project Milestone', 'Study/Review/Practice', 'Habit', 'Class', 'ToDo', 'Personal Task'];
const STATUS_OPTIONS = ['Backlog', 'To Do', 'In Progress', 'Waiting/Blocked', 'Done', 'Cancelled'];
const PRIORITY_OPTIONS = ['High', 'Medium', 'Low'];
const COURSE_TYPES = ['Academic Class', 'Lab/Discussion', 'Extracurricular/Club', 'Campus Job', 'Internship', 'Job', 'Personal/Life Project'];
const EXAM_TYPES = ['Midterm', 'Final', 'Quiz'];
// 10 standardized course colors, offered alongside the native picker so
// courses stay visually consistent instead of every one being a random hue.
const COURSE_COLOR_PRESETS = [
  '#8b5cf6', // violet
  '#6366f1', // indigo
  '#3b82f6', // blue
  '#06b6d4', // cyan
  '#30a46c', // green
  '#84cc16', // lime
  '#f59e0b', // amber
  '#f97316', // orange
  '#e5484d', // red
  '#ec4899', // pink
];
const ENERGY_META = {
  high: { label: '⚡ High Focus', rank: 0 },
  medium: { label: '☕ Medium', rank: 1 },
  low: { label: '😴 Low Energy', rank: 2 },
};
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function el(id) { return document.getElementById(id); }

const STATUS_CLASS_MAP = {
  'Backlog': 'pill-backlog',
  'To Do': 'pill-todo',
  'In Progress': 'pill-inprogress',
  'Waiting/Blocked': 'pill-blocked',
  'Done': 'pill-done',
  'Cancelled': 'pill-cancelled',
};
// Resolved states -- no longer need action, excluded from workload/overdue/
// Smart Plan/AI-estimate math the same way Done already was, but distinct
// from Done visually and in history (cancelling never logs a completion).
function isResolvedStatus(status) {
  return status === 'Done' || status === 'Cancelled';
}

// Study/Review/Practice is the one type whose estHours is a flexible time
// GOAL ("2h of review") rather than a prediction of completion time, and
// is inherently lower-priority, variable-timeframe work -- every AI
// prompt, the local Smart Estimate accuracy engine, and capacity math
// check this before treating estHours as a hard commitment. See the
// comment on estHours in js/db.js's mkTask for the same rule.
function isGoalBasedType(type) {
  return type === 'Study/Review/Practice';
}

// Reschedulability hierarchy -- most protected (graded, hard-deadline
// academic work) first, most freely bumpable (open-ended personal/
// flexible work) last. Used by Smart Replan/AI Smart Reschedule to decide
// what stays put on an overloaded day and what gets pushed out first;
// NOT used for general display sort order (that's PRIORITY_RANK/the
// user's own High/Medium/Low choice, a separate axis). Any type not
// listed falls back to the end (least protected).
const RESCHEDULE_PRIORITY_ORDER = [
  'Exam/Quiz', 'PSET', 'Lab/Prelab', 'Project Milestone', 'Club Meeting',
  'Study/Review/Practice', 'Reading', 'Habit', 'Personal Task', 'ToDo', 'Class',
];
const RESCHEDULE_RANK = {};
RESCHEDULE_PRIORITY_ORDER.forEach((t, i) => { RESCHEDULE_RANK[t] = i; });
function rescheduleRank(type) {
  return RESCHEDULE_RANK[type] !== undefined ? RESCHEDULE_RANK[type] : RESCHEDULE_PRIORITY_ORDER.length;
}

// A same-priority tiebreak that nudges goal-based (Study/Review/Practice)
// tasks slightly later than otherwise-equal-priority deadline-driven work
// -- a goal-based task's own High/Medium/Low choice is still fully
// respected (a High-priority goal task still beats a Medium-priority
// deadline task), this only breaks ties within one priority tier.
function effectivePriorityRank(t) {
  return PRIORITY_RANK[t.priority] + (isGoalBasedType(t.type) ? 0.5 : 0);
}
function statusClass(status) {
  return STATUS_CLASS_MAP[status] || 'pill-backlog';
}

function courseById(id) {
  return DB.get().courses.find(c => c.id === id);
}
function courseName(id) {
  const c = courseById(id);
  return c ? c.name : '— Unlinked —';
}
function courseColor(id) {
  const c = courseById(id);
  return c ? c.color : '#8b8f9e';
}
function courseSwatch(id) {
  return `<span class="swatch" style="background:${courseColor(id)}"></span>`;
}
function priorityMark(priority) {
  if (priority === 'High') return '<span class="pmark pmark-high" title="High priority">!!</span>';
  if (priority === 'Medium') return '<span class="pmark pmark-medium" title="Medium priority">!</span>';
  return '<span class="pmark"></span>';
}
function splitBadge(t) {
  return t.splitTotal && t.splitTotal > 1 ? `<span class="split-badge">Part ${t.splitIndex}/${t.splitTotal}</span>` : '';
}
// Visible marker wherever a task row/card renders, so a Canvas-synced
// assignment is distinguishable at a glance from one you created by hand
// -- not just an internal field (canvasAssignmentId).
function canvasTagHtml(t) {
  return t.canvasAssignmentId ? `<span class="pill pill-xs pill-canvas">🎓 Canvas</span>` : '';
}
const WEEKDAY_SHORT_MON = [1, 2, 3, 4, 5, 6, 0].map(i => WEEKDAY_SHORT[i]);

// Shared by the Dashboard's Today's Agenda overdue section and Smart
// Replan's own candidate search -- a task only counts as "sitting in the
// overdue pile" if nothing has already addressed it. Once Smart Replan
// (or the user, manually) gives it a scheduledDate of today or later,
// it's deliberately deferred/acknowledged, not neglected -- it should
// disappear from the scary "Overdue" pile and show up under Today's (or
// that future day's) own list instead (exactly how the Inbox already
// buckets by scheduledDate-first). The scheduledDate check is strictly
// "<" (not "<="): Smart Replan moves things to TODAY specifically (see
// runSmartReplan), so scheduledDate === today has to already count as
// "addressed" -- with "<=" it would stay stuck in the pile immediately
// after being replanned, and a second click would be a no-op.
function isOverduePileTask(t, today) {
  return !!t.dueDate && DB.isoCompare(t.dueDate, today) < 0 && !isResolvedStatus(t.status) && !t.startTime
    && (!t.scheduledDate || DB.isoCompare(t.scheduledDate, today) < 0);
}

function activeTasks() {
  return DB.visibleTasks(DB.get()).filter(t => !t.isTemplate);
}

function getWeekDates(offsetWeeks) {
  // Derive from DB.todayISO() (not a raw `new Date()`) so this respects
  // the 4am day-boundary shift -- otherwise "this week" could disagree
  // with every other "today"-based view during the 12am-4am window.
  const [ty, tm, td] = DB.todayISO().split('-').map(Number);
  const today = new Date(ty, tm - 1, td);
  const dow = today.getDay(); // 0 Sun .. 6 Sat
  const mondayDiff = (dow + 6) % 7; // days since most recent Monday
  const monday = new Date(today);
  monday.setDate(today.getDate() - mondayDiff + offsetWeeks * 7);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(DB.ymd(d));
  }
  return dates;
}

function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date(DB.todayISO());
  const target = new Date(iso);
  return Math.round((target - today) / 86400000);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Shared by the floating active-session widget, task-row clock controls,
// and the task modal's Time Tracking section. ms -> "MM:SS", or
// "H:MM:SS" once an hour has passed.
function formatElapsedTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Clock In/Out control rendered on every task row -- only one task in the
// whole app can ever be the active session, so every other row always
// shows "Clock In". The elapsed-time span carries data-task-id so the
// ticking interval in main.js can update it live without a full re-render.
function taskClockControlHtml(t) {
  const session = DB.get().activeSession;
  const isActive = session && session.taskId === t.id;
  if (isActive) {
    return `<span class="clock-control">
      <button type="button" class="clock-btn clock-btn-stop" onclick="event.stopPropagation(); clockOutActiveSession()" title="Clock out">⏸ Clock Out</button>
      <span class="clock-elapsed task-clock-elapsed" data-task-id="${t.id}">${formatElapsedTime(Date.now() - session.startedAt)}</span>
    </span>`;
  }
  return `<button type="button" class="clock-btn clock-btn-start" onclick="event.stopPropagation(); clockInToTask('${t.id}')" title="Clock in">▶ Clock In</button>`;
}

function countdownLabel(iso) {
  const d = daysUntil(iso);
  if (d === null) return '';
  if (d < 0) return `${Math.abs(d)}d overdue`;
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  return `in ${d} days`;
}

function subtaskInlineRowHtml(t, s) {
  return `<div class="subtask-inline-row ${s.done ? 'done' : ''}" onclick="event.stopPropagation()">
    <input type="checkbox" class="subtask-inline-check" ${s.done ? 'checked' : ''} onclick="event.stopPropagation(); toggleSubtaskDone('${t.id}', '${s.id}', this.checked)">
    <span class="subtask-inline-title">${escapeHtml(s.title)}</span>
  </div>`;
}

/* ============================================================
   SHARED TASK ROW (used by Dashboard + Inbox)
============================================================ */
// opts.showCheckbox (default true), opts.showCourse (default true), opts.showSubtasks (default true)
function taskRowHtml(t, opts = {}) {
  // An imported calendar event isn't a completable task and isn't
  // draggable/clockable -- it's read-only (see openTaskModal), so none
  // of those controls make sense on its row either.
  const isEvent = !!t.calendarId;
  const showCheckbox = opts.showCheckbox !== false && !isEvent;
  const showCourse = opts.showCourse !== false;
  const showSubtasks = opts.showSubtasks !== false;
  const isFixed = !!(t.startTime && t.endTime);
  const extraBits = [];
  if (isFixed) extraBits.push(`${DB.fmtTime(t.startTime)}–${DB.fmtTime(t.endTime)}`);
  if (t.estHours && !isFixed) extraBits.push(isGoalBasedType(t.type) ? `🎯 ${t.estHours}h goal` : `${t.estHours}h`);
  if (t.splitTotal > 1) extraBits.push(splitBadge(t));
  // subtasks render as their own nested rows below instead of a count badge here
  if (t.status === 'In Progress' || t.status === 'Waiting/Blocked' || t.status === 'Cancelled') extraBits.push(`<span class="pill ${statusClass(t.status)} pill-xs">${t.status}</span>`);
  if (t.needHelp) extraBits.push(`<span class="pill pill-high pill-xs">OH</span>`);
  if (isEvent) extraBits.push(`<span class="pill pill-xs">📅 Event</span>`);
  if (t.canvasAssignmentId) extraBits.push(canvasTagHtml(t));

  const draggable = !!opts.draggable && !isEvent;
  const mainRow = `<div class="trow2 ${draggable ? 'draggable-task' : ''} ${t.status === 'Done' ? 'done' : ''} ${t.status === 'Cancelled' ? 'cancelled' : ''}" data-task-id="${t.id}" onclick="openTaskModal('${t.id}')"
      ${draggable ? `onmousedown="startCalendarTaskDrag(event, '${t.id}')"` : ''}>
    ${showCheckbox ? `<input type="checkbox" class="trow2-check" ${t.status === 'Done' ? 'checked' : ''} onclick="event.stopPropagation(); toggleTaskDone('${t.id}', this.checked)">` : ''}
    ${priorityMark(t.priority)}
    ${courseSwatch(t.courseId)}
    <span class="trow2-title">${escapeHtml(t.title)}</span>
    ${extraBits.length ? `<span class="trow2-extra">${extraBits.join(' · ')}</span>` : ''}
    ${showCourse ? `<span class="trow2-course" style="color:${courseColor(t.courseId)}">${escapeHtml(courseName(t.courseId))}</span>` : ''}
    ${isEvent ? '' : taskClockControlHtml(t)}
  </div>`;

  if (!showSubtasks || !t.subtasks || !t.subtasks.length) return mainRow;
  const subRows = t.subtasks.map(s => subtaskInlineRowHtml(t, s)).join('');
  return `<div class="task-with-subtasks">${mainRow}<div class="subtask-inline-list">${subRows}</div></div>`;
}

// A real class meeting, straight from its course's own weekly schedule --
// not a task, so no checkbox/drag/clock-in; clicking it opens that course
// (where the schedule actually lives) rather than a task modal.
function classMeetingRowHtml({ course, meeting }) {
  return `<div class="trow2" onclick="openCourseModal('${course.id}')">
    ${courseSwatch(course.id)}
    <span class="trow2-title">${escapeHtml(course.name)}</span>
    <span class="trow2-extra">${DB.fmtTime(meeting.startTime)}–${DB.fmtTime(meeting.endTime)}</span>
    <span class="trow2-course" style="color:${courseColor(course.id)}">🎓 Class</span>
  </div>`;
}

/* ============================================================
   DASHBOARD
============================================================ */
// A collapsed-by-default breakdown of exactly which tasks feed the Daily
// Workload card's "Scheduled" total -- the agenda list above hides Done
// tasks to stay a clean to-do list, but Done tasks still count here
// (deliberately, see allFlexToday's comment), so the two numbers can
// legitimately disagree. This makes that gap inspectable instead of
// just trusting the math -- if something looks duplicated or
// unexpected here, that's a real bug; if it's just completed work you
// forgot about, the number was right all along.
function workloadBreakdownHtml(fixedToday, allFlexToday, classesToday) {
  const classRows = classesToday.map(({ course, meeting }) =>
    `<div class="workload-breakdown-row"><span>🏫 ${escapeHtml(course.name)} <span class="hint">(${DB.fmtTime(meeting.startTime)}–${DB.fmtTime(meeting.endTime)})</span></span><span>${DB.hoursBetween(meeting.startTime, meeting.endTime).toFixed(1)}h</span></div>`);
  const fixedRows = fixedToday.filter(t => !t.calendarId && t.status !== 'Cancelled')
    .map(t => `<div class="workload-breakdown-row"><span>${isGoalBasedType(t.type) ? '🎯 ' : ''}${escapeHtml(t.title)} <span class="hint">(${DB.fmtTime(t.startTime)}–${DB.fmtTime(t.endTime)}${t.status === 'Done' ? ', Done' : ''})</span></span><span>${DB.hoursBetween(t.startTime, t.endTime).toFixed(1)}h</span></div>`);
  const flexRows = allFlexToday
    .map(t => `<div class="workload-breakdown-row"><span>${isGoalBasedType(t.type) ? '🎯 ' : ''}${escapeHtml(t.title)}${t.status === 'Done' ? ' <span class="hint">(Done)</span>' : ''}</span><span>${(parseFloat(t.estHours) || 0)}h${isGoalBasedType(t.type) ? ' goal' : ''}</span></div>`);
  const rows = [...classRows, ...fixedRows, ...flexRows];
  if (!rows.length) return '';
  return `<details class="workload-breakdown">
    <summary>Show breakdown (${rows.length} item${rows.length === 1 ? '' : 's'})</summary>
    ${rows.join('')}
  </details>`;
}

let remainingWorkloadRange = 'all'; // 'day' | '3day' | 'week' | 'all' -- see Remaining Workload card

// "Today" runs until 2am the next calendar day, not midnight -- late-night
// work still counts as part of the day it was due, not the next one. If
// it's currently past 2am but before the next 2am, the cutoff is today's
// (already-started) day; otherwise it rolls forward to tomorrow's.
function hoursUntilDayCutoff() {
  const DAY_CUTOFF_HOUR = 2;
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAY_CUTOFF_HOUR, 0, 0, 0);
  if (cutoff <= now) cutoff.setDate(cutoff.getDate() + 1);
  return Math.max(0, (cutoff - now) / 3600000);
}

function renderDashboard() {
  const state = DB.get();
  const today = DB.todayISO();
  const tasks = activeTasks();

  // Built from DB.todayISO() rather than a raw `new Date()` so the
  // header matches everything else on this page during the 12am-4am
  // window (showing "Monday" while every list still behaves as Monday
  // reads as consistent; showing "Tuesday" there would not).
  el('dashDateLine').textContent = (() => {
    const [y, m, d] = today.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  })();
  const activeQ = state.quarters.find(q => q.status === 'Active');
  el('activeTermBadge').textContent = activeQ ? activeQ.name : 'No active term';

  const isEmpty = state.quarters.length === 0 && state.courses.length === 0 && tasks.length === 0;
  el('dashEmptyState').classList.toggle('hidden', !isEmpty);
  el('dashGrid').classList.toggle('hidden', isEmpty);
  if (isEmpty) return;

  // Today's Agenda: overdue first (highest priority -- it's work that's
  // already late), then classes (from each course's own weekly meeting
  // schedule, not guessed from scheduled tasks -- see DB.classMeetingsOn),
  // then flexible tasks sorted by energy then priority. Overdue used to be
  // its own separate Dashboard card; it's folded in here, visually
  // separated by the same day-section-head styling the Inbox already
  // uses, so it's the first thing seen rather than something easy to
  // scroll past.
  const overdue = tasks.filter(t => isOverduePileTask(t, today))
    .sort((a, b) => DB.isoCompare(a.dueDate, b.dueDate));
  const classesToday = DB.classMeetingsOn(state, today);
  const todayTasks = tasks.filter(t => t.scheduledDate === today);
  const fixedToday = todayTasks.filter(t => t.startTime).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const flexToday = todayTasks.filter(t => !t.startTime && !isResolvedStatus(t.status))
    .sort((a, b) => (ENERGY_META[a.energy]?.rank ?? 1) - (ENERGY_META[b.energy]?.rank ?? 1) || effectivePriorityRank(a) - effectivePriorityRank(b));
  const scheduleList = [...fixedToday, ...flexToday];

  let agendaHtml = '';
  if (overdue.length) {
    agendaHtml += `<div class="day-section-head day-section-overdue">Overdue (${overdue.length})</div>`;
    agendaHtml += overdue.map(t => taskRowHtml(t)).join('');
    agendaHtml += `<div class="day-section-head">Today</div>`;
  }
  agendaHtml += classesToday.map(classMeetingRowHtml).join('');
  agendaHtml += scheduleList.length
    ? scheduleList.map(t => taskRowHtml(t)).join('')
    : (classesToday.length ? '' : `<div class="empty-note">Nothing scheduled for today. Add something or enjoy the break ☀️</div>`);
  el('focusList').innerHTML = agendaHtml;

  // Clocked time -- each timeLog entry counts toward whichever calendar
  // day it actually started on (local time), not the task's due/scheduled
  // date. A still-running entry (no endedAt yet) counts its live elapsed
  // time so this stays accurate while a session is active.
  let clockedTodayMinutes = 0;
  tasks.forEach(t => (t.timeLog || []).forEach(entry => {
    const entryDate = DB.ymd(new Date(entry.startedAt));
    const minutes = entry.minutes != null ? entry.minutes
      : Math.round(((entry.endedAt || Date.now()) - entry.startedAt) / 60000);
    if (entryDate === today) clockedTodayMinutes += minutes;
  }));

  // Today at a Glance -- counts only; the hour-based numbers all live in
  // the Daily Workload card below instead, so nothing's shown twice.
  // "classes" comes from classesToday (each course's own weekly meeting
  // schedule), NOT from fixedToday -- fixedToday is any task with a start
  // time, which is just as true of a task you dragged onto a slot
  // yourself or an imported calendar event, neither of which is a class.
  const highPriorityToday = flexToday.filter(t => t.priority === 'High').length;
  el('todayGlance').innerHTML = `
    <div class="glance-stat"><span class="glance-num">${classesToday.length}</span><span class="glance-label">${classesToday.length === 1 ? 'class' : 'classes'}</span></div>
    <div class="glance-stat"><span class="glance-num">${flexToday.length}</span><span class="glance-label">${flexToday.length === 1 ? 'task' : 'tasks'}</span></div>
    ${highPriorityToday ? `<div class="glance-stat glance-warn"><span class="glance-num">${highPriorityToday}</span><span class="glance-label">high priority</span></div>` : ''}
  `;

  // Daily Workload -- everything measured against TODAY, not the week:
  // how much work is scheduled today, how much of that's actually been
  // clocked, and how much real free time is left in a usable work window
  // (8am-10pm; nobody's scheduling study blocks at 3am). "Events" (calendarId
  // set -- imported from an .ics feed) are immovable, so they come out of
  // the window first; your OWN scheduled tasks don't shrink the window the
  // same way since you could always move them -- that's the distinction
  // between "Available" (nothing left at all, events AND tasks subtracted)
  // and the denominator of the % metric (events only, "how much could you
  // physically still fit today if you had to").
  // All flex (non-fixed-time) tasks scheduled today, minus Cancelled
  // (which never happened and frees the slot, same as
  // Planner.flexHoursOnDay) -- the base pool "Scheduled"/"Completed"/the
  // breakdown toggle all draw from, split into regular tasks vs.
  // Study/Review/Practice goals so the two can be color-coded separately
  // instead of study time silently vanishing from every total.
  const allFlexToday = todayTasks.filter(t => !t.startTime && t.status !== 'Cancelled');
  const flexTaskToday = allFlexToday.filter(t => !isGoalBasedType(t.type));
  const flexStudyToday = allFlexToday.filter(t => isGoalBasedType(t.type));
  const taskHoursToday = flexTaskToday.filter(t => t.status !== 'Done').reduce((s, t) => s + (parseFloat(t.estHours) || 0), 0);
  const studyHoursToday = flexStudyToday.filter(t => t.status !== 'Done').reduce((s, t) => s + (parseFloat(t.estHours) || 0), 0);
  const taskHoursCompletedToday = flexTaskToday.filter(t => t.status === 'Done').reduce((s, t) => s + (parseFloat(t.estHours) || 0), 0);
  const studyHoursCompletedToday = flexStudyToday.filter(t => t.status === 'Done').reduce((s, t) => s + (parseFloat(t.estHours) || 0), 0);

  // Fixed-time blocks are converted to decimal-hour intervals, clipped to
  // the work window, and merged before summing -- so two overlapping
  // blocks (two subscribed calendars both reporting a 2-3pm event, or a
  // cross-listed lecture/section at the same time) count that time once,
  // not once per block. "Classes" here means anything immovable: imported
  // calendar events AND today's real class meetings (classesToday).
  const nowDecimalHours = (() => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; })();
  const classIntervals = DB.mergeTimeIntervals(DB.clipIntervals([
    ...fixedToday.filter(t => t.calendarId).flatMap(t => DB.blockIntervals(t.startTime, t.endTime)),
    ...classesToday.flatMap(({ meeting }) => DB.blockIntervals(meeting.startTime, meeting.endTime)),
  ], WORK_WINDOW_START_HOUR, WORK_WINDOW_END_HOUR));
  // Same Cancelled exception as allFlexToday above. Fixed-time tasks stay
  // one combined "task" category regardless of type -- a fixed-time
  // Study/Review/Practice block is rare enough not to warrant its own
  // split here, unlike the flex pool above where it's the common case.
  const fixedActiveToday = fixedToday.filter(t => !t.calendarId && t.status !== 'Cancelled');
  const taskFixedIntervalsRaw = DB.mergeTimeIntervals(DB.clipIntervals(
    fixedActiveToday.filter(t => t.status !== 'Done').flatMap(t => DB.blockIntervals(t.startTime, t.endTime)),
    WORK_WINDOW_START_HOUR, WORK_WINDOW_END_HOUR));
  const taskFixedIntervals = DB.subtractTimeIntervals(taskFixedIntervalsRaw, classIntervals);
  const classHoursToday = DB.sumTimeIntervals(classIntervals);
  const taskFixedHoursToday = DB.sumTimeIntervals(taskFixedIntervals);
  const taskFixedIntervalsDone = DB.subtractTimeIntervals(
    DB.mergeTimeIntervals(DB.clipIntervals(
      fixedActiveToday.filter(t => t.status === 'Done').flatMap(t => DB.blockIntervals(t.startTime, t.endTime)),
      WORK_WINDOW_START_HOUR, WORK_WINDOW_END_HOUR)),
    classIntervals);
  const taskFixedHoursCompletedToday = DB.sumTimeIntervals(taskFixedIntervalsDone);

  // A class/fixed-time block whose end time is already behind "now" has
  // already happened, whether or not anyone marked it Done -- classes in
  // particular are never explicitly checked off. These clipped-to-now
  // versions feed only the "what's left" numbers below (Available, the
  // meter bar/legend); the full-day versions above still feed "Scheduled"/
  // workPct, which are legitimately full-day retrospective totals.
  const classHoursRemaining = DB.sumTimeIntervals(DB.clipIntervals(classIntervals, nowDecimalHours, WORK_WINDOW_END_HOUR));
  const taskFixedHoursRemaining = DB.sumTimeIntervals(DB.clipIntervals(taskFixedIntervals, nowDecimalHours, WORK_WINDOW_END_HOUR));

  // "Scheduled" now accounts for everything today -- classes, regular
  // tasks, AND study/review goals (previously goals were silently
  // excluded from every number on this card, which is exactly the bug
  // this fixes). "Completed" is the Done-status counterpart -- the two
  // together are the full picture, classes excepted (they're never
  // "Done", they just happen). ownWorkHoursToday (everything except
  // classes) is kept separately for the secondary %-line below, which
  // is specifically about how much of YOUR OWN work fits once immovable
  // class time is already carved out of the day.
  const ownWorkHoursToday = taskFixedHoursToday + taskHoursToday + studyHoursToday;
  const hoursScheduledToday = classHoursToday + ownWorkHoursToday;
  const hoursCompletedToday = taskFixedHoursCompletedToday + taskHoursCompletedToday + studyHoursCompletedToday;

  const windowHours = WORK_WINDOW_END_HOUR - WORK_WINDOW_START_HOUR;
  const timeToWorkToday = Math.max(0, windowHours - classHoursToday);
  const workPct = timeToWorkToday > 0.01 ? Math.round((ownWorkHoursToday / timeToWorkToday) * 100) : (ownWorkHoursToday > 0 ? 100 : 0);

  // "Available" measures from right now to the window's close, not from
  // 8am -- whatever's already past is already past regardless of what
  // was scheduled in it, so a day already in progress only has what's
  // actually left of it. That's why this subtracts the "Remaining"
  // (now-clipped) class/fixed-task hours, not the full-day ones above --
  // a class that already happened doesn't shrink what's still ahead of
  // you, even though it correctly still counts toward the full-day
  // "Scheduled" stat. Flex (non-fixed-time) tasks don't need the same
  // now-clipping -- they're not tied to a clock time, so "already
  // happened" for them is just whatever taskHoursToday/studyHoursToday
  // already excludes via Done/Cancelled status. (A future day has no
  // "now" of its own, so anything else on this card computing a full
  // day's window still starts from WORK_WINDOW_START_HOUR, e.g. the %
  // line below.)
  const remainingWindowToday = Math.max(0, WORK_WINDOW_END_HOUR - nowDecimalHours);
  const ownWorkHoursRemaining = taskFixedHoursRemaining + taskHoursToday + studyHoursToday;
  const hoursAvailableToday = Math.max(0, remainingWindowToday - classHoursRemaining - ownWorkHoursRemaining);

  // The bar is a stacked, color-coded breakdown of what's actually
  // eating the remaining window -- classes (gray, immovable, same
  // "routine, not a task" gray used on the Calendar), regular tasks
  // (accent purple, same "color = a real scheduled task" rule used
  // there too), and study/review goals (blue, distinct from both) --
  // each segment's width is its share of remainingWindowToday, and the
  // bar's own overflow:hidden (see CSS) visually clips anything once
  // the total exceeds 100%, which is itself the "you're overloaded"
  // signal rather than a separate color swap. Uses the "Remaining"
  // hours for the same already-happened-doesn't-count reason as Available.
  const pctOf = h => remainingWindowToday > 0.01 ? Math.max(0, Math.round((h / remainingWindowToday) * 100)) : (h > 0 ? 100 : 0);
  const classPct = pctOf(classHoursRemaining);
  const taskPct = pctOf(taskFixedHoursRemaining + taskHoursToday);
  const studyPct = pctOf(studyHoursToday);
  const totalPct = classPct + taskPct + studyPct;

  el('workloadMeter').innerHTML = `
    <div class="meter-label">${hoursScheduledToday.toFixed(1)}h scheduled / ${remainingWindowToday.toFixed(1)}h left today</div>
    <div class="meter-bar meter-bar-stacked">
      <div class="meter-fill" style="width:${classPct}%;background:var(--text-faint)" title="Classes/events: ${classHoursRemaining.toFixed(1)}h"></div>
      <div class="meter-fill" style="width:${taskPct}%;background:var(--accent)" title="Tasks: ${(taskFixedHoursRemaining + taskHoursToday).toFixed(1)}h"></div>
      <div class="meter-fill" style="width:${studyPct}%;background:var(--blue)" title="Study/Review goals: ${studyHoursToday.toFixed(1)}h"></div>
    </div>
    <div class="workload-legend">
      <span><i style="background:var(--text-faint)"></i>Classes ${classHoursRemaining.toFixed(1)}h</span>
      <span><i style="background:var(--accent)"></i>Tasks ${(taskFixedHoursRemaining + taskHoursToday).toFixed(1)}h</span>
      <span><i style="background:var(--blue)"></i>Study ${studyHoursToday.toFixed(1)}h</span>
      ${totalPct > 100 ? `<span style="color:var(--red);font-weight:700;">${totalPct}% of today -- overloaded</span>` : ''}
    </div>
    <div class="glance-strip glance-strip-sm">
      <div class="glance-stat"><span class="glance-num">${hoursScheduledToday.toFixed(1)}h</span><span class="glance-label">Scheduled</span></div>
      <div class="glance-stat"><span class="glance-num">${hoursCompletedToday.toFixed(1)}h</span><span class="glance-label">Completed</span></div>
      <div class="glance-stat"><span class="glance-num">${(clockedTodayMinutes / 60).toFixed(1)}h</span><span class="glance-label">Clocked</span></div>
      <div class="glance-stat"><span class="glance-num">${hoursAvailableToday.toFixed(1)}h</span><span class="glance-label">Available</span></div>
    </div>
    <div class="meter-label" style="margin-top:2px;">⏱ <strong style="color:${workPct >= 100 ? 'var(--red)' : 'var(--text)'}">${workPct}%</strong> of today's workable time planned (${ownWorkHoursToday.toFixed(1)}h of ${timeToWorkToday.toFixed(1)}h, 8am–10pm minus classes/events)</div>
    ${workloadBreakdownHtml(fixedToday, allFlexToday, classesToday)}`;

  // ---------------- Remaining Workload (everything open, with a selectable horizon) ----------------
  // A bigger-picture companion to "Today's Workload" above -- every open
  // (not Done/Cancelled) task, same Tasks/Study color coding (classes
  // don't apply here -- they're recurring attendance, not a shrinking
  // backlog). The range toggle caps how far out a task's due date can be
  // and still count; overdue work always counts in every range since
  // it's due now-or-earlier, not "later." Undated tasks only ever show
  // under All Time, since they have no due date to compare to a horizon.
  const REMAINING_WORKLOAD_HORIZON_DAYS = { day: 0, '3day': 2, week: 6 };
  const remainingWorkloadHorizon = remainingWorkloadRange === 'all' ? null
    : DB.addDaysISO(DB.todayISO(), REMAINING_WORKLOAD_HORIZON_DAYS[remainingWorkloadRange]);
  const openWork = tasks.filter(t => {
    if (isResolvedStatus(t.status)) return false;
    if (!remainingWorkloadHorizon) return true;
    return !!t.dueDate && DB.isoCompare(t.dueDate, remainingWorkloadHorizon) <= 0;
  });
  const hoursFor = t => t.startTime ? DB.hoursBetween(t.startTime, t.endTime) : (parseFloat(t.estHours) || 0);
  const remainingTaskHours = openWork.filter(t => !isGoalBasedType(t.type)).reduce((s, t) => s + hoursFor(t), 0);
  const remainingStudyHours = openWork.filter(t => isGoalBasedType(t.type)).reduce((s, t) => s + hoursFor(t), 0);
  const remainingTotalHours = remainingTaskHours + remainingStudyHours;
  const taskSharePct = remainingTotalHours > 0.01 ? Math.round((remainingTaskHours / remainingTotalHours) * 100) : 0;
  const studySharePct = remainingTotalHours > 0.01 ? 100 - taskSharePct : 0;

  // Effort score -- how demanding this is to actually get through, not
  // just how many hours it adds up to. Two things raw hours miss:
  // 1) difficulty -- an hour of high-focus exam prep costs more than an
  //    hour of low-energy reading, so each task's hours are weighted by
  //    the energy it demands, its priority, and its type (graded/
  //    high-stakes work costs more per hour than open-ended work). The
  //    weights deliberately span a wide range so a pile of genuinely easy
  //    tasks and a pile of genuinely hard ones don't converge on the same
  //    score just because the raw hours match.
  // 2) feasibility -- 11.8h of work isn't "light" just because every task
  //    in it is individually easy, if there are only 9h left to do it in.
  //    The weighted total is scored as a % of the realistic capacity for
  //    the selected range (today's actual remaining hours for Day; a
  //    pro-rated slice of the weekly study-capacity setting otherwise),
  //    so overloading a short window reads as Heavy even when nothing in
  //    it is individually hard.
  const ENERGY_EFFORT_WEIGHT = { high: 1.5, medium: 1, low: 0.6 };
  const PRIORITY_EFFORT_WEIGHT = { High: 1.5, Medium: 1, Low: 0.6 };
  const TYPE_EFFORT_WEIGHT = { 'Exam/Quiz': 1.6, 'PSET': 1.25, 'Project Milestone': 1.25, 'Lab/Prelab': 1.15, 'Study/Review/Practice': 0.65 };
  const weightedEffortHours = openWork.reduce((sum, t) => {
    const ew = ENERGY_EFFORT_WEIGHT[t.energy] ?? 1;
    const pw = PRIORITY_EFFORT_WEIGHT[t.priority] ?? 1;
    const tw = TYPE_EFFORT_WEIGHT[t.type] ?? 1;
    return sum + hoursFor(t) * ew * pw * tw;
  }, 0);

  const hoursLeftToday = hoursUntilDayCutoff();
  const weeklyCapacityHours = state.settings.capacityHoursPerWeek || 30;
  const EFFORT_CAPACITY_HOURS = {
    day: hoursLeftToday,
    '3day': weeklyCapacityHours * 3 / 7,
    week: weeklyCapacityHours,
    all: weeklyCapacityHours,
  };
  const EFFORT_LABEL_FOR_RANGE = {
    day: 'the hours left today',
    '3day': 'a 3-day slice of your weekly capacity setting',
    week: 'your weekly capacity setting',
    all: 'your weekly capacity setting',
  };
  const effortCapacityHours = EFFORT_CAPACITY_HOURS[remainingWorkloadRange];
  const effortScore = effortCapacityHours > 0.01
    ? Math.min(999, Math.round((weightedEffortHours / effortCapacityHours) * 100))
    : (weightedEffortHours > 0.01 ? 999 : 0);
  const effortLevel = effortScore < 50 ? { label: 'Light', color: 'var(--green)' }
    : effortScore < 100 ? { label: 'Moderate', color: 'var(--yellow)' }
    : { label: 'Heavy', color: 'var(--red)' };

  // Only meaningful for the Day range -- comparing a week/all-time total
  // against a few hours left tonight would just show a meaningless >100%
  // overflow every time, not a useful signal.
  let dayCutoffHtml = '';
  if (remainingWorkloadRange === 'day') {
    const vsPct = hoursLeftToday > 0.01 ? Math.min(100, Math.round((remainingTotalHours / hoursLeftToday) * 100)) : (remainingTotalHours > 0 ? 100 : 0);
    const vsColor = vsPct >= 100 ? 'var(--red)' : vsPct >= 75 ? 'var(--yellow)' : 'var(--green)';
    dayCutoffHtml = `
    <div class="meter-bar" style="margin-top:10px;"><div class="meter-fill" style="width:${vsPct}%;background:${vsColor}"></div></div>
    <div class="meter-label">${remainingTotalHours.toFixed(1)}h of work vs <strong>${hoursLeftToday.toFixed(1)}h</strong> left today <span class="hint">(today runs until 2:00 AM tomorrow, not midnight)</span></div>`;
  }

  el('remainingWorkloadMeter').innerHTML = `
    <div class="meter-label">${remainingTotalHours.toFixed(1)}h remaining across ${openWork.length} open task${openWork.length === 1 ? '' : 's'}</div>
    <div class="meter-bar meter-bar-stacked">
      <div class="meter-fill" style="width:${taskSharePct}%;background:var(--accent)" title="Tasks: ${remainingTaskHours.toFixed(1)}h"></div>
      <div class="meter-fill" style="width:${studySharePct}%;background:var(--blue)" title="Study/Review goals: ${remainingStudyHours.toFixed(1)}h"></div>
    </div>
    <div class="workload-legend">
      <span><i style="background:var(--accent)"></i>Tasks ${remainingTaskHours.toFixed(1)}h</span>
      <span><i style="background:var(--blue)"></i>Study ${remainingStudyHours.toFixed(1)}h</span>
    </div>
    ${dayCutoffHtml}
    <div class="meter-label" style="margin-top:8px;">Effort score: <strong style="color:${effortLevel.color}">${effortScore}% · ${effortLevel.label}</strong>
      <span class="hint-icon" title="Hours weighted by focus level, priority, and task type (so genuinely hard work counts for more than easy work), shown as a % of ${EFFORT_LABEL_FOR_RANGE[remainingWorkloadRange]} -- over 100% means more weighted work than realistically fits, even if every task is individually easy." onclick="showToast(this.title)">ⓘ</span>
    </div>`;

  // Estimate accuracy, learned from this student's own completed tasks
  const accuracy = Estimator.accuracyInsight();
  el('accuracyInsight').innerHTML = accuracy
    ? `<p class="hint" style="font-size:13px;color:var(--text);margin:0 0 4px;">${accuracy.label}</p><p class="hint">Based on ${accuracy.sampleSize} completed task${accuracy.sampleSize === 1 ? '' : 's'} with logged actual hours.</p>`
    : `<div class="empty-note">Mark a few tasks Done with Actual Hours filled in to unlock this.</div>`;

  // Need help
  const needHelp = tasks.filter(t => t.needHelp && !isResolvedStatus(t.status)).sort((a, b) => DB.isoCompare(a.dueDate, b.dueDate));
  if (!needHelp.length) {
    el('needHelpList').innerHTML = `<div class="empty-note">No open office-hours requests.</div>`;
  } else {
    el('needHelpList').innerHTML = needHelp.map(t => taskRowHtml(t)).join('');
  }

  // Habit Streaks preview -- top habits from the dedicated Habits tab,
  // sorted by current streak (the ones most worth not breaking first).
  const habitsList = (state.habits || []).filter(h => !h.archived);
  if (!habitsList.length) {
    el('streaksList').innerHTML = `<div class="empty-note">No habits yet -- add one from the Habits tab.</div>`;
  } else {
    const todayForStreaks = today;
    const ranked = habitsList
      .map(h => ({ h, streak: Habits.currentStreak(h, todayForStreaks) }))
      .sort((a, b) => b.streak - a.streak)
      .slice(0, 5);
    el('streaksList').innerHTML = ranked.map(({ h, streak }) => {
      const doneToday = Habits.isDone(h, todayForStreaks);
      return `<div class="trow2" onclick="switchView('habits')" title="Open Habits">
        <span class="swatch" style="background:${h.color}"></span>
        <span class="trow2-title">${escapeHtml(h.name)}</span>
        <span class="trow2-extra">${Habits.describeGoal(h)}</span>
        <button class="habit-today-btn habit-today-btn-xs ${doneToday ? 'done' : ''}" onclick="event.stopPropagation(); toggleHabitDay('${h.id}', '${todayForStreaks}')">${doneToday ? '✓' : '○'}</button>
        <span class="streak-chip">🔥 ${streak}</span>
      </div>`;
    }).join('');
  }

  // Course progress, grouped by quarter
  const activeCourses = state.courses.filter(c => c.status === 'Active');
  if (!activeCourses.length) {
    el('courseProgressList').innerHTML = `<div class="empty-note">No active courses yet.</div>`;
  } else {
    const byQuarter = {};
    activeCourses.forEach(c => {
      const key = c.quarterId || '__none__';
      (byQuarter[key] = byQuarter[key] || []).push(c);
    });
    el('courseProgressList').innerHTML = Object.entries(byQuarter).map(([qid, courses]) => {
      const q = state.quarters.find(x => x.id === qid);
      const rows = courses.map(c => {
        const cTasks = tasks.filter(t => t.courseId === c.id);
        const done = cTasks.filter(t => t.status === 'Done').length;
        const pct = cTasks.length ? Math.round((done / cTasks.length) * 100) : 0;
        return `<div class="course-progress-row">
          <div class="course-progress-head"><strong>${courseSwatch(c.id)} ${escapeHtml(c.name)}</strong><span>${done}/${cTasks.length} tasks</span></div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%;background:${c.color}"></div></div>
        </div>`;
      }).join('');
      return `${q ? `<div class="progress-group-label">${escapeHtml(q.name)}</div>` : ''}${rows}`;
    }).join('');
  }

  // Midterms & finals, pulled from every course's exams[]
  const examItems = [];
  state.courses.forEach(c => (c.exams || []).forEach(e => {
    if (DB.isoCompare(e.date, today) >= 0) examItems.push({ ...e, courseId: c.id });
  }));
  examItems.sort((a, b) => DB.isoCompare(a.date, b.date));
  if (!examItems.length) {
    el('upcomingExamsList').innerHTML = `<div class="empty-note">No midterms or finals on the books yet -- add them from a course's edit screen.</div>`;
  } else {
    el('upcomingExamsList').innerHTML = examItems.slice(0, 8).map(e => `
      <div class="trow2" onclick="openCourseModal('${e.courseId}')">
        ${courseSwatch(e.courseId)}
        <span class="trow2-title">${escapeHtml(e.name || e.type)}</span>
        <span class="trow2-extra">${DB.fmtDate(e.date)}</span>
        <span class="trow2-course" style="color:${courseColor(e.courseId)}">${escapeHtml(courseName(e.courseId))}</span>
        <span class="streak-chip">${countdownLabel(e.date)}</span>
      </div>`).join('');
  }
}

/* ============================================================
   KANBAN
============================================================ */
let kanbanMode = 'status';
let kanbanWeekOffset = 0;
let kanbanDayOffset = 0;

// A future-scheduled recurring instance (e.g. next week's habit) isn't
// actionable yet -- keep it off the "right now" status board. It still
// shows up in the Week Kanban, Calendar, and Dashboard for its own day.
// Anything already in progress/blocked/done/cancelled stays visible regardless.
function isStatusBoardRelevant(t) {
  // a past fixed-time class already happened -- it's calendar history, not a pending item
  if (t.startTime && t.scheduledDate && DB.isoCompare(t.scheduledDate, DB.todayISO()) < 0) return false;
  if (t.status !== 'To Do' && t.status !== 'Backlog') return true;
  if (!t.scheduledDate) return true;
  return DB.isoCompare(t.scheduledDate, DB.todayISO()) <= 0;
}

function renderKanban() {
  const board = el('kanbanBoard');
  board.innerHTML = '';

  if (kanbanMode === 'status') {
    STATUS_OPTIONS.forEach(status => {
      const colTasks = activeTasks().filter(t => t.status === status && isStatusBoardRelevant(t));
      board.appendChild(buildKanbanColumn(status, status, colTasks, 'status'));
    });
  } else if (kanbanMode === 'day') {
    // A single day's own workflow board -- today by default (kanbanDayOffset
    // starts at 0), same status columns as "By Status" but scoped to just
    // what's scheduled on this one day, so dragging a card between columns
    // changes its status (not its date -- that's what "By Week" is for).
    const dateIso = DB.addDaysISO(DB.todayISO(), kanbanDayOffset);
    const dayTasks = activeTasks().filter(t => t.scheduledDate === dateIso);
    STATUS_OPTIONS.forEach(status => {
      const colTasks = dayTasks.filter(t => t.status === status);
      board.appendChild(buildKanbanColumn(status, status, colTasks, 'status'));
    });
  } else {
    const week = getWeekDates(kanbanWeekOffset);
    week.forEach((dateIso) => {
      const colTasks = activeTasks().filter(t => t.scheduledDate === dateIso && !isResolvedStatus(t.status));
      const title = `${WEEKDAY_FULL[DB.dayIndex(dateIso)]} · ${DB.fmtDate(dateIso)}`;
      board.appendChild(buildKanbanColumn(title, dateIso, colTasks, 'week'));
    });
    const unsched = activeTasks().filter(t => !t.scheduledDate && !isResolvedStatus(t.status));
    board.appendChild(buildKanbanColumn('Unscheduled', '__unscheduled__', unsched, 'week'));
  }
}

function buildKanbanColumn(title, key, tasks, mode) {
  const col = document.createElement('div');
  col.className = 'kanban-col';
  col.dataset.key = key;
  col.dataset.mode = mode;
  col.innerHTML = `<div class="kanban-col-head"><span>${title}</span><span class="kanban-col-count">${tasks.length}</span></div>`;
  const cardWrap = document.createElement('div');
  tasks.sort((a, b) => effectivePriorityRank(a) - effectivePriorityRank(b)).forEach(t => cardWrap.appendChild(buildKanbanCard(t)));
  col.appendChild(cardWrap);
  // Drop resolution happens inside startKanbanCardDrag itself (reads
  // this column's data-key/data-mode via elementFromPoint) -- no native
  // dragover/drop wiring needed here anymore.
  return col;
}

function buildKanbanCard(t) {
  // Imported calendar events are read-only (see openTaskModal) -- no
  // checkbox to complete, no dragging to a different status/day.
  const isEvent = !!t.calendarId;
  const card = document.createElement('div');
  card.className = `kanban-card ${t.status === 'Done' ? 'done' : ''} ${t.status === 'Cancelled' ? 'cancelled' : ''}`;
  card.style.borderLeftColor = courseColor(t.courseId);
  card.innerHTML = `
    <div class="kc-title">
      ${isEvent ? '' : `<input type="checkbox" class="trow2-check" ${t.status === 'Done' ? 'checked' : ''}
        onclick="event.stopPropagation(); toggleTaskDone('${t.id}', this.checked)">`}
      <span class="kc-title-text">${priorityMark(t.priority)} ${escapeHtml(t.title)}${isEvent ? ' <span class="pill pill-xs">📅 Event</span>' : ''}${t.canvasAssignmentId ? ' ' + canvasTagHtml(t) : ''}</span>
    </div>
    <div class="kc-meta">
      <span class="trow2-course" style="color:${courseColor(t.courseId)}">${courseSwatch(t.courseId)} ${escapeHtml(courseName(t.courseId))}</span>
      <span>${ENERGY_META[t.energy]?.label.split(' ')[0] || ''} ${t.needHelp ? '🙋' : ''}</span>
    </div>`;
  if (!isEvent) card.addEventListener('mousedown', e => startKanbanCardDrag(e, t.id));
  card.addEventListener('click', e => { if (!e.target.closest('input')) openTaskModal(t.id); });
  return card;
}

/* ============================================================
   HABITS -- simple daily yes/no tracking, independent of tasks
============================================================ */
// ~4 months' worth of weeks (current month + the 3 before it, on the
// unpaged view) -- small enough to actually fit in a card at this cell
// size without horizontal scroll clipping the most recent (rightmost)
// week, which 18 weeks did not.
const HABIT_HEATMAP_WEEKS = 12;
const HABIT_HEATMAP_MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HABIT_HEATMAP_WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', '']; // a label on every row is too cramped at this cell size

// Paging through history, in HABIT_HEATMAP_WEEKS-week chunks -- 0 is the
// current/most recent window (today in the rightmost column), 1 is the
// window immediately before that, etc. Shared across every habit card so
// they all page together instead of each having its own control.
let habitHeatmapPageOffset = 0;

function habitHeatmapAnchorIso(today) {
  return habitHeatmapPageOffset === 0 ? today : DB.addDaysISO(today, -habitHeatmapPageOffset * HABIT_HEATMAP_WEEKS * 7);
}

// Month labels (one per column, blank unless that column is where a new
// month starts) and weekday labels down the side -- a bare grid of
// colored squares with no date context is hard to actually use for
// tracking ("was that Tuesday or last Tuesday?"); hovering a cell still
// shows its exact date in the tooltip.
function habitHeatmapHtml(habit, today, anchorIso) {
  const weeks = Habits.heatmapWeeks(habit, HABIT_HEATMAP_WEEKS, anchorIso, today);
  // A month that only spans a column or two before the next one starts
  // (e.g. a 12-week window landing mid-month) doesn't have room for its
  // own label at this cell size -- showing it anyway just overlaps the
  // next month's text illegibly, so a label only renders if it's at
  // least 2 columns past the last one that actually showed.
  let lastMonth = null;
  let lastLabelCol = -Infinity;
  const monthLabels = weeks.map((col, i) => {
    const month = parseInt(col[0].dateIso.slice(5, 7), 10) - 1;
    let label = '';
    if (month !== lastMonth) {
      if (i - lastLabelCol >= 2) { label = HABIT_HEATMAP_MONTH_ABBR[month]; lastLabelCol = i; }
      lastMonth = month;
    }
    return label;
  });
  return `<div class="habit-heatmap-wrap">
    <div class="habit-heatmap-months">
      <div class="habit-heatmap-weekday-spacer"></div>
      ${monthLabels.map(l => `<span class="habit-heatmap-month-label">${l}</span>`).join('')}
    </div>
    <div class="habit-heatmap-body">
      <div class="habit-heatmap-weekday-labels">
        ${HABIT_HEATMAP_WEEKDAY_LABELS.map(l => `<span>${l}</span>`).join('')}
      </div>
      <div class="habit-heatmap">
        ${weeks.map(col => `<div class="habit-heatmap-col">
          ${col.map(day => `<div class="habit-heatmap-cell ${day.done ? 'done' : ''} ${day.isFuture ? 'future' : ''} ${day.dateIso === today ? 'is-today' : ''}"
                style="${day.done ? `background:${habit.color}` : ''}"
                title="${DB.fmtDate(day.dateIso)}${day.done ? ' — done' : ''}"
                ${day.isFuture ? '' : `onclick="toggleHabitDay('${habit.id}', '${day.dateIso}')"`}></div>`).join('')}
        </div>`).join('')}
      </div>
    </div>
  </div>`;
}

function habitCardHtml(habit) {
  const today = DB.todayISO();
  const streak = Habits.currentStreak(habit, today);
  const best = Habits.bestStreak(habit, today);
  // Completion-rate window matches each goal type's own natural cadence
  // -- 30 days (~1 month) for a daily habit, 84 days (12 weeks, so an
  // even number of full weeks) for a weekly one -- rather than using
  // the same raw day-count for both, which would make a weekly habit's
  // rate swing wildly based on where in its cycle "now" happens to fall.
  const rateWindow = habit.goalType === 'daily' ? 30 : 84;
  const rate = Habits.completionRate(habit, rateWindow, today);
  const doneToday = Habits.isDone(habit, today);
  const streakUnit = habit.goalType === 'daily' ? (streak === 1 ? 'day' : 'days') : (streak === 1 ? 'week' : 'weeks');

  return `<div class="habit-card">
    <div class="habit-card-head">
      <div class="habit-card-title">
        <span class="swatch" style="background:${habit.color}"></span>
        <span class="habit-name" onclick="openHabitModal('${habit.id}')" title="Edit this habit">${escapeHtml(habit.name)}</span>
        <span class="habit-goal-badge">${Habits.describeGoal(habit)}</span>
      </div>
      <button class="habit-today-btn ${doneToday ? 'done' : ''}" onclick="toggleHabitDay('${habit.id}', '${today}')">
        ${doneToday ? '✓ Done today' : 'Mark today done'}
      </button>
    </div>
    <div class="habit-stats-row">
      <div class="habit-stat"><span class="habit-stat-num">🔥 ${streak}</span><span class="habit-stat-label">${streakUnit} streak</span></div>
      <div class="habit-stat"><span class="habit-stat-num">🏆 ${best}</span><span class="habit-stat-label">best streak</span></div>
      <div class="habit-stat"><span class="habit-stat-num">${rate}%</span><span class="habit-stat-label">last ${habit.goalType === 'daily' ? '30 days' : '12 weeks'}</span></div>
    </div>
    ${habitHeatmapHtml(habit, today, habitHeatmapAnchorIso(today))}
  </div>`;
}

function formatHabitRangeLabel(startIso, endIso) {
  const [sy, sm] = startIso.split('-').map(Number);
  const [ey, em] = endIso.split('-').map(Number);
  const startLabel = HABIT_HEATMAP_MONTH_ABBR[sm - 1];
  const endLabel = HABIT_HEATMAP_MONTH_ABBR[em - 1];
  return sy === ey ? `${startLabel} – ${endLabel} ${ey}` : `${startLabel} ${sy} – ${endLabel} ${ey}`;
}

function renderHabits() {
  const state = DB.get();
  const habits = (state.habits || []).filter(h => !h.archived);
  const hasHabits = habits.length > 0;
  el('habitsEmptyState').classList.toggle('hidden', hasHabits);
  el('habitsContainer').classList.toggle('hidden', !hasHabits);
  el('habitsContainer').innerHTML = hasHabits ? habits.map(habitCardHtml).join('') : '';

  const today = DB.todayISO();
  const anchorIso = habitHeatmapAnchorIso(today);
  const lastMonday = Habits.mondayOf(anchorIso);
  const firstMonday = DB.addDaysISO(lastMonday, -(HABIT_HEATMAP_WEEKS - 1) * 7);
  const rangeEndIso = DB.addDaysISO(lastMonday, 6);
  el('habitsRangeLabel').textContent = formatHabitRangeLabel(firstMonday, rangeEndIso);
  el('habitsNextRange').disabled = habitHeatmapPageOffset === 0;

  // Keep the most recent week in view by default instead of leaving
  // overflow-x:auto scrolled to its initial (oldest/leftmost) position --
  // that's what made "today" look half cut off before, since it sits in
  // the rightmost column.
  document.querySelectorAll('.habit-heatmap').forEach(elx => { elx.scrollLeft = elx.scrollWidth; });
}

/* ============================================================
   CALENDAR -- Day / Week / Month, like a standard calendar app
============================================================ */
let calendarMode = 'week';
let calendarWeekOffset = 0;
let calendarDayOffset = 0;
let calendarMonthOffset = 0;

function renderCalendar() {
  if (calendarMode === 'day') renderCalendarDay();
  else if (calendarMode === 'month') renderCalendarMonth();
  else renderCalendarWeek();
}

function weekFlexChipHtml(t) {
  // An exam block (see DB.examBlocksOn) has no real task behind its id --
  // same read-only/immovable treatment as an imported calendar event, but
  // routed to the course editor (where exams are actually managed)
  // instead of a nonexistent task modal, same pattern as isScheduleBlock
  // elsewhere.
  const isEvent = !!t.calendarId || !!t.isExamBlock;
  const clickHandler = t.isExamBlock ? `openCourseModal('${t.courseId}')` : `openTaskModal('${t.id}')`;
  return `<div class="week-flex-chip ${t.status === 'Done' ? 'done' : ''} ${t.status === 'Cancelled' ? 'cancelled' : ''}" style="border-left-color:${courseColor(t.courseId)}"
      ${isEvent ? '' : `onmousedown="startCalendarTaskDrag(event, '${t.id}')"`} onclick="event.stopPropagation(); ${clickHandler}">
    ${isEvent ? '' : `<input type="checkbox" class="trow2-check" ${t.status === 'Done' ? 'checked' : ''} onclick="event.stopPropagation(); toggleTaskDone('${t.id}', this.checked)">`}
    <span class="week-flex-chip-text">${priorityMark(t.priority)}${t.isExamBlock ? '📌 ' : ''}${escapeHtml(t.title)}${t.estHours ? (isGoalBasedType(t.type) ? ` · 🎯 ${t.estHours}h goal` : ` · ${t.estHours}h`) : ''}${isEvent && !t.isExamBlock ? ' 📅' : ''}${t.canvasAssignmentId ? ' ' + canvasTagHtml(t) : ''}</span>
  </div>`;
}

// Full hour-by-hour time grid across 7 day columns (like Day view,
// repeated per day) instead of a stack of card-list columns -- fixed-time
// events are positioned by actual time, flexible tasks sit in an all-day
// strip up top, and drag-to-schedule works the same way it does in Day
// view since handleDayGridDrop reads the date off whichever column
// (e.currentTarget) the task was dropped on.
function renderCalendarWeek() {
  const week = getWeekDates(calendarWeekOffset);
  el('calendarWeekLabel').textContent = `${DB.fmtDate(week[0])} – ${DB.fmtDate(week[6])}`;
  const today = DB.todayISO();
  const state = DB.get();

  const hourRows = [];
  for (let h = DAY_VIEW_START_HOUR; h < DAY_VIEW_END_HOUR; h++) hourRows.push(h);
  const totalHeight = (DAY_VIEW_END_HOUR - DAY_VIEW_START_HOUR) * DAY_VIEW_PX_PER_HOUR;

  const perDay = week.map(dateIso => {
    const dayTasks = activeTasks().filter(t => t.scheduledDate === dateIso);
    const fixed = dayTasks.filter(t => t.startTime).concat(DB.classMeetingBlocksOn(state, dateIso));
    // Exams have no time of their own (see DB.examBlocksOn) so they ride
    // in the same all-day lane as flexible tasks rather than the timed
    // grid -- this is what "exams show up on the calendar the same way
    // classes do" means for a no-time event.
    const flex = dayTasks.filter(t => !t.startTime).concat(DB.examBlocksOn(state, dateIso)).sort((a, b) => effectivePriorityRank(a) - effectivePriorityRank(b));
    return { dateIso, flex, positioned: layoutDayEvents(fixed), free: Planner.freeHoursOnDay(state, dateIso, {}) };
  });

  const grid = el('calendarGrid');
  const prevScroll = el('weekHourScroll') ? el('weekHourScroll').scrollTop : null;
  grid.className = 'week-view-wrap';
  grid.innerHTML = `
    <div class="week-header-row">
      <div class="week-time-gutter"></div>
      ${perDay.map(d => `<div class="week-day-head ${d.dateIso === today ? 'today' : ''}" onclick="openDayView('${d.dateIso}')">
          <span>${WEEKDAY_SHORT[DB.dayIndex(d.dateIso)]}</span>
          <span>${DB.fmtDate(d.dateIso)}</span>
          <span class="week-free-hint">${d.free.toFixed(1)}h free</span>
        </div>`).join('')}
    </div>
    <div class="week-allday-row">
      <div class="week-time-gutter"></div>
      ${perDay.map(d => `<div class="week-allday-cell">${d.flex.map(weekFlexChipHtml).join('')}</div>`).join('')}
    </div>
    <div class="week-hour-scroll" id="weekHourScroll">
      <div class="week-hour-grid" style="height:${totalHeight}px">
        <div class="week-time-col">
          ${hourRows.map((h, i) => `<span class="week-time-label" style="top:${i * DAY_VIEW_PX_PER_HOUR}px">${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'AM' : 'PM'}</span>`).join('')}
        </div>
        ${perDay.map(d => `<div class="week-day-col" data-date="${d.dateIso}">
            ${hourRows.map((h, i) => `<div class="week-hour-line" style="top:${i * DAY_VIEW_PX_PER_HOUR}px"></div>`).join('')}
            ${d.positioned.map(dayEventBlockHtml).join('')}
          </div>`).join('')}
      </div>
    </div>`;

  const scrollWrap = el('weekHourScroll');
  if (scrollWrap) {
    scrollWrap.scrollTop = prevScroll !== null
      ? prevScroll
      : Math.max(0, (DAY_VIEW_DEFAULT_SCROLL_HOUR - DAY_VIEW_START_HOUR) * DAY_VIEW_PX_PER_HOUR - 40);
  }
}

function renderCalendarMonth() {
  // Anchor off DB.todayISO() (4am-boundary aware), not a raw `new Date()`.
  const [ty, tm] = DB.todayISO().split('-').map(Number);
  const anchor = new Date(ty, tm - 1 + calendarMonthOffset, 1);
  const year = anchor.getFullYear(), month = anchor.getMonth();
  el('calendarWeekLabel').textContent = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const startDow = (anchor.getDay() + 6) % 7; // Monday-first offset
  const gridStart = new Date(year, month, 1 - startDow);
  const today = DB.todayISO();

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push(DB.ymd(d));
  }

  const state = DB.get();
  const grid = el('calendarGrid');
  grid.className = 'calendar-grid-month';
  grid.innerHTML = `
    <div class="month-weekday-row">${WEEKDAY_SHORT_MON.map(d => `<div>${d}</div>`).join('')}</div>
    <div class="month-cells">
      ${cells.map(dateIso => {
        const inMonth = parseInt(dateIso.split('-')[1], 10) - 1 === month;
        const dayTasks = activeTasks().filter(t => t.scheduledDate === dateIso)
          .concat(DB.classMeetingBlocksOn(state, dateIso))
          .concat(DB.examBlocksOn(state, dateIso))
          .sort((a, b) => (a.startTime || '99:99').localeCompare(b.startTime || '99:99') || effectivePriorityRank(a) - effectivePriorityRank(b));
        const isToday = dateIso === today;
        const shown = dayTasks.slice(0, 3);
        const overflow = dayTasks.length - shown.length;
        return `<div class="month-cell ${inMonth ? '' : 'month-cell-out'} ${isToday ? 'month-cell-today' : ''}" onclick="openDayView('${dateIso}')">
          <div class="month-cell-date">${parseInt(dateIso.split('-')[2], 10)}</div>
          <div class="month-cell-tasks">
            ${shown.map(t => `<div class="month-chip ${t.status === 'Done' ? 'done' : ''} ${t.status === 'Cancelled' ? 'cancelled' : ''} ${t.isScheduleBlock ? 'month-chip-schedule-block' : ''}" style="border-left-color:${t.isScheduleBlock ? 'var(--text-faint)' : courseColor(t.courseId)}" onclick="event.stopPropagation(); ${t.isScheduleBlock || t.isExamBlock ? `openCourseModal('${t.courseId}')` : `openTaskModal('${t.id}')`}">${t.startTime ? DB.fmtTime(t.startTime) + ' ' : ''}${t.isExamBlock ? '📌 ' : ''}${escapeHtml(t.title)}${t.canvasAssignmentId ? ' 🎓' : ''}</div>`).join('')}
            ${overflow > 0 ? `<div class="month-chip-more">+${overflow} more</div>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

const DAY_VIEW_START_HOUR = 0;
const DAY_VIEW_END_HOUR = 24;
const DAY_VIEW_PX_PER_HOUR = 52;
const DAY_VIEW_DEFAULT_SCROLL_HOUR = 7; // where Day/Week views scroll to on first open

function toDayInterval(t) {
  const [sh, sm] = t.startTime.split(':').map(Number);
  const endTime = t.endTime || t.startTime;
  const [eh, em] = endTime.split(':').map(Number);
  const start = sh + sm / 60;
  const end = Math.max(eh + em / 60, start + 0.5);
  return { t, start, end, col: 0 };
}

function pxBlock(it) {
  return {
    t: it.t,
    top: Math.max(0, it.start - DAY_VIEW_START_HOUR) * DAY_VIEW_PX_PER_HOUR,
    height: Math.max(18, (Math.min(it.end, DAY_VIEW_END_HOUR) - Math.max(it.start, DAY_VIEW_START_HOUR)) * DAY_VIEW_PX_PER_HOUR),
  };
}

// Fixed-time blocks split into two groups with different layout rules:
// - Your own fixed-time tasks (no calendarId/isScheduleBlock) still get
//   the greedy side-by-side column treatment (the same idea Google
//   Calendar uses for back-to-back classes) -- you need to be able to
//   see and click/drag each one independently.
// - Imported calendar events (calendarId set) and a course's own
//   schedule blocks (isScheduleBlock -- see DB.classMeetingBlocksOn) are
//   both immovable and read-only, so there's nothing lost letting them
//   visually overlap instead of being squeezed into their own column --
//   each one cascades a little further right than the one it overlaps,
//   Google Calendar's "all-day" stacking look, rather than all rendering
//   in the exact same spot with only the topmost visible.
const EVENT_CASCADE_STEP = 10; // %, how far each overlapping event peeks out
function layoutDayEvents(events) {
  const calendarEvents = events.filter(t => t.calendarId || t.isScheduleBlock).map(toDayInterval).sort((a, b) => a.start - b.start);
  const fixedTasks = events.filter(t => !t.calendarId && !t.isScheduleBlock).map(toDayInterval).sort((a, b) => a.start - b.start);

  const taskColumnEnds = [];
  fixedTasks.forEach(it => {
    let col = taskColumnEnds.findIndex(end => end <= it.start);
    if (col === -1) { col = taskColumnEnds.length; taskColumnEnds.push(it.end); }
    else taskColumnEnds[col] = it.end;
    it.col = col;
  });
  const maxTaskCol = Math.max(1, taskColumnEnds.length);
  const taskBlocks = fixedTasks.map(it => ({
    ...pxBlock(it),
    left: (it.col / maxTaskCol) * 100,
    width: (1 / maxTaskCol) * 100 - 1,
    z: 100 + it.col, // always above any event cascade -- these are the interactive blocks
  }));

  const eventColumnEnds = [];
  calendarEvents.forEach(it => {
    let col = eventColumnEnds.findIndex(end => end <= it.start);
    if (col === -1) { col = eventColumnEnds.length; eventColumnEnds.push(it.end); }
    else eventColumnEnds[col] = it.end;
    it.col = col;
  });
  const eventBlocks = calendarEvents.map(it => ({
    ...pxBlock(it),
    left: Math.min(60, it.col * EVENT_CASCADE_STEP),
    width: Math.max(35, 99 - it.col * EVENT_CASCADE_STEP),
    z: 1 + it.col,
  }));

  // Events render first (so they end up behind tasks in document order,
  // and a task dragged onto the same slot as a class stays the one you
  // can actually interact with).
  return [...eventBlocks, ...taskBlocks];
}

// Shared by both the Day and Week hour-grid renders. An imported calendar
// event (calendarId set) is immovable and read-only -- it was never
// something you created by hand, iStudiez/the subscribed feed owns it, so
// there's no drag, no resize handle, no checkbox, and no click-to-edit.
// Your own fixed-time tasks keep full drag/resize/complete/edit behavior.
function dayEventBlockHtml(p) {
  const t = p.t;
  const posBase = `top:${p.top}px;height:${p.height}px;left:${p.left}%;width:${p.width}%;z-index:${p.z}`;
  // Course-schedule blocks are read-only calendar furniture, not
  // something you're actually working on -- color is reserved for real
  // scheduled tasks, so these get a neutral gray instead of the course's
  // color (which otherwise made them look identically "important" as
  // actual to-dos at a glance).
  if (t.isScheduleBlock) {
    const label = t.meetingLabel ? ` — ${escapeHtml(t.meetingLabel)}` : '';
    return `<div class="day-event day-event-readonly day-event-schedule-block" data-task-id="${t.id}" style="${posBase}" onclick="event.stopPropagation(); openCourseModal('${t.courseId}')" title="${escapeHtml(t.title)}${t.meetingLabel ? ' — ' + escapeHtml(t.meetingLabel) : ''} — from this course's Class Schedule, edit it there">
        <div class="day-event-title">${escapeHtml(t.title)}${label}</div>
        <div class="day-event-time">${DB.fmtTime(t.startTime)}–${DB.fmtTime(t.endTime)}</div>
      </div>`;
  }
  if (t.calendarId) {
    return `<div class="day-event day-event-readonly" data-task-id="${t.id}" style="${posBase};background:${courseColor(t.courseId)}" title="${escapeHtml(t.title)} — imported event, not editable">
        <div class="day-event-title">${escapeHtml(t.title)}</div>
        <div class="day-event-time">${DB.fmtTime(t.startTime)}–${DB.fmtTime(t.endTime)}</div>
      </div>`;
  }
  return `<div class="day-event ${t.status === 'Done' ? 'done' : ''} ${t.status === 'Cancelled' ? 'cancelled' : ''}" data-task-id="${t.id}" onmousedown="startCalendarTaskDrag(event, '${t.id}')"
        style="${posBase};background:${courseColor(t.courseId)}" onclick="event.stopPropagation(); openTaskModal('${t.id}')">
      <input type="checkbox" class="trow2-check day-event-check" ${t.status === 'Done' ? 'checked' : ''}
        onclick="event.stopPropagation(); toggleTaskDone('${t.id}', this.checked)">
      <div class="day-event-title">${escapeHtml(t.title)}${t.canvasAssignmentId ? ' 🎓' : ''}</div>
      <div class="day-event-time">${DB.fmtTime(t.startTime)}–${DB.fmtTime(t.endTime)}</div>
      <div class="day-event-resize" onmousedown="startEventResize(event, '${t.id}')" onclick="event.stopPropagation()"></div>
    </div>`;
}

function decimalHoursToHHMM(decimal) {
  let h = Math.floor(decimal);
  let m = Math.round((decimal - h) * 60);
  if (m === 60) { m = 0; h += 1; }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// The Dashboard's Daily Workload card only counts a "realistic" work
// window -- nobody's booking study blocks at 3am -- so a fixed-time
// block that starts or ends outside 8am-10pm only counts the portion of
// it that actually falls inside the window (see DB.blockIntervals /
// DB.clipIntervals, used in renderDashboard). This full-day window feeds
// the "% of today's workable time planned" line and is also the
// template for any OTHER day's window (e.g. a future day, which has no
// "current time" of its own yet) -- TODAY's own "Available" stat uses
// current-time-to-WORK_WINDOW_END_HOUR instead, see hoursAvailableToday.
const WORK_WINDOW_START_HOUR = 8;
const WORK_WINDOW_END_HOUR = 22;

// A fixed-time task is either a real calendar entry (a class/lecture, or
// anything pulled in from a subscribed .ics calendar) or just a flexible
// task the student dragged onto a time slot -- those are conceptually
// different, so Day view lists them in separate sidebar boxes.
function isCalendarEvent(t) {
  return t.type === 'Class' || !!t.calendarId;
}

function scheduledSideRowHtml(t) {
  // An imported calendar event (calendarId set), a course's own schedule
  // block (isScheduleBlock), or an exam block (isExamBlock) is immovable
  // and read-only -- unlike a hand-entered "Class" type task, which stays
  // fully draggable/completable/unschedulable. Neither a schedule block
  // nor an exam block has a real task behind its id, so both open the
  // course editor instead of the (nonexistent) task modal.
  const isEvent = !!(t.calendarId || t.isScheduleBlock || t.isExamBlock);
  const clickHandler = (t.isScheduleBlock || t.isExamBlock) ? `openCourseModal('${t.courseId}')` : `openTaskModal('${t.id}')`;
  const labelBit = t.isScheduleBlock && t.meetingLabel ? ` <span class="trow2-extra">${escapeHtml(t.meetingLabel)}</span>` : '';
  // Schedule blocks get a neutral gray swatch instead of the course's
  // color -- color is reserved for real scheduled tasks (see
  // dayEventBlockHtml's comment for the same rule in the grid itself).
  // Exams are the opposite case: a high-stakes one-off, not routine
  // scheduling clutter, so they keep the course's real color.
  const swatch = t.isScheduleBlock ? `<span class="swatch" style="background:var(--text-faint)"></span>` : courseSwatch(t.courseId);
  const timeBit = t.isExamBlock ? '📌 Exam' : `${DB.fmtTime(t.startTime)}–${DB.fmtTime(t.endTime)}`;
  return `<div class="trow2 ${isEvent ? '' : 'draggable-task'} ${t.status === 'Done' ? 'done' : ''} ${t.status === 'Cancelled' ? 'cancelled' : ''}" data-task-id="${t.id}"
      ${isEvent ? '' : `onmousedown="startCalendarTaskDrag(event, '${t.id}')"`} onclick="${clickHandler}">
    ${isEvent ? '' : `<input type="checkbox" class="trow2-check" ${t.status === 'Done' ? 'checked' : ''} onclick="event.stopPropagation(); toggleTaskDone('${t.id}', this.checked)">`}
    ${priorityMark(t.priority)}
    ${swatch}
    <span class="trow2-title">${escapeHtml(t.title)}</span>${labelBit}${t.canvasAssignmentId ? ' ' + canvasTagHtml(t) : ''}
    <span class="trow2-extra">${timeBit}</span>
    ${isEvent ? '' : `<button class="icon-btn trow2-unschedule" onclick="event.stopPropagation(); unscheduleTask('${t.id}')" title="Unschedule">✕</button>`}
  </div>`;
}

let dayViewLastRenderedDate = null;

function renderCalendarDay() {
  const dateIso = DB.addDaysISO(DB.todayISO(), calendarDayOffset);
  el('calendarWeekLabel').textContent = `${DB.weekdayName(dateIso)}, ${DB.fmtDate(dateIso)}, ${dateIso.split('-')[0]}`;
  const state = DB.get();
  const dayTasks = activeTasks().filter(t => t.scheduledDate === dateIso);
  const fixed = dayTasks.filter(t => t.startTime).concat(DB.classMeetingBlocksOn(state, dateIso));
  const flex = dayTasks.filter(t => !t.startTime).sort((a, b) => effectivePriorityRank(a) - effectivePriorityRank(b));
  // Exams have no startTime (see DB.examBlocksOn) so they can't join the
  // timed sort below -- appended after it instead, same "Calendar
  // Events" box as classes/imported events, which is what "exams show up
  // the same way classes do" means for a no-time event in Day view.
  const examBlocks = DB.examBlocksOn(state, dateIso);
  const calEvents = fixed.filter(isCalendarEvent).sort((a, b) => a.startTime.localeCompare(b.startTime)).concat(examBlocks);
  const scheduledSorted = fixed.filter(t => !isCalendarEvent(t)).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const positioned = layoutDayEvents(fixed);

  const hourRows = [];
  for (let h = DAY_VIEW_START_HOUR; h < DAY_VIEW_END_HOUR; h++) hourRows.push(h);

  const grid = el('calendarGrid');
  const scrollEl = el('dayHourGridScroll');
  const prevScroll = (dayViewLastRenderedDate === dateIso && scrollEl) ? scrollEl.scrollTop : null;
  grid.className = 'calendar-grid-day';
  grid.innerHTML = `
    <div class="day-sidebar">
      <div class="day-side-box" id="unscheduledBox">
        <div class="day-flex-strip-head">Unscheduled -- drag onto the grid</div>
        ${flex.length ? flex.map(t => taskRowHtml(t, { showCourse: false, draggable: true })).join('') : '<div class="empty-note">Nothing unscheduled -- add one with + New Task.</div>'}
      </div>
      <div class="day-side-box">
        <div class="day-flex-strip-head">Calendar Events</div>
        ${calEvents.length ? calEvents.map(scheduledSideRowHtml).join('') : '<div class="empty-note">No classes or calendar events today.</div>'}
      </div>
      <div class="day-side-box">
        <div class="day-flex-strip-head">Scheduled</div>
        ${scheduledSorted.length ? scheduledSorted.map(scheduledSideRowHtml).join('') : '<div class="empty-note">Nothing on the grid yet.</div>'}
      </div>
    </div>
    <div class="day-hour-grid-scroll" id="dayHourGridScroll">
      <div class="day-hour-grid" id="dayHourGrid" data-date="${dateIso}"
           style="height:${(DAY_VIEW_END_HOUR - DAY_VIEW_START_HOUR) * DAY_VIEW_PX_PER_HOUR}px">
        ${hourRows.map((h, i) => `<div class="day-hour-row" style="top:${i * DAY_VIEW_PX_PER_HOUR}px; height:${DAY_VIEW_PX_PER_HOUR}px;"><span class="day-hour-label">${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'AM' : 'PM'}</span></div>`).join('')}
        ${positioned.map(dayEventBlockHtml).join('')}
      </div>
    </div>`;

  const newScrollEl = el('dayHourGridScroll');
  newScrollEl.scrollTop = prevScroll !== null
    ? prevScroll
    : Math.max(0, (DAY_VIEW_DEFAULT_SCROLL_HOUR - DAY_VIEW_START_HOUR) * DAY_VIEW_PX_PER_HOUR - 40);
  dayViewLastRenderedDate = dateIso;
}

/* ============================================================
   TASKS / INBOX -- grouped by day, reference-style rows
============================================================ */
function populateCourseFilterOptions() {
  const sel = el('filterCourse');
  const current = sel.value;
  sel.innerHTML = '<option value="">All Courses/Categories</option>' +
    DB.get().courses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  sel.value = current;
}
function populateTypeFilterOptions() {
  el('filterType').innerHTML = '<option value="">All Types</option>' + TASK_TYPES.map(t => `<option>${t}</option>`).join('');
  el('filterStatus').innerHTML = '<option value="">All Statuses</option>' + STATUS_OPTIONS.map(s => `<option>${s}</option>`).join('');
  el('filterEnergy').innerHTML = '<option value="">All Energy</option>' + Object.entries(ENERGY_META).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
}

// Generated from COURSE_TYPES the same way the filters above are
// generated from TASK_TYPES/STATUS_OPTIONS, rather than hand-typed
// <option> tags in index.html that could silently drift out of sync.
function populateCourseTypeOptions() {
  el('courseType').innerHTML = COURSE_TYPES.map(t => `<option>${t}</option>`).join('');
}

// A Canvas-imported assignment with no due date at all (only possible
// when the "import undated" setting is on) gets its own section instead
// of blending into the generic "No Date" bucket, which otherwise mixes
// hand-created undated tasks with Canvas placeholder/ungraded entries.
const CANVAS_ORPHANED_KEY = '__CANVAS_ORPHANED__';

function bucketLabel(dateIso, today) {
  if (dateIso === CANVAS_ORPHANED_KEY) return 'Canvas - Orphaned';
  if (!dateIso) return 'No Date';
  const cmp = DB.isoCompare(dateIso, today);
  if (cmp < 0) return 'Overdue';
  if (cmp === 0) return 'Today';
  if (dateIso === DB.addDaysISO(today, 1)) return 'Tomorrow';
  return `${DB.weekdayName(dateIso)}, ${DB.fmtDate(dateIso)}`;
}

function renderTasksTable() {
  populateCourseFilterOptions();
  const courseF = el('filterCourse').value;
  const typeF = el('filterType').value;
  const statusF = el('filterStatus').value;
  const energyF = el('filterEnergy').value;
  const needHelpF = el('filterNeedHelp').checked;
  const hideDone = el('filterHideDone').checked;
  const canvasHiddenF = el('filterCanvasHidden').checked;
  const search = el('filterSearch').value.trim().toLowerCase();

  const today = DB.todayISO();
  // Recurring templates are just the rule, not a real work item -- only
  // their generated instances (which carry their own scheduledDate) show
  // here, bucketed under the day they actually fall on like anything else.
  let tasks = DB.visibleTasks(DB.get()).filter(t => !t.isTemplate);

  if (canvasHiddenF) {
    // Audit view: every Canvas-origin assignment that the default Inbox
    // filters (specifically "Hide Done/Cancelled") would hide, regardless
    // of every other filter above -- the point is to surface what's
    // missing from the normal view, not to narrow it further.
    tasks = tasks.filter(t => t.canvasAssignmentId && isResolvedStatus(t.status));
    if (search) tasks = tasks.filter(t => (t.title + ' ' + t.notes).toLowerCase().includes(search));
  } else {
    // a past fixed-time class already happened -- drop it rather than clutter Overdue with history
    tasks = tasks.filter(t => !(t.startTime && t.scheduledDate && DB.isoCompare(t.scheduledDate, today) < 0));

    if (courseF) tasks = tasks.filter(t => t.courseId === courseF);
    if (typeF) tasks = tasks.filter(t => t.type === typeF);
    if (statusF) tasks = tasks.filter(t => t.status === statusF);
    if (energyF) tasks = tasks.filter(t => t.energy === energyF);
    if (needHelpF) tasks = tasks.filter(t => t.needHelp);
    if (hideDone) tasks = tasks.filter(t => !isResolvedStatus(t.status));
    if (search) tasks = tasks.filter(t => (t.title + ' ' + t.notes).toLowerCase().includes(search));
  }

  const container = el('taskListContainer');

  if (!tasks.length) {
    container.innerHTML = `<div class="empty-note">No tasks match these filters.</div>`;
    return;
  }

  // Group into: overdue (merged), today, tomorrow, then individual future
  // dates in order, then undated last.
  const groups = new Map(); // dateIso|null|CANVAS_ORPHANED_KEY -> tasks[]
  tasks.forEach(t => {
    const dateKey = t.scheduledDate || t.dueDate || null;
    const key = (dateKey === null && t.canvasAssignmentId) ? CANVAS_ORPHANED_KEY : dateKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });

  const UNDATED_KEYS = new Set([null, CANVAS_ORPHANED_KEY]);
  const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
    if (UNDATED_KEYS.has(a) && UNDATED_KEYS.has(b)) return a === b ? 0 : (a === null ? -1 : 1);
    if (UNDATED_KEYS.has(a)) return 1;
    if (UNDATED_KEYS.has(b)) return -1;
    return DB.isoCompare(a, b);
  });

  let html = '';

  // merge all overdue keys into a single "Overdue" section, in date order
  const overdueKeys = sortedKeys.filter(k => !UNDATED_KEYS.has(k) && DB.isoCompare(k, today) < 0);
  const otherKeys = sortedKeys.filter(k => UNDATED_KEYS.has(k) || DB.isoCompare(k, today) >= 0);

  if (overdueKeys.length) {
    const rows = overdueKeys.flatMap(k => groups.get(k).sort((a, b) => effectivePriorityRank(a) - effectivePriorityRank(b)));
    html += `<div class="day-section"><div class="day-section-head day-section-overdue">Overdue</div>${rows.map(t => taskRowHtml(t)).join('')}</div>`;
  }

  otherKeys.forEach(key => {
    const rows = groups.get(key).sort((a, b) => effectivePriorityRank(a) - effectivePriorityRank(b));
    const label = key === null ? 'No Date' : key === CANVAS_ORPHANED_KEY ? 'Canvas - Orphaned' : bucketLabel(key, today);
    html += `<div class="day-section"><div class="day-section-head">${label}</div>${rows.map(t => taskRowHtml(t)).join('')}</div>`;
  });

  container.innerHTML = html;
}

/* ============================================================
   COURSES
============================================================ */
function courseCardHtml(c) {
  const cTasks = activeTasks().filter(t => t.courseId === c.id);
  const done = cTasks.filter(t => t.status === 'Done').length;
  const pct = cTasks.length ? Math.round((done / cTasks.length) * 100) : 0;
  const exams = (c.exams || []).slice().sort((a, b) => DB.isoCompare(a.date, b.date));
  return `<div class="course-card ${c.status === 'Archived' ? 'cc-archived' : ''}" style="border-top-color:${c.color}" onclick="openCourseModal('${c.id}')">
      <h4>${escapeHtml(c.name)}</h4>
      <div class="cc-type">${c.type}${c.code ? ' · ' + escapeHtml(c.code) : ''}</div>
      <div class="cc-meta">
        ${c.instructor ? '👤 ' + escapeHtml(c.instructor) + '<br>' : ''}
        ${c.location ? '📍 ' + escapeHtml(c.location) + '<br>' : ''}
        ${c.targetGrade ? '🎯 Target: ' + escapeHtml(c.targetGrade) + '<br>' : ''}
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%;background:${c.color}"></div></div>
      <div class="hint" style="margin:6px 0 0;">${done}/${cTasks.length} tasks done</div>
      ${exams.length ? `<div class="exam-badges">${exams.map(e => `<span class="exam-badge">📌 ${escapeHtml(e.name || e.type)} · ${DB.fmtDate(e.date)}</span>`).join('')}</div>` : ''}
    </div>`;
}

function courseTermGroupHtml(title, courses, status) {
  return `<div class="course-term-group">
    <div class="course-term-head">
      <h3>${escapeHtml(title)}</h3>
      ${status ? `<span class="pill ${quarterStatusPill(status)}">${status}</span>` : ''}
      <span class="hint">${courses.length} course${courses.length === 1 ? '' : 's'}</span>
    </div>
    <div class="courses-grid">${courses.map(courseCardHtml).join('')}</div>
  </div>`;
}

function renderCourses() {
  const state = DB.get();
  const container = el('coursesGrid');
  if (!state.courses.length) {
    container.innerHTML = `<div class="empty-note">No courses yet. Add your first class or club.</div>`;
    return;
  }
  const quarters = state.quarters.slice().sort((a, b) => DB.isoCompare(b.startDate, a.startDate));
  const quarterIds = new Set(quarters.map(q => q.id));

  let html = quarters
    .map(q => ({ q, courses: state.courses.filter(c => c.quarterId === q.id) }))
    .filter(g => g.courses.length)
    .map(g => courseTermGroupHtml(g.q.name, g.courses, g.q.status))
    .join('');

  const noTerm = state.courses.filter(c => !c.quarterId || !quarterIds.has(c.quarterId));
  if (noTerm.length) html += courseTermGroupHtml('No Term', noTerm, null);

  container.innerHTML = html;
}

/* ============================================================
   QUARTERS -- card based, with aggregate progress + nested courses
============================================================ */
function quarterStatusPill(status) {
  if (status === 'Active') return 'pill-todo';
  if (status === 'Archived') return 'pill-backlog';
  return 'pill-medium';
}

function renderQuarters() {
  const state = DB.get();
  const container = el('quartersContainer');
  const quarters = state.quarters.slice().sort((a, b) => DB.isoCompare(b.startDate, a.startDate));
  if (!quarters.length) {
    container.innerHTML = `<div class="empty-note">No terms yet. Add your current term to get going.</div>`;
    return;
  }
  container.innerHTML = quarters.map(q => {
    const courses = state.courses.filter(c => c.quarterId === q.id);
    const qTasks = activeTasks().filter(t => courses.some(c => c.id === t.courseId));
    const done = qTasks.filter(t => t.status === 'Done').length;
    const pct = qTasks.length ? Math.round((done / qTasks.length) * 100) : 0;
    return `<div class="quarter-card">
      <div class="quarter-card-head">
        <div>
          <h3 onclick="openQuarterModal('${q.id}')">${escapeHtml(q.name)}</h3>
          <span class="hint">${DB.fmtDate(q.startDate)} – ${DB.fmtDate(q.endDate)} · ${escapeHtml(q.year || '')}</span>
        </div>
        <div class="header-actions">
          <span class="pill ${quarterStatusPill(q.status)}">${q.status}</span>
          <button class="icon-btn" onclick="deleteQuarterConfirm('${q.id}')">🗑</button>
        </div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%;background:var(--accent)"></div></div>
      <div class="hint" style="margin:6px 0 10px;">${done}/${qTasks.length} tasks complete across ${courses.length} course${courses.length === 1 ? '' : 's'}</div>
      <div class="quarter-courses">
        ${courses.length ? courses.map(c => `<span class="course-chip" onclick="event.stopPropagation(); openCourseModal('${c.id}')">${courseSwatch(c.id)} ${escapeHtml(c.name)}</span>`).join('') : '<span class="hint">No courses linked yet.</span>'}
      </div>
      ${q.notes ? `<p class="hint quarter-notes">${escapeHtml(q.notes)}</p>` : ''}
    </div>`;
  }).join('');
}

/* ============================================================
   SETTINGS: imported/subscribed calendars
============================================================ */
function renderCalendarsList() {
  const state = DB.get();
  const container = el('calendarsList');
  if (!container) return;
  const cals = state.calendars || [];
  if (!cals.length) {
    container.innerHTML = `<div class="empty-note">No calendars imported yet.</div>`;
    return;
  }
  container.innerHTML = cals.map(c => {
    const count = state.tasks.filter(t => t.calendarId === c.id && !t.isTemplate).length;
    return `<div class="calendar-row">
      <input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="toggleCalendarEnabled('${c.id}', this.checked)" title="Show/hide this calendar's events everywhere">
      <span class="swatch" style="background:${c.color}"></span>
      <span class="calendar-row-name">${escapeHtml(c.name)}</span>
      <span class="hint">${count} event${count === 1 ? '' : 's'}${c.source === 'url' ? ' · subscribed' : ' · file'}</span>
      ${c.source === 'url' ? `<button class="btn btn-ghost btn-sm" onclick="refreshCalendar('${c.id}')">↻ Refresh</button>` : ''}
      <button class="icon-btn" onclick="deleteCalendarConfirm('${c.id}')">🗑</button>
    </div>`;
  }).join('');
}
