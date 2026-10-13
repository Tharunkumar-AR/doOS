/* ===================================================================
   main.js -- app init, view routing, modal handlers, CRUD forms,
   settings. This is the glue layer.
=================================================================== */

// AI Insights (Dashboard) -- NOT persisted to localStorage, deliberately.
// AI calls cost money and take a second or two, so this is user-triggered
// (a button click), never fired automatically on every renderAll(). Kept
// in memory only, keyed by the date it was fetched for, so switching
// views and back doesn't needlessly re-fetch; a manual Refresh forces a
// new call. See js/ai.js for what actually gets sent.
let aiInsightsCache = null; // { dateIso, headline, items: [{category, text}] } | null
let aiInsightsLoading = false;

function renderAll() {
  // Cheap to call every render: advances any recurring series whose
  // latest instance just got marked Done or has gone past its due date,
  // so the next occurrence appears immediately rather than waiting for
  // the next page load.
  Recurrence.generateUpcoming(DB.get());
  const canvasReady = Canvas.isConfigured(DB.get());
  el('canvasSyncAllBtnDash').classList.toggle('hidden', !canvasReady);
  el('canvasSyncAllBtnInbox').classList.toggle('hidden', !canvasReady);
  renderDashboard();
  renderAiInsightsCard();
  renderKanban();
  renderHabits();
  renderCalendar();
  renderTasksTable();
  renderCourses();
  renderQuarters();
  renderCalendarsList();
  renderAutoBackupsList();
  updateBackupReminder();
  renderActiveSessionWidget();
}

function showToast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.style.opacity = '1';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.classList.add('hidden'), 300);
  }, 2200);
}

function showModal(id) { el(id).classList.remove('hidden'); }
function hideModal(id) { el(id).classList.add('hidden'); }

// Shown after any BATCH change (Smart Replan, AI Reschedule, bulk AI
// estimate) -- see DB.snapshotForUndo's comment for why this is
// deliberately single-slot and not wired into single-task edits.
function showUndoBanner(label) {
  el('undoBatchLabel').textContent = label;
  el('undoBatchBanner').classList.remove('hidden');
}
function hideUndoBanner() {
  el('undoBatchBanner').classList.add('hidden');
}

// Closing a modal by clicking its × or clicking outside it (instead of an
// explicit Save button) autosaves whatever's in the form -- "Cancel"
// stays a pure discard for anyone who wants that instead.
function closeModalWithAutosave(id) {
  if (id === 'taskModalBackdrop') saveTaskFromForm({ silent: true });
  else if (id === 'courseModalBackdrop') saveCourseFromForm({ silent: true });
  else if (id === 'quarterModalBackdrop') saveQuarterFromForm({ silent: true });
  else if (id === 'habitModalBackdrop') saveHabitFromForm({ silent: true });
  else hideModal(id);
}

/* ---------------- TIME TRACKING / POMODORO ----------------
   One global active session (DB.get().activeSession) drives three UI
   surfaces: the clock button on every task row (js/ui.js taskRowHtml),
   the Time Tracking block inside the task edit modal, and the floating
   widget below. All of them read elapsed/remaining time fresh from
   stored timestamps vs Date.now() on every tick -- the setInterval below
   is purely a display refresh, never the source of truth, so a reload
   mid-session always resumes at the mathematically correct elapsed time. */

function clockInToTask(taskId) {
  const task = DB.get().tasks.find(t => t.id === taskId);
  if (!task) return;
  DB.clockIn(taskId);
  showToast(`Clocked in to "${task.title}".`);
  renderAll();
  refreshTaskModalClockSection();
}

function clockOutActiveSession() {
  const session = DB.get().activeSession;
  if (!session) return;
  const task = DB.get().tasks.find(t => t.id === session.taskId);
  DB.clockOut();
  showToast(task ? `Clocked out of "${task.title}".` : 'Clocked out.');
  renderAll();
  refreshTaskModalClockSection();
}

function renderActiveSessionWidget() {
  const session = DB.get().activeSession;
  const widget = el('activeSessionWidget');
  if (!widget) return;
  const task = session && DB.get().tasks.find(t => t.id === session.taskId);
  if (!session || !task) {
    widget.classList.add('hidden');
    return;
  }
  widget.classList.remove('hidden');
  el('aswTaskTitle').textContent = task.title;
  el('aswElapsed').textContent = formatElapsedTime(Date.now() - session.startedAt);
  const phaseMinutes = session.pomodoroPhase === 'focus'
    ? (session.pomodoroFocusMinutes || 25)
    : (session.pomodoroBreakMinutes || 5);
  const remainingMs = Math.max(0, phaseMinutes * 60000 - (Date.now() - session.pomodoroPhaseStartedAt));
  const phaseLabel = session.pomodoroPhase === 'focus' ? '🎯 Focus' : '☕ Break';
  el('aswPhase').textContent = `${phaseLabel} · ${formatElapsedTime(remainingMs)} left`;
}

// Re-draws the task modal's Clock In/Out control + Time Log list for
// whichever task is currently open in it (no-op if the modal is showing
// a brand-new, not-yet-saved task, or a different task than the one that
// just changed).
function refreshTaskModalClockSection() {
  const id = el('taskId').value;
  if (!id) return;
  const task = DB.get().tasks.find(t => t.id === id);
  if (!task) return;
  el('taskActualHours').value = task.actualHours || 0;
  el('taskActualHours').disabled = !!(task.timeLog && task.timeLog.length);
  const session = DB.get().activeSession;
  const isActive = !!(session && session.taskId === id);
  const control = el('taskClockControl');
  if (isActive) {
    control.innerHTML = `
      <button type="button" class="clock-btn clock-btn-stop" id="modalClockOutBtn">⏸ Clock Out</button>
      <span class="clock-elapsed" id="taskClockElapsed">${formatElapsedTime(Date.now() - session.startedAt)}</span>`;
    el('modalClockOutBtn').addEventListener('click', clockOutActiveSession);
  } else {
    control.innerHTML = `<button type="button" class="clock-btn clock-btn-start" id="modalClockInBtn">▶ Clock In</button>`;
    el('modalClockInBtn').addEventListener('click', () => clockInToTask(id));
  }
  renderTimeLogSection(task);
}

function renderTimeLogSection(task) {
  const container = el('timeLogRowsContainer');
  if (!container) return;
  const entries = (task.timeLog || []).slice().sort((a, b) => b.startedAt - a.startedAt);
  if (!entries.length) {
    container.innerHTML = `<div class="hint">No time logged yet -- Clock In above to start tracking.</div>`;
    return;
  }
  container.innerHTML = entries.map(e => {
    const startD = new Date(e.startedAt);
    const dateLabel = startD.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const startLabel = startD.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const endLabel = e.endedAt ? new Date(e.endedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'in progress';
    const stillRunning = e.endedAt === null;
    return `<div class="time-log-row" data-entry-id="${e.id}">
      <span class="time-log-date">${dateLabel}</span>
      <span class="time-log-range">${startLabel} – ${endLabel}</span>
      <input type="number" class="time-log-minutes" min="0" step="1" value="${e.minutes ?? ''}"
        ${stillRunning ? 'disabled title="Still running -- Clock Out to finalize"' : ''}
        onchange="handleTimeLogMinutesChange('${task.id}', '${e.id}', this.value)">
      <span class="hint">min</span>
      <button type="button" class="icon-btn time-log-remove" title="Delete this entry" onclick="handleTimeLogDelete('${task.id}', '${e.id}')">🗑</button>
    </div>`;
  }).join('');
}

function handleTimeLogMinutesChange(taskId, entryId, value) {
  DB.updateTimeLogEntry(taskId, entryId, value);
  const task = DB.get().tasks.find(t => t.id === taskId);
  if (!task) return;
  if (el('taskId').value === taskId) el('taskActualHours').value = task.actualHours;
  renderTimeLogSection(task);
  renderAll();
  showToast('Time entry updated.');
}

function handleTimeLogDelete(taskId, entryId) {
  if (!confirm('Delete this time log entry?')) return;
  DB.deleteTimeLogEntry(taskId, entryId);
  const task = DB.get().tasks.find(t => t.id === taskId);
  if (!task) return;
  if (el('taskId').value === taskId) {
    el('taskActualHours').value = task.actualHours;
    // re-enable manual editing if that was the last logged entry
    el('taskActualHours').disabled = !!(task.timeLog && task.timeLog.length);
  }
  renderTimeLogSection(task);
  renderAll();
  showToast('Time entry deleted.');
}

// The single setInterval driving every live display: the floating
// widget, the task-row elapsed-time spans, and the modal's elapsed span
// if it's open on the active task. Set up once in DOMContentLoaded below
// -- never recreated on render.
function tickActiveSession() {
  const flips = DB.syncActiveSessionPhase();
  if (flips.length) {
    const last = flips[flips.length - 1];
    const message = last === 'focus' ? '🎯 Focus time -- back to it!' : '☕ Break time -- step away for a bit.';
    showToast(message);
    notifyPomodoroPhase(last === 'focus' ? 'Focus time' : 'Break time', message);
  }
  renderActiveSessionWidget();

  const session = DB.get().activeSession;
  document.querySelectorAll('.task-clock-elapsed').forEach(span => {
    if (session && span.dataset.taskId === session.taskId) {
      span.textContent = formatElapsedTime(Date.now() - session.startedAt);
    }
  });
  const modalElapsed = el('taskClockElapsed');
  if (modalElapsed && session && el('taskId').value === session.taskId) {
    modalElapsed.textContent = formatElapsedTime(Date.now() - session.startedAt);
  }
}

/* ---------------- NATIVE (TAURI) INTEGRATIONS ----------------
   All additive and feature-detected via DB.isTauriEnv() -- none of this
   runs, or needs to run, in the plain-browser deployment. */

// OS notification alongside the existing in-app toast, for when the
// window isn't focused/visible (e.g. minimized to the tray) -- asks for
// permission once, silently, the first time it's actually needed.
function notifyPomodoroPhase(title, body) {
  if (!(DB.isTauriEnv && DB.isTauriEnv())) return;
  if (!DB.get().settings.pomodoroDesktopNotify) return;
  const notif = window.__TAURI__ && window.__TAURI__.notification;
  if (!notif) return;
  notif.isPermissionGranted().then(granted => {
    if (granted) { notif.sendNotification({ title, body }); return; }
    notif.requestPermission().then(perm => {
      if (perm === 'granted') notif.sendNotification({ title, body });
    });
  }).catch(() => {});
}

// The global shortcut toggles clock in/out of whichever task was most
// recently clocked into -- derived from the data itself (the latest
// timeLog entry across all tasks) rather than a separate piece of state,
// so it's correct even right after an app restart.
function findMostRecentlyClockedTaskId() {
  let bestId = null, bestAt = -Infinity;
  DB.get().tasks.forEach(t => (t.timeLog || []).forEach(entry => {
    if (entry.startedAt > bestAt) { bestAt = entry.startedAt; bestId = t.id; }
  }));
  return bestId;
}

function handleClockToggleShortcut() {
  if (DB.get().activeSession) { clockOutActiveSession(); return; }
  const taskId = findMostRecentlyClockedTaskId();
  if (!taskId || !DB.get().tasks.find(t => t.id === taskId)) {
    showToast('No recent task to clock into -- open a task and Clock In first.');
    return;
  }
  clockInToTask(taskId);
}

const CLOCK_TOGGLE_SHORTCUT_LABEL = '⌘⇧K'; // must match CLOCK_TOGGLE_SHORTCUT in src-tauri/src/lib.rs
const APP_VERSION = '0.1.0'; // must match "version" in src-tauri/tauri.conf.json

function setupTauriIntegrations() {
  if (!(DB.isTauriEnv && DB.isTauriEnv())) return;
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('doos://clock-toggle', handleClockToggleShortcut);
  }

  el('desktopAppCard').classList.remove('hidden');
  el('clockShortcutLabel').textContent = CLOCK_TOGGLE_SHORTCUT_LABEL;
  // Overlay title bar (tauri.conf.json) means the native traffic lights
  // float over the window content instead of sitting in their own bar --
  // this class exists purely to give the sidebar's top room to clear them.
  document.body.classList.add('tauri-native');

  // Explicit JS drag trigger, belt-and-suspenders alongside the
  // declarative data-tauri-drag-region attribute on .brand and
  // .titlebar-drag-strip -- startDragging() requires
  // core:window:allow-start-dragging to be explicitly granted in
  // src-tauri/capabilities/default.json (confirmed against Tauri's own
  // generated ACL manifest: it is NOT part of core:window's default
  // permission set), which is why dragging silently did nothing before
  // that permission was added. Calling it directly here also means a
  // real failure logs to the console instead of just silently not moving.
  const tauriWindow = window.__TAURI__ && window.__TAURI__.window;
  if (tauriWindow && tauriWindow.getCurrentWindow) {
    document.querySelectorAll('[data-tauri-drag-region]').forEach(dragEl => {
      dragEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // left-click only
        tauriWindow.getCurrentWindow().startDragging().catch(err => {
          console.error('doOS: window drag failed --', err);
        });
      });
    });
  }

  const autostart = window.__TAURI__ && window.__TAURI__.autostart;
  if (autostart) {
    autostart.isEnabled().then(enabled => { el('autostartToggle').checked = enabled; }).catch(() => {});
    el('autostartToggle').addEventListener('change', () => {
      const action = el('autostartToggle').checked ? autostart.enable() : autostart.disable();
      action.catch(e => {
        console.warn('doOS: could not change launch-at-login setting', e);
        showToast('Could not change that setting.');
        el('autostartToggle').checked = !el('autostartToggle').checked;
      });
    });
  }
}

/* ---------------- VIEW ROUTING ---------------- */
const VIEWS = ['dashboard', 'tasks', 'calendar', 'habits', 'kanban', 'courses', 'quarters', 'settings'];

function switchView(view) {
  if (!VIEWS.includes(view)) view = 'dashboard';
  VIEWS.forEach(v => el(`view-${v}`).classList.toggle('hidden', v !== view));
  document.querySelectorAll('.nav-link').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  location.hash = view;
  renderAll();
}

/* ---------------- AI INSIGHTS (Dashboard) ---------------- */
const AI_INSIGHT_CATEGORY_META = {
  warning: { icon: '⚠️', label: 'Heads up' },
  priority: { icon: '🎯', label: 'Priority' },
  tip: { icon: '💡', label: 'Tip' },
  positive: { icon: '✅', label: 'Nice work' },
};

function aiInsightRowHtml(item) {
  const meta = AI_INSIGHT_CATEGORY_META[item.category] || AI_INSIGHT_CATEGORY_META.tip;
  return `<div class="ai-insight-row ai-insight-${item.category}">
    <span class="ai-insight-icon">${meta.icon}</span>
    <div class="ai-insight-text"><span class="ai-insight-label">${meta.label}</span>${escapeHtml(item.text)}</div>
  </div>`;
}

function renderAiInsightsCard() {
  const body = el('aiInsightsBody');
  const refreshBtn = el('aiInsightsRefreshBtn');
  const headlineEl = el('aiInsightsHeadline');
  if (!body || !refreshBtn) return; // dashboard not in the DOM yet
  const state = DB.get();
  const today = DB.todayISO();
  const cachedForToday = aiInsightsCache && aiInsightsCache.dateIso === today ? aiInsightsCache : null;
  if (el('aiRescheduleBtn')) el('aiRescheduleBtn').classList.toggle('hidden', !AI.isConfigured(state));
  if (el('aiAddTaskBtn')) el('aiAddTaskBtn').classList.toggle('hidden', !AI.isConfigured(state));

  if (!AI.isConfigured(state)) {
    refreshBtn.classList.add('hidden');
    headlineEl.textContent = '';
    body.innerHTML = `<div class="empty-note">Add an API key in Settings to enable this → <button type="button" class="btn btn-ghost btn-sm" id="aiInsightsGotoSettingsBtn">Open Settings</button></div>`;
    el('aiInsightsGotoSettingsBtn').addEventListener('click', () => switchView('settings'));
    return;
  }

  if (aiInsightsLoading) {
    refreshBtn.classList.add('hidden');
    headlineEl.textContent = '';
    body.innerHTML = `<div class="ai-insights-loading"><span class="spinner"></span> Thinking... (${AI.providerLabel(state.settings.ai.provider)})</div>`;
    return;
  }

  if (cachedForToday) {
    refreshBtn.classList.remove('hidden');
    headlineEl.textContent = cachedForToday.headline || '';
    body.innerHTML = `<div class="ai-insights-grid">${cachedForToday.items.map(aiInsightRowHtml).join('')}</div>`;
    return;
  }

  refreshBtn.classList.add('hidden');
  headlineEl.textContent = '';
  body.innerHTML = `<button type="button" class="btn btn-primary btn-sm" id="aiInsightsFetchBtn">✨ Get Today's Insights</button>`;
  el('aiInsightsFetchBtn').addEventListener('click', () => fetchAiInsights(false));
}

async function fetchAiInsights(force) {
  const state = DB.get();
  if (!AI.isConfigured(state)) return;
  const today = DB.todayISO();
  if (!force && aiInsightsCache && aiInsightsCache.dateIso === today) return;
  aiInsightsLoading = true;
  renderAiInsightsCard();
  try {
    const result = await AI.dailyInsights(state);
    aiInsightsCache = { dateIso: today, headline: result.headline, items: result.items };
  } catch (err) {
    showToast(`AI Insights failed: ${err.message}`);
  } finally {
    aiInsightsLoading = false;
    renderAiInsightsCard();
  }
}

/* ---------------- TASK MODAL ---------------- */
function populateTaskCourseOptions() {
  const sel = el('taskCourse');
  sel.innerHTML = '<option value="">— None —</option>' +
    DB.get().courses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}${c.status === 'Archived' ? ' (archived)' : ''}</option>`).join('');
}

// Tracks whether the user has manually set a Scheduled Date different
// from Due Date in the currently-open task modal -- if so, the quick
// due-date buttons (and typing a new due date) leave it alone instead of
// overwriting a deliberate split between "due" and "working on it".
let scheduledDateTouched = false;

function openTaskModal(id) {
  populateTaskCourseOptions();
  const task = id ? DB.get().tasks.find(t => t.id === id) : null;
  scheduledDateTouched = !!(task && task.scheduledDate && task.scheduledDate !== task.dueDate);

  // A task with a calendarId was never created by hand -- it's an
  // imported .ics/subscribed-feed event, owned by that calendar, not by
  // doOS's own task system. Showing it as editable here would let you
  // "fix" a title or time that just gets overwritten (or silently
  // diverges) the next time that calendar re-syncs, so the whole form
  // goes read-only instead and editing happens at the source calendar.
  const isReadOnlyEvent = !!(task && task.calendarId);
  el('taskReadonlyBanner').classList.toggle('hidden', !isReadOnlyEvent);
  el('taskFormFieldset').disabled = isReadOnlyEvent;
  el('saveTaskBtn').classList.toggle('hidden', isReadOnlyEvent);
  el('deleteTaskBtn').classList.toggle('hidden', isReadOnlyEvent || !task);
  el('cancelTaskBtn').classList.toggle('hidden', isReadOnlyEvent || !task || task.status === 'Cancelled');
  el('uncancelTaskBtn').classList.toggle('hidden', isReadOnlyEvent || !task || task.status !== 'Cancelled');

  el('taskId').value = task ? task.id : '';
  el('taskModalTitle').textContent = isReadOnlyEvent ? 'Calendar Event' : task ? 'Edit Task' : 'New Task';
  el('taskName').value = task ? task.title : '';
  el('taskType').value = task ? task.type : 'ToDo';
  updateTaskEstHoursLabel();
  el('taskCourse').value = task ? (task.courseId || '') : '';
  el('taskDueDate').value = task ? (task.dueDate || '') : '';
  el('taskScheduledDate').value = task ? (task.scheduledDate || '') : DB.todayISO();
  el('taskEstHours').value = task ? task.estHours : '';
  el('taskActualHours').value = task ? (task.actualHours || 0) : 0;
  // Once there's real clocked time, this field is owned by the clock-in
  // system (recomputed from timeLog) -- disable manual edits so there's
  // no way to silently diverge it from the real tracked total.
  el('taskActualHours').disabled = !!(task && task.timeLog && task.timeLog.length);
  el('taskEnergy').value = task ? task.energy : 'medium';
  el('taskPriority').value = task ? task.priority : 'Medium';
  el('taskStatus').value = task ? task.status : 'To Do';
  el('taskNeedHelp').checked = task ? !!task.needHelp : false;
  el('taskNotes').value = task ? (task.notes || '') : '';
  el('taskStartTime').value = task ? (task.startTime || '') : '';
  el('taskEndTime').value = task ? (task.endTime || '') : '';
  el('splitRow').classList.toggle('hidden', !task || task.isTemplate || isReadOnlyEvent);
  el('splitDays').value = 2;
  el('estimateHint').classList.add('hidden');
  el('aiEstimateHint').classList.add('hidden');
  el('aiEstimateRow').classList.toggle('hidden', !AI.isConfigured(DB.get()) || isReadOnlyEvent);
  renderSubtaskRows((task && task.subtasks) || []);

  // Time tracking only makes sense once a task exists to attach a timeLog
  // to -- and not for a read-only calendar event, which isn't a task you
  // clock work against.
  el('taskClockSection').classList.toggle('hidden', !task || isReadOnlyEvent);
  if (task && !isReadOnlyEvent) refreshTaskModalClockSection();
  else { el('taskClockControl').innerHTML = ''; el('timeLogRowsContainer').innerHTML = ''; }

  const recurs = task && task.recurrence;
  el('taskRecurs').checked = !!recurs;
  el('recurrenceOptions').classList.toggle('hidden', !recurs);
  el('recFreq').value = recurs ? task.recurrence.freq : 'weekly';
  el('recInterval').value = recurs ? task.recurrence.interval : 1;
  el('recEndDate').value = recurs && task.recurrence.endDate ? task.recurrence.endDate : '';
  document.querySelectorAll('.recDay').forEach(cb => {
    cb.checked = !!(recurs && task.recurrence.daysOfWeek && task.recurrence.daysOfWeek.includes(parseInt(cb.value, 10)));
  });
  updateRecurrenceUIVisibility();

  showModal('taskModalBackdrop');
}

function setTaskDueDateQuick(daysFromNow) {
  const iso = DB.addDaysISO(DB.todayISO(), daysFromNow);
  el('taskDueDate').value = iso;
  if (!scheduledDateTouched) el('taskScheduledDate').value = iso;
}

function updateRecurrenceUIVisibility() {
  const freq = el('recFreq').value;
  el('recWeekdaysRow').classList.toggle('hidden', freq !== 'weekly');
  el('recIntervalUnit').textContent = freq === 'daily' ? 'day(s)' : 'week(s)';
}

/* ---------------- SUBTASKS ---------------- */
function renderSubtaskRows(subtasks) {
  const container = el('subtaskRowsContainer');
  if (!subtasks.length) {
    container.innerHTML = `<div class="hint">No subtasks yet.</div>`;
    return;
  }
  container.innerHTML = subtasks.map(s => `
    <div class="subtask-row" data-subtask-id="${s.id}">
      <input type="checkbox" class="subtask-done" ${s.done ? 'checked' : ''}>
      <input type="text" class="subtask-title" value="${escapeHtml(s.title)}" placeholder="Subtask">
      <button type="button" class="icon-btn subtask-remove">🗑</button>
    </div>`).join('');
  container.querySelectorAll('.subtask-remove').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.subtask-row').remove());
  });
}

function addSubtaskRow() {
  const container = el('subtaskRowsContainer');
  if (container.querySelector('.hint')) container.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'subtask-row';
  row.dataset.subtaskId = DB.uid('st');
  row.innerHTML = `
    <input type="checkbox" class="subtask-done">
    <input type="text" class="subtask-title" placeholder="Subtask">
    <button type="button" class="icon-btn subtask-remove">🗑</button>`;
  row.querySelector('.subtask-remove').addEventListener('click', () => row.remove());
  container.appendChild(row);
  row.querySelector('.subtask-title').focus();
}

function collectSubtasksFromForm() {
  return Array.from(el('subtaskRowsContainer').querySelectorAll('.subtask-row'))
    .map(row => ({
      id: row.dataset.subtaskId || DB.uid('st'),
      title: row.querySelector('.subtask-title').value.trim(),
      done: row.querySelector('.subtask-done').checked,
    }))
    .filter(s => s.title);
}

// Study/Review/Practice's estHours is a flexible time GOAL, not a
// completion estimate (see isGoalBasedType) -- the form label follows
// the type select live so that distinction is visible right where the
// number gets typed in, not just buried in a tooltip.
function updateTaskEstHoursLabel() {
  el('taskEstHoursLabel').textContent = isGoalBasedType(el('taskType').value) ? 'Study Goal (Hours)' : 'Est. Hours';
}

// Only nudges priority for a brand-new task (no id yet) switching INTO
// Study/Review/Practice -- never overrides a priority already chosen on
// an existing task, and never fires just from loading the modal.
function nudgePriorityForGoalType() {
  if (el('taskId').value) return;
  if (isGoalBasedType(el('taskType').value)) el('taskPriority').value = 'Low';
}

/* ---------------- SMART ESTIMATE HINT ---------------- */
function refreshEstimateHint() {
  const hint = el('estimateHint');
  if (el('taskStartTime').value || el('taskEstHours').value !== '') { hint.classList.add('hidden'); return; }
  const title = el('taskName').value.trim();
  const type = el('taskType').value;
  const courseId = el('taskCourse').value;
  if (!title && !type) { hint.classList.add('hidden'); return; }
  const suggestion = Estimator.suggest(title, type, courseId);
  if (!suggestion) { hint.classList.add('hidden'); return; }
  hint.classList.remove('hidden');
  const goalPrefix = isGoalBasedType(type) ? '🎯 ' : '💡 ';
  hint.innerHTML = `${goalPrefix}~${suggestion.hours}h based on ${suggestion.sampleSize} ${suggestion.basis} <button type="button" class="btn btn-ghost btn-sm" id="useEstimateBtn">Use this</button>`;
  el('useEstimateBtn').addEventListener('click', () => {
    el('taskEstHours').value = suggestion.hours;
    hint.classList.add('hidden');
  });
}

// ✨ AI estimate -- deliberately a separate flow from refreshEstimateHint()
// above (the local, offline Smart Estimate). Only fires on an explicit
// button click (never automatically), reads straight from the form since
// a brand-new task may not be saved yet, and renders its own distinctly-
// styled hint (.ai-hint, not .estimate-hint) so the two never blend
// together.
async function askAiForEstimate() {
  const hint = el('aiEstimateHint');
  const state = DB.get();
  if (!AI.isConfigured(state)) { showToast('Add an API key in Settings first.'); return; }
  const courseId = el('taskCourse').value;
  const taskFields = {
    title: el('taskName').value.trim() || '(untitled)',
    type: el('taskType').value,
    courseId,
    dueDate: el('taskDueDate').value || null,
    notes: el('taskNotes').value.trim(),
  };
  hint.classList.remove('hidden');
  hint.innerHTML = `✨ Asking ${AI.providerLabel(state.settings.ai.provider)}...`;
  try {
    const result = await AI.estimateTaskHours(state, taskFields);
    hint.innerHTML = `✨ AI estimate (sent to ${AI.providerLabel(state.settings.ai.provider)}): ~${result.hours}h
      <button type="button" class="btn btn-ghost btn-sm" id="useAiEstimateBtn">Use this</button>
      ${result.reasoning ? `<span class="ai-hint-reason">${escapeHtml(result.reasoning)}</span>` : ''}`;
    el('useAiEstimateBtn').addEventListener('click', () => {
      el('taskEstHours').value = result.hours;
      hint.classList.add('hidden');
      refreshEstimateHint();
    });
  } catch (err) {
    hint.innerHTML = `✨ ${escapeHtml(err.message)}`;
  }
}

/* ---------------- AI BULK ESTIMATE ----------------
   Finds every flexible task missing a real Est. Hours and asks the AI to
   fill them all in, a batch of several dozen at a time (AI.estimateTasksBatch)
   instead of one API call per task -- see js/ai.js for why. Checked
   between batches (not mid-flight) so Cancel stops starting new calls
   without trying to abort one already in progress. */
let aiBulkEstimateCancelled = false;

function candidateTasksForBulkEstimate() {
  return DB.get().tasks.filter(t =>
    !t.isTemplate && !isResolvedStatus(t.status) && !t.startTime &&
    (t.estHours === '' || t.estHours == null || Number.isNaN(parseFloat(t.estHours)) || parseFloat(t.estHours) <= 0)
  );
}

async function runBulkAiEstimate() {
  const state = DB.get();
  if (!AI.isConfigured(state)) { showToast('Add an API key in Settings first.'); return; }
  const statusLine = el('aiBulkEstimateStatusLine');
  const candidates = candidateTasksForBulkEstimate();
  if (!candidates.length) {
    statusLine.textContent = 'Nothing to estimate -- every flexible task already has an Est. Hours.';
    return;
  }

  const batchSize = AI.BULK_ESTIMATE_BATCH_SIZE;
  const batchCount = Math.ceil(candidates.length / batchSize);
  const provider = AI.providerLabel(state.settings.ai.provider);
  const ok = confirm(
    `Found ${candidates.length} task${candidates.length === 1 ? '' : 's'} without an estimate. ` +
    `This will make ${batchCount} AI API call${batchCount === 1 ? '' : 's'} to ${provider}, using your own key. Continue?`
  );
  if (!ok) return;

  DB.snapshotForUndo('AI bulk estimate');
  aiBulkEstimateCancelled = false;
  el('aiBulkEstimateBtn').classList.add('hidden');
  el('aiBulkEstimateCancelBtn').classList.remove('hidden');

  let estimated = 0, skipped = 0;
  for (let i = 0; i < candidates.length; i += batchSize) {
    if (aiBulkEstimateCancelled) break;
    const chunk = candidates.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    statusLine.textContent = `Estimating batch ${batchNum}/${batchCount} (${i} of ${candidates.length} tasks so far)...`;
    try {
      const results = await AI.estimateTasksBatch(state, chunk);
      chunk.forEach(t => {
        const hours = results.get(t.id);
        if (hours) { t.estHours = hours; estimated++; }
        else skipped++;
      });
      DB.save();
      renderAll();
    } catch (err) {
      skipped += chunk.length;
      statusLine.textContent = `Batch ${batchNum} failed (${err.message}) -- continuing with the rest...`;
    }
  }

  el('aiBulkEstimateBtn').classList.remove('hidden');
  el('aiBulkEstimateCancelBtn').classList.add('hidden');
  const note = aiBulkEstimateCancelled ? ' (stopped early)' : '';
  statusLine.textContent = `Done${note}: ${estimated} estimated, ${skipped} skipped.`;
  showToast(`AI estimates: ${estimated} filled in, ${skipped} skipped.`);
  if (estimated) showUndoBanner('AI bulk estimate');
}

function saveTaskFromForm(opts = {}) {
  // Read-only calendar event -- the form is disabled so there's nothing
  // to save; just close. (Also catches autosave-on-close, which calls
  // this unconditionally whenever the task modal closes.)
  if (el('taskFormFieldset').disabled) { hideModal('taskModalBackdrop'); return; }
  const title = el('taskName').value.trim();
  if (!title) {
    // nothing worth keeping -- autosave-on-close just closes quietly,
    // an explicit Save click leaves the modal open so they can fix it
    if (opts.silent) { hideModal('taskModalBackdrop'); return; }
    showToast('Task name is required.');
    return;
  }

  const id = el('taskId').value || null;
  const existing = id ? DB.get().tasks.find(t => t.id === id) : null;
  const scheduledDate = el('taskScheduledDate').value || null;
  const dueDate = el('taskDueDate').value || null;

  const recurs = el('taskRecurs').checked;
  let recurrence = null;
  if (recurs) {
    const freq = el('recFreq').value;
    const interval = Math.max(1, parseInt(el('recInterval').value, 10) || 1);
    const daysOfWeek = Array.from(document.querySelectorAll('.recDay:checked')).map(cb => parseInt(cb.value, 10));
    recurrence = {
      freq,
      interval,
      daysOfWeek: freq === 'weekly' ? (daysOfWeek.length ? daysOfWeek : [DB.dayIndex(scheduledDate || dueDate || DB.todayISO())]) : null,
      startDate: (existing && existing.recurrence && existing.recurrence.startDate) || scheduledDate || dueDate || DB.todayISO(),
      endDate: el('recEndDate').value || null,
      count: null,
    };
  }

  const subtasks = collectSubtasksFromForm();
  let status = el('taskStatus').value;
  // if every subtask just got checked off, treat that as finishing the task
  if (subtasks.length && subtasks.every(s => s.done) && status !== 'Done') status = 'Done';

  // Once a task has any clocked time, actualHours is owned by the
  // clock-in system (recomputed from timeLog on every clock-out/edit) --
  // the form field is read-only display in that case, so a stray edit
  // followed by an autosave-on-close can't silently overwrite real
  // tracked time with whatever the input happened to show.
  const hasTimeLog = existing && existing.timeLog && existing.timeLog.length;
  const actualHours = hasTimeLog
    ? existing.actualHours
    : (el('taskActualHours').value === '' ? 0 : parseFloat(el('taskActualHours').value));

  const task = Object.assign({}, existing || DB.mkTask({}), {
    id: existing ? existing.id : DB.uid('t'),
    title,
    type: el('taskType').value,
    courseId: el('taskCourse').value || '',
    dueDate,
    scheduledDate,
    estHours: el('taskEstHours').value === '' ? '' : parseFloat(el('taskEstHours').value),
    actualHours,
    energy: el('taskEnergy').value,
    priority: el('taskPriority').value,
    status,
    needHelp: el('taskNeedHelp').checked,
    notes: el('taskNotes').value,
    startTime: el('taskStartTime').value || null,
    endTime: el('taskEndTime').value || null,
    subtasks,
    isTemplate: recurs,
    recurrence,
  });

  DB.upsertTask(task);
  if (recurs) Recurrence.generateUpcoming(DB.get());

  hideModal('taskModalBackdrop');
  showToast('Task saved.');
  renderAll();

  const prevStatus = existing ? existing.status : null;
  if (task.canvasAssignmentId && status !== prevStatus) {
    if (status === 'Done') pushCanvasCompletion(task.id, { marked_complete: true });
    else if (status === 'Cancelled') pushCanvasCompletion(task.id, { dismissed: true });
    else if (prevStatus === 'Done' || prevStatus === 'Cancelled') pushCanvasCompletion(task.id, { marked_complete: false, dismissed: false });
  }
}

// Hands off to Planner.manualSplit, which needs a real Est. Hours figure
// to divide across days -- requires the task to already be saved (so it
// has an id) and estimated before this does anything.
function splitCurrentTask() {
  const id = el('taskId').value;
  if (!id) { showToast('Save the task first, then split it.'); return; }
  const task = DB.get().tasks.find(t => t.id === id);
  if (!task) return;
  if (!(parseFloat(task.estHours) > 0)) { showToast('Set Est. Hours before splitting.'); return; }
  const numDays = parseInt(el('splitDays').value, 10) || 2;
  Planner.manualSplit(task, numDays);
  hideModal('taskModalBackdrop');
  showToast(`Split into ${numDays} tasks across ${numDays} days.`);
  renderAll();
}

// Push a local completion/cancellation change to Canvas via its Planner
// Override API -- fire-and-forget (a flaky network call here shouldn't
// block the local UI update that already happened) and best-effort
// (silently skipped if Canvas isn't configured or this task never came
// from Canvas). Caches the override id the first time one gets created,
// so later pushes for the same assignment PUT instead of re-POSTing a
// duplicate override.
async function pushCanvasCompletion(taskId, patch) {
  const state = DB.get();
  if (!Canvas.isConfigured(state)) return;
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || !task.canvasAssignmentId) return;
  try {
    const override = await Canvas.setAssignmentOverride(state, task.canvasAssignmentId, task.canvasOverrideId, patch);
    if (override && override.id && override.id !== task.canvasOverrideId) {
      const fresh = DB.get().tasks.find(t => t.id === taskId);
      if (fresh) DB.upsertTask(Object.assign({}, fresh, { canvasOverrideId: override.id }));
    }
  } catch (err) {
    console.warn('Canvas completion push failed:', err.message);
  }
}

function toggleTaskDone(id, checked) {
  const task = DB.get().tasks.find(t => t.id === id);
  if (!task) return;
  // Pass a fresh copy to upsertTask instead of mutating the live-referenced
  // task in place -- upsertTask's own wasDone check reads state.tasks[idx]
  // BEFORE overwriting it, so if .status had already been flipped to 'Done'
  // on this same object, wasDone would always read true and the completion
  // would silently never get logged to taskHistory.
  DB.upsertTask(Object.assign({}, task, { status: checked ? 'Done' : 'To Do' }));
  renderAll();
  pushCanvasCompletion(id, { marked_complete: checked });
}

// Toggling a subtask inline (wherever a task row shows up, not just inside
// its edit modal) mirrors saveTaskFromForm's own rule: finishing every
// subtask marks the parent Done automatically. It never reopens an
// already-Done task just because one subtask got unchecked.
function toggleSubtaskDone(taskId, subtaskId, checked) {
  const task = DB.get().tasks.find(t => t.id === taskId);
  if (!task) return;
  const subtask = (task.subtasks || []).find(s => s.id === subtaskId);
  if (!subtask) return;
  subtask.done = checked;
  // Compute the would-be status but apply it via a fresh copy passed to
  // upsertTask, not by mutating task.status directly -- see toggleTaskDone's
  // comment for why mutating the live object first would break taskHistory
  // logging.
  let status = task.status;
  if (task.subtasks.length && task.subtasks.every(s => s.done) && status !== 'Done') {
    status = 'Done';
  }
  DB.upsertTask(Object.assign({}, task, { status }));
  renderAll();
}

// A generated occurrence of a recurring series (seriesId set), as
// opposed to the template itself (isTemplate true, invisible in every
// normal list) -- Delete/Cancel on one of these is ambiguous ("just this
// day" vs "this and every future occurrence too") in a way a one-off
// task never is, so it routes through openRecurrenceActionModal instead
// of a plain confirm().
function isSeriesInstance(task) {
  return !!task.seriesId && !task.isTemplate;
}

let pendingRecurrenceAction = null; // {taskId, mode: 'delete'|'cancel'}, backing the choice modal

// Permanently removes the task (unlike cancelTaskConfirm right below,
// which keeps the record and just marks it Cancelled) -- a recurring
// series instance routes through the "just this occurrence vs. this +
// all future" choice modal instead of a plain confirm(), same as Cancel.
function deleteTaskConfirm(id) {
  const task = DB.get().tasks.find(t => t.id === id);
  if (!task) return;
  if (isSeriesInstance(task)) { openRecurrenceActionModal(id, 'delete'); return; }
  const msg = task.isTemplate ? `Delete "${task.title}" and its entire recurring series?` : `Delete "${task.title}"?`;
  if (!confirm(msg)) return;
  DB.deleteTask(id);
  hideModal('taskModalBackdrop');
  showToast('Task deleted.');
  renderAll();
}

// Cancelling keeps the task record (unlike Delete) but marks it resolved
// without ever having actually been done -- see toggleTaskDone's comment
// for why the fresh-copy-then-upsert pattern matters here too.
function cancelTaskConfirm(id) {
  const task = DB.get().tasks.find(t => t.id === id);
  if (!task) return;
  if (isSeriesInstance(task)) { openRecurrenceActionModal(id, 'cancel'); return; }
  // Unlike Delete, cancelling a recurring template only cancels that one
  // occurrence -- it does not touch already-generated instances or stop
  // future ones, since the record (and its series) is meant to survive.
  const msg = task.isTemplate ? `Cancel this occurrence of "${task.title}"? Future occurrences are unaffected.` : `Cancel "${task.title}"?`;
  if (!confirm(msg)) return;
  DB.upsertTask(Object.assign({}, task, { status: 'Cancelled' }));
  hideModal('taskModalBackdrop');
  showToast('Task cancelled.');
  renderAll();
  // Canvas has no "cancelled" concept -- dismissing it hides it from the
  // student's own Canvas planner/to-do list without claiming it got done,
  // which is the closest honest mapping.
  pushCanvasCompletion(id, { dismissed: true });
}

// Undoes a Cancel -- no confirm needed, it's not destructive. Lands back
// on To Do rather than whatever status it held before cancelling (not
// tracked), same "safe default" the rest of the app uses for a reopened task.
function uncancelTask(id) {
  const task = DB.get().tasks.find(t => t.id === id);
  if (!task || task.status !== 'Cancelled') return;
  DB.upsertTask(Object.assign({}, task, { status: 'To Do' }));
  hideModal('taskModalBackdrop');
  showToast('Task restored to To Do.');
  renderAll();
  pushCanvasCompletion(id, { marked_complete: false, dismissed: false });
}

// "Just this occurrence" vs "this and every future occurrence" --
// ambiguity that only exists for a recurring series instance (see
// isSeriesInstance above). Resolved by resolveRecurrenceAction once the
// student picks a button in the modal.
function openRecurrenceActionModal(taskId, mode) {
  const task = DB.get().tasks.find(t => t.id === taskId);
  if (!task) return;
  pendingRecurrenceAction = { taskId, mode };
  el('recurrenceActionTitle').textContent = mode === 'delete' ? 'Delete recurring task' : 'Cancel recurring task';
  el('recurrenceActionBody').textContent =
    `"${task.title}" is part of a recurring series. ${mode === 'delete' ? 'Delete' : 'Cancel'} just this occurrence, or this one and every future occurrence too?`;
  showModal('recurrenceActionModalBackdrop');
}

function resolveRecurrenceAction(scope) {
  // scope: 'one' | 'future'
  const pending = pendingRecurrenceAction;
  pendingRecurrenceAction = null;
  hideModal('recurrenceActionModalBackdrop');
  if (!pending) return;
  const { taskId, mode } = pending;
  const task = DB.get().tasks.find(t => t.id === taskId);
  if (!task) return;

  if (mode === 'delete') {
    if (scope === 'one') DB.deleteTask(taskId);
    else DB.deleteSeriesFrom(taskId);
    showToast(scope === 'one' ? 'Occurrence deleted.' : 'Deleted this and every future occurrence.');
  } else {
    if (scope === 'one') {
      DB.upsertTask(Object.assign({}, task, { status: 'Cancelled' }));
      pushCanvasCompletion(taskId, { dismissed: true });
    } else {
      DB.cancelSeriesFrom(taskId);
    }
    showToast(scope === 'one' ? 'Occurrence cancelled.' : 'Cancelled this and every future occurrence.');
  }
  hideModal('taskModalBackdrop');
  renderAll();
}

/* ---------------- COURSE MODAL ---------------- */
function populateCourseQuarterOptions() {
  const sel = el('courseQuarter');
  sel.innerHTML = '<option value="">— None —</option>' + DB.get().quarters.map(q => `<option value="${q.id}">${escapeHtml(q.name)}</option>`).join('');
}

function renderExamRows(exams) {
  const container = el('examRowsContainer');
  if (!exams.length) {
    container.innerHTML = `<div class="hint">No exams added yet.</div>`;
    return;
  }
  container.innerHTML = exams.map(e => `
    <div class="exam-row" data-exam-id="${e.id}">
      <select class="exam-type">${EXAM_TYPES.map(t => `<option ${t === e.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <input type="text" class="exam-name" placeholder="e.g. Midterm 1" value="${escapeHtml(e.name || '')}">
      <input type="date" class="exam-date" value="${e.date || ''}">
      <button type="button" class="icon-btn exam-remove">🗑</button>
    </div>`).join('');
  container.querySelectorAll('.exam-remove').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.exam-row').remove());
  });
}

function addExamRow() {
  const container = el('examRowsContainer');
  if (container.querySelector('.hint')) container.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'exam-row';
  row.dataset.examId = DB.uid('ex');
  row.innerHTML = `
    <select class="exam-type">${EXAM_TYPES.map(t => `<option>${t}</option>`).join('')}</select>
    <input type="text" class="exam-name" placeholder="e.g. Midterm 1">
    <input type="date" class="exam-date">
    <button type="button" class="icon-btn exam-remove">🗑</button>`;
  row.querySelector('.exam-remove').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function collectExamsFromForm() {
  return Array.from(el('examRowsContainer').querySelectorAll('.exam-row')).map(row => ({
    id: row.dataset.examId || DB.uid('ex'),
    type: row.querySelector('.exam-type').value,
    name: row.querySelector('.exam-name').value.trim(),
    date: row.querySelector('.exam-date').value || null,
  })).filter(e => e.date); // an exam with no date isn't useful on the calendar/dashboard
}

const MEETING_WEEKDAYS = [
  { value: 1, label: 'M' }, { value: 2, label: 'T' }, { value: 3, label: 'W' }, { value: 4, label: 'T' },
  { value: 5, label: 'F' }, { value: 6, label: 'S' }, { value: 0, label: 'S' },
];

function weekdayChipRowHtml(selectedDays) {
  const selected = new Set(selectedDays || []);
  return `<div class="weekday-chip-row">
    ${MEETING_WEEKDAYS.map(d => `<button type="button" class="weekday-chip ${selected.has(d.value) ? 'active' : ''}" data-day="${d.value}">${d.label}</button>`).join('')}
  </div>`;
}

function wireWeekdayChips(row) {
  row.querySelectorAll('.weekday-chip').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });
}

// Free-text, not a fixed enum -- "Lecture"/"Discussion"/"Lab" are just
// the common cases, the datalist is a convenience, not a constraint.
const MEETING_LABEL_PRESETS = ['Lecture', 'Discussion', 'Lab', 'Section', 'Office Hours'];

function meetingLabelDatalistHtml() {
  return `<datalist id="meetingLabelPresets">${MEETING_LABEL_PRESETS.map(l => `<option value="${l}">`).join('')}</datalist>`;
}

// Time picked via three plain <select> dropdowns (hour/minute/AM-PM)
// instead of a native <input type="time">. The native control looks
// like one field but is actually 3 independently-clickable segments
// (hour/minute/period); a click anywhere except exactly the first
// segment starts typing in the wrong one, which silently leaves the
// hour blank with .value reporting "" and no visible sign anything's
// wrong -- reported as "meeting times don't save." A <select> has no
// such failure mode: every option is a full click target, and there is
// no "half-filled" state possible, since every dropdown always has
// something selected. 15-minute granularity is plenty for a class
// schedule (nobody's meeting at :07).
const MEETING_HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const MEETING_MINUTES = ['00', '15', '30', '45'];

// "HH:MM" (24h) -> {h12, m, ampm} for pre-filling the dropdowns. Snaps
// to the nearest 15-minute option if a value came from somewhere else
// (e.g. an old row saved before this redesign) with an odd minute.
function time24ToParts(t) {
  if (!t) return { h12: 10, m: '00', ampm: 'AM' };
  const [hh, mm] = t.split(':').map(Number);
  const ampm = hh >= 12 ? 'PM' : 'AM';
  let h12 = hh % 12;
  if (h12 === 0) h12 = 12;
  const mStr = String(mm).padStart(2, '0');
  const m = MEETING_MINUTES.includes(mStr)
    ? mStr
    : MEETING_MINUTES.reduce((best, cand) => Math.abs(Number(cand) - mm) < Math.abs(Number(best) - mm) ? cand : best);
  return { h12, m, ampm };
}

function partsTo24(h12, m, ampm) {
  let h = parseInt(h12, 10) % 12;
  if (ampm === 'PM') h += 12;
  return `${String(h).padStart(2, '0')}:${m}`;
}

function timeSelectGroupHtml(prefix, t) {
  const { h12, m, ampm } = time24ToParts(t);
  return `<span class="meeting-time-group">
    <select class="meeting-time-select ${prefix}-h">${MEETING_HOURS_12.map(h => `<option value="${h}" ${h === h12 ? 'selected' : ''}>${h}</option>`).join('')}</select>:<select class="meeting-time-select ${prefix}-m">${MEETING_MINUTES.map(mm => `<option value="${mm}" ${mm === m ? 'selected' : ''}>${mm}</option>`).join('')}</select><select class="meeting-time-select ${prefix}-ampm">${['AM', 'PM'].map(p => `<option value="${p}" ${p === ampm ? 'selected' : ''}>${p}</option>`).join('')}</select>
  </span>`;
}

function meetingRowInnerHtml(m) {
  return `
    ${weekdayChipRowHtml(m.daysOfWeek)}
    ${timeSelectGroupHtml('start', m.startTime)}
    <span class="meeting-time-sep">–</span>
    ${timeSelectGroupHtml('end', m.endTime)}
    <input type="text" class="meeting-label" list="meetingLabelPresets" placeholder="Lecture, Discussion, Lab..." value="${escapeHtml(m.label || '')}">
    <button type="button" class="icon-btn meeting-remove">🗑</button>`;
}

function renderMeetingRows(meetings) {
  const container = el('meetingRowsContainer');
  if (!meetings.length) {
    container.innerHTML = `<div class="hint">No meeting times yet -- doesn't count toward "today's classes" until you add one.</div>`;
    return;
  }
  container.innerHTML = meetingLabelDatalistHtml() + meetings.map(m => `<div class="meeting-row" data-meeting-id="${m.id}">${meetingRowInnerHtml(m)}</div>`).join('');
  container.querySelectorAll('.meeting-row').forEach(wireWeekdayChips);
  container.querySelectorAll('.meeting-remove').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.meeting-row').remove());
  });
}

function addMeetingRow() {
  const container = el('meetingRowsContainer');
  if (container.querySelector('.hint')) container.innerHTML = '';
  if (!container.querySelector('#meetingLabelPresets')) container.insertAdjacentHTML('afterbegin', meetingLabelDatalistHtml());
  const row = document.createElement('div');
  row.className = 'meeting-row';
  row.dataset.meetingId = DB.uid('mt');
  // Default to a plausible 10:00-11:00 AM block -- there's no "empty"
  // state for a <select>-based time anymore, so a freshly-added row
  // already has a complete, valid (if generic) time; only the weekday
  // still needs picking.
  row.innerHTML = meetingRowInnerHtml({ daysOfWeek: [], startTime: '10:00', endTime: '11:00', label: '' });
  wireWeekdayChips(row);
  row.querySelector('.meeting-remove').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function collectMeetingsFromForm() {
  return Array.from(el('meetingRowsContainer').querySelectorAll('.meeting-row')).map(row => ({
    id: row.dataset.meetingId || DB.uid('mt'),
    daysOfWeek: Array.from(row.querySelectorAll('.weekday-chip.active')).map(b => parseInt(b.dataset.day, 10)),
    startTime: partsTo24(row.querySelector('.start-h').value, row.querySelector('.start-m').value, row.querySelector('.start-ampm').value),
    endTime: partsTo24(row.querySelector('.end-h').value, row.querySelector('.end-m').value, row.querySelector('.end-ampm').value),
    label: row.querySelector('.meeting-label').value.trim(),
  })).filter(m => m.daysOfWeek.length); // the only way a row is still incomplete now is no weekday picked
}

function openCourseModal(id) {
  populateCourseQuarterOptions();
  const course = id ? DB.get().courses.find(c => c.id === id) : null;
  el('courseId').value = course ? course.id : '';
  el('courseModalTitle').textContent = course ? 'Edit Course/Category' : 'New Course/Category';
  el('courseName').value = course ? course.name : '';
  el('courseType').value = course ? course.type : 'Academic Class';
  el('courseCode').value = course ? (course.code || '') : '';
  el('courseUnits').value = course ? (course.units || 0) : 0;
  el('courseTargetGrade').value = course ? (course.targetGrade || '') : '';
  el('courseLocation').value = course ? (course.location || '') : '';
  el('courseInstructor').value = course ? (course.instructor || '') : '';
  el('courseQuarter').value = course ? (course.quarterId || '') : '';
  el('courseStatus').value = course ? course.status : 'Active';
  el('courseColor').value = course ? course.color : '#8b5cf6';
  renderColorPresets(el('courseColor').value);
  el('deleteCourseBtn').classList.toggle('hidden', !course);
  renderMeetingRows((course && course.meetings) || []);
  renderExamRows((course && course.exams) || []);
  populateCourseCanvasSection(course);
  renderCourseTasksList(course);
  showModal('courseModalBackdrop');
}

// Every task linked to this course/category, completed and incomplete,
// grouped so a long-running course doesn't dump hundreds of Done rows
// in your face -- Open is expanded by default (what you'd actually come
// here to check), Done/Cancelled collapse into <details> toggles. A
// custom minimal row (not taskRowHtml) on purpose: this is a navigable
// summary, not another place to check boxes or clock in, so it closes
// this modal and opens the real task modal on click instead of stacking
// two modals at once.
function renderCourseTasksList(course) {
  const container = el('courseTasksContainer');
  if (!course) { container.innerHTML = ''; return; }
  const tasks = DB.get().tasks.filter(t => t.courseId === course.id && !t.isTemplate);
  if (!tasks.length) {
    container.innerHTML = `<div class="empty-note">No tasks linked to this course/category yet.</div>`;
    return;
  }
  const dateKey = t => t.dueDate || t.scheduledDate || '9999-99-99';
  const open = tasks.filter(t => !isResolvedStatus(t.status)).sort((a, b) => DB.isoCompare(dateKey(a), dateKey(b)));
  const done = tasks.filter(t => t.status === 'Done').sort((a, b) => DB.isoCompare(dateKey(b), dateKey(a)));
  const cancelled = tasks.filter(t => t.status === 'Cancelled').sort((a, b) => DB.isoCompare(dateKey(b), dateKey(a)));

  const rowHtml = t => `<div class="trow2 ${t.status === 'Done' ? 'done' : ''} ${t.status === 'Cancelled' ? 'cancelled' : ''}" onclick="hideModal('courseModalBackdrop'); openTaskModal('${t.id}')">
    <span class="pill pill-xs ${statusClass(t.status)}">${escapeHtml(t.status)}</span>
    <span class="trow2-title">${escapeHtml(t.title)}</span>${t.canvasAssignmentId ? ' ' + canvasTagHtml(t) : ''}
    <span class="trow2-extra">${t.dueDate ? 'Due ' + DB.fmtDate(t.dueDate) : (t.scheduledDate ? DB.fmtDate(t.scheduledDate) : 'No date')}</span>
  </div>`;

  const group = (label, list, openByDefault) => !list.length ? '' : `
    <details ${openByDefault ? 'open' : ''} class="course-task-group">
      <summary>${label} (${list.length})</summary>
      ${list.map(rowHtml).join('')}
    </details>`;

  container.innerHTML = group('Open', open, true) + group('Done', done, false) + group('Cancelled', cancelled, false);
}

// Canvas course list comes from a real network call (Canvas.listCourses),
// so this can't be synchronous like the rest of openCourseModal -- the
// current mapping (if any) renders immediately; the dropdown's full
// option list fills in once the fetch resolves. Guards against a slow
// response landing after the user already closed this course or opened
// a different one (checks the modal still shows the same course id
// before touching the DOM).
async function populateCourseCanvasSection(course) {
  const notConfigured = el('courseCanvasNotConfigured');
  const mappingRow = el('courseCanvasMappingRow');
  const select = el('courseCanvasIdInput');
  const statusLine = el('courseCanvasSyncStatusLine');
  statusLine.textContent = '';
  const state = DB.get();
  if (!course || !Canvas.isConfigured(state)) {
    notConfigured.classList.toggle('hidden', !course);
    mappingRow.classList.add('hidden');
    return;
  }
  notConfigured.classList.add('hidden');
  mappingRow.classList.remove('hidden');
  select.innerHTML = `<option value="">— Not mapped —</option>${course.canvasCourseId ? `<option value="${course.canvasCourseId}" selected>Loading...</option>` : ''}`;
  try {
    const canvasCourses = await Canvas.listCourses(state);
    if (el('courseId').value !== course.id) return; // modal moved on while this was in flight
    select.innerHTML = `<option value="">— Not mapped —</option>` + canvasCourses.map(c =>
      `<option value="${c.id}" ${String(c.id) === String(course.canvasCourseId) ? 'selected' : ''}>${escapeHtml(c.name)}${c.code ? ` (${escapeHtml(c.code)})` : ''}</option>`
    ).join('');
  } catch (err) {
    if (el('courseId').value !== course.id) return;
    statusLine.textContent = `❌ Couldn't load Canvas courses: ${err.message}`;
  }
}

function renderColorPresets(selected) {
  const sel = (selected || '').toLowerCase();
  el('colorPresets').innerHTML = COURSE_COLOR_PRESETS.map(c => `
    <button type="button" class="color-swatch-btn ${c.toLowerCase() === sel ? 'selected' : ''}"
            style="background:${c}" title="${c}" onclick="selectCourseColor('${c}')"></button>
  `).join('');
}

function selectCourseColor(color) {
  el('courseColor').value = color;
  renderColorPresets(color);
}

function saveCourseFromForm(opts = {}) {
  const name = el('courseName').value.trim();
  if (!name) {
    if (opts.silent) { hideModal('courseModalBackdrop'); return; }
    showToast('Course name is required.');
    return;
  }
  const id = el('courseId').value || null;
  const existing = id ? DB.get().courses.find(c => c.id === id) : null;
  const course = Object.assign({}, existing || {}, {
    id: existing ? existing.id : DB.uid('c'),
    name,
    type: el('courseType').value,
    code: el('courseCode').value.trim(),
    units: parseFloat(el('courseUnits').value) || 0,
    targetGrade: el('courseTargetGrade').value.trim(),
    location: el('courseLocation').value.trim(),
    instructor: el('courseInstructor').value.trim(),
    quarterId: el('courseQuarter').value || '',
    status: el('courseStatus').value,
    color: el('courseColor').value,
    exams: collectExamsFromForm(),
    meetings: collectMeetingsFromForm(),
    canvasCourseId: el('courseCanvasIdInput') && !el('courseCanvasMappingRow').classList.contains('hidden') ? el('courseCanvasIdInput').value : (existing ? existing.canvasCourseId : ''),
  });
  DB.upsertCourse(course);
  hideModal('courseModalBackdrop');
  // A meeting row needs a weekday picked to count -- collectMeetingsFromForm
  // silently drops anything less (see its own comment), which from the user's
  // side just looks like "my meeting didn't save" with no explanation. This is
  // the one place that actually knows a row got dropped, so it's the one place
  // that can say so instead of leaving it a silent no-op.
  const totalMeetingRows = el('meetingRowsContainer').querySelectorAll('.meeting-row').length;
  const skipped = totalMeetingRows - course.meetings.length;
  showToast(skipped > 0
    ? `Course saved -- ${skipped} meeting${skipped === 1 ? '' : 's'} skipped (pick at least one day of the week for it).`
    : 'Course saved.');
  renderAll();
}

/* ---------------- CANVAS SYNC ----------------
   Pulls a mapped Canvas course's assignments in as real doOS tasks --
   matched to an existing task by canvasAssignmentId on re-sync (so
   re-running this updates title/due date/description instead of
   duplicating), left unmatched to create a new one. Pure data operation,
   no DOM -- shared by the per-course sync button, the Settings "Sync All"
   button, and autosync on launch. */
async function syncCourseAssignments(state, course) {
  const assignments = await Canvas.listAssignments(state, course.canvasCourseId);
  const today = DB.todayISO();
  const canvasSettings = state.settings.canvas || {};
  const leadDays = canvasSettings.scheduleLeadDays != null ? canvasSettings.scheduleLeadDays : 2;
  const importUndated = !!canvasSettings.importUndated;
  const weeksAhead = canvasSettings.importWeeksAhead != null ? canvasSettings.importWeeksAhead : 1;
  const horizonDate = DB.addDaysISO(today, weeksAhead * 7);
  // New tasks get scheduled `leadDays` before their due date (not ON it)
  // so there's working room before the deadline -- see scheduleLeadDays
  // in Settings. No due date at all means no scheduled date either.
  const scheduledFor = dueDate => dueDate ? DB.addDaysISO(dueDate, -leadDays) : null;

  let created = 0, updated = 0, skipped = 0;
  const touched = [];
  assignments.forEach(a => {
    const dueDate = a.due_at ? DB.ymd(new Date(a.due_at)) : null;
    // Undated assignments are mostly placeholder/ungraded entries -- skip
    // unless explicitly opted in. A due date further out than the
    // import horizon is left for a later sync rather than cluttering the
    // Inbox with things months away.
    if ((!dueDate && !importUndated) || (dueDate && DB.isoCompare(dueDate, horizonDate) > 0)) {
      skipped++;
      return;
    }
    const notes = Canvas.stripHtml(a.description);
    const canvasId = String(a.id);
    let task = state.tasks.find(t => t.canvasAssignmentId === canvasId);
    if (task) {
      const oldDueDate = task.dueDate;
      if (task.title !== a.name || oldDueDate !== dueDate || task.notes !== notes) {
        // Scheduled Date follows Due Date by default elsewhere in doOS
        // (quick due-date buttons) -- keep that convention here: only
        // drag it along if it was still following the old due date
        // (offset by leadDays, same as a freshly-created task), never
        // override a scheduled date the user deliberately moved.
        if (dueDate !== oldDueDate && (!task.scheduledDate || task.scheduledDate === scheduledFor(oldDueDate))) task.scheduledDate = scheduledFor(dueDate);
        task.title = a.name || task.title;
        task.dueDate = dueDate;
        task.notes = notes;
        updated++;
      }
    } else {
      task = DB.mkTask({
        title: a.name || 'Untitled Assignment',
        type: Canvas.guessType(a.name),
        courseId: course.id,
        dueDate,
        scheduledDate: scheduledFor(dueDate),
        notes,
        canvasAssignmentId: canvasId,
        status: dueDate && DB.isoCompare(dueDate, today) < 0 ? 'Backlog' : 'To Do',
        estHours: '',
      });
      state.tasks.push(task);
      created++;
    }
    touched.push(task);
  });
  DB.save();
  return { created, updated, touched, skipped };
}

// Pulls each touched task's Canvas-side marked_complete via the Planner
// Override API and reconciles it against the local status -- this is the
// "vice versa" half of completion sync (toggleTaskDone/cancelTaskConfirm/
// saveTaskFromForm's pushCanvasCompletion is the other half, pushing a
// local change out immediately). A locally Cancelled task is never
// reopened by this -- Canvas has no "cancelled" concept, so pull can only
// ever see marked_complete true/false, never why it's false.
async function reconcileCanvasCompletions(state, touchedTasks) {
  const withAssignment = touchedTasks.filter(t => t.canvasAssignmentId);
  if (!withAssignment.length) return 0;
  let overrides;
  try {
    overrides = await Canvas.listPlannerOverrides(state);
  } catch (err) {
    console.warn('Canvas planner override fetch failed:', err.message);
    return 0;
  }
  const byAssignmentId = new Map();
  (overrides || []).forEach(o => {
    if (o.plannable_type === 'assignment') byAssignmentId.set(String(o.plannable_id), o);
  });

  let changed = 0;
  withAssignment.forEach(t => {
    const override = byAssignmentId.get(t.canvasAssignmentId);
    if (!override) return;
    const fresh = state.tasks.find(x => x.id === t.id);
    if (!fresh || fresh.status === 'Cancelled') return;
    const patch = {};
    if (override.id && override.id !== fresh.canvasOverrideId) patch.canvasOverrideId = override.id;
    if (override.marked_complete && fresh.status !== 'Done') patch.status = 'Done';
    else if (!override.marked_complete && fresh.status === 'Done') patch.status = 'To Do';
    if (Object.keys(patch).length) {
      DB.upsertTask(Object.assign({}, fresh, patch));
      if (patch.status) changed++;
    }
  });
  if (changed) DB.save();
  return changed;
}

// Newly-touched tasks without a real estimate yet get run through the
// same batched AI estimate pipeline as the Settings "Fill in missing
// estimates" button, grounded in the assignment's own description --
// scoped to just this sync, not the whole backlog.
async function estimateTouchedTasks(state, touched, onProgress) {
  if (!AI.isConfigured(state)) return 0;
  const needEstimate = touched.filter(t => t.estHours === '' || t.estHours == null || Number.isNaN(parseFloat(t.estHours)) || parseFloat(t.estHours) <= 0);
  if (!needEstimate.length) return 0;
  let estimated = 0;
  const batchSize = AI.BULK_ESTIMATE_BATCH_SIZE;
  for (let i = 0; i < needEstimate.length; i += batchSize) {
    const chunk = needEstimate.slice(i, i + batchSize);
    try {
      const results = await AI.estimateTasksBatch(state, chunk);
      chunk.forEach(t => { const h = results.get(t.id); if (h) { t.estHours = h; estimated++; } });
      DB.save();
    } catch (err) {
      // One batch failing shouldn't lose the sync results already saved above.
    }
    if (onProgress) onProgress(estimated, needEstimate.length);
  }
  return estimated;
}

async function runCanvasSync(courseId) {
  const state = DB.get();
  const course = state.courses.find(c => c.id === courseId);
  const statusLine = el('courseCanvasSyncStatusLine');
  if (!Canvas.isConfigured(state)) { statusLine.textContent = 'Connect Canvas in Settings first.'; return; }
  if (!course || !course.canvasCourseId) { statusLine.textContent = 'Pick a Canvas course to map first.'; return; }

  statusLine.textContent = 'Fetching assignments from Canvas...';
  let created, updated, touched, skipped;
  try {
    ({ created, updated, touched, skipped } = await syncCourseAssignments(state, course));
  } catch (err) {
    statusLine.textContent = `❌ ${err.message}`;
    return;
  }
  const pulled = await reconcileCanvasCompletions(state, touched);
  renderAll();
  statusLine.textContent = `Synced: ${created} new, ${updated} updated${pulled ? `, ${pulled} completion${pulled === 1 ? '' : 's'} pulled from Canvas` : ''}${skipped ? `, ${skipped} skipped (undated or beyond the import horizon)` : ''}.`;

  const estimated = await estimateTouchedTasks(state, touched, (done, total) => {
    statusLine.textContent = `Synced: ${created} new, ${updated} updated. Estimating ${done}/${total} with AI...`;
  });
  if (estimated) {
    renderAll();
    statusLine.textContent = `Synced: ${created} new, ${updated} updated. AI-estimated ${estimated} task${estimated === 1 ? '' : 's'}.`;
  }
  showToast(`Canvas sync -- ${created} new, ${updated} updated.`);
}

// The global "Sync All Mapped Courses" button (and autosync on launch)
// loops every course with a canvasCourseId set and reuses the exact same
// per-course sync logic the course modal's own sync button calls.
async function runCanvasSyncAll(opts = {}) {
  const state = DB.get();
  const statusLine = el('canvasSyncAllStatusLine');
  if (!Canvas.isConfigured(state)) {
    if (!opts.silent) statusLine.textContent = 'Connect Canvas above first.';
    return;
  }
  const mapped = state.courses.filter(c => c.canvasCourseId);
  if (!mapped.length) {
    if (!opts.silent) statusLine.textContent = 'No courses are mapped to a Canvas course yet.';
    return;
  }
  if (!opts.silent) statusLine.textContent = `Syncing ${mapped.length} course${mapped.length === 1 ? '' : 's'}...`;

  let totalCreated = 0, totalUpdated = 0, totalPulled = 0, totalSkipped = 0;
  const allTouched = [];
  for (const course of mapped) {
    try {
      const { created, updated, touched, skipped } = await syncCourseAssignments(state, course);
      totalCreated += created;
      totalUpdated += updated;
      totalSkipped += skipped;
      allTouched.push(...touched);
    } catch (err) {
      console.warn(`Canvas sync failed for course "${course.name}":`, err.message);
    }
  }
  totalPulled = await reconcileCanvasCompletions(state, allTouched);
  await estimateTouchedTasks(state, allTouched);

  state.settings.canvas.lastSyncAt = Date.now();
  DB.save();
  renderAll();

  const summary = `Synced ${mapped.length} course${mapped.length === 1 ? '' : 's'}: ${totalCreated} new, ${totalUpdated} updated${totalPulled ? `, ${totalPulled} completion${totalPulled === 1 ? '' : 's'} pulled` : ''}${totalSkipped ? `, ${totalSkipped} skipped (undated or beyond the import horizon)` : ''}.`;
  if (!opts.silent) {
    statusLine.textContent = summary;
    showToast(summary);
  } else if (totalCreated || totalUpdated || totalPulled) {
    showToast(`Canvas autosync -- ${summary}`);
  }
}

// Autosync on launch -- throttled so reopening the app repeatedly (or a
// long session that re-inits) doesn't hammer Canvas's API every time;
// only actually fires if the last sync was more than 30 min ago.
const CANVAS_AUTOSYNC_THROTTLE_MS = 30 * 60 * 1000;
function maybeAutosyncCanvas() {
  const state = DB.get();
  const canvas = state.settings.canvas;
  if (!canvas || !canvas.autosync || !Canvas.isConfigured(state)) return;
  const lastSync = canvas.lastSyncAt || 0;
  if (Date.now() - lastSync < CANVAS_AUTOSYNC_THROTTLE_MS) return;
  runCanvasSyncAll({ silent: true });
}

function deleteCourseConfirm(id) {
  if (!confirm('Delete this course/category? Linked tasks will keep showing "— Unlinked —".')) return;
  DB.deleteCourse(id);
  hideModal('courseModalBackdrop');
  showToast('Course deleted.');
  renderAll();
}

/* ---------------- QUARTER MODAL ---------------- */
function openQuarterModal(id) {
  const q = id ? DB.get().quarters.find(x => x.id === id) : null;
  el('quarterId').value = q ? q.id : '';
  el('quarterModalTitle').textContent = q ? 'Edit Term' : 'New Term';
  el('quarterName').value = q ? q.name : '';
  el('quarterYear').value = q ? q.year : '';
  el('quarterSeason').value = q ? q.season : 'Autumn';
  el('quarterStart').value = q ? q.startDate : '';
  el('quarterEnd').value = q ? q.endDate : '';
  el('quarterStatus').value = q ? q.status : 'Upcoming';
  el('quarterNotes').value = q ? (q.notes || '') : '';
  el('deleteQuarterBtn').classList.toggle('hidden', !q);
  showModal('quarterModalBackdrop');
}

function saveQuarterFromForm(opts = {}) {
  const name = el('quarterName').value.trim();
  if (!name) {
    if (opts.silent) { hideModal('quarterModalBackdrop'); return; }
    showToast('Term name is required.');
    return;
  }
  const id = el('quarterId').value || null;
  const existing = id ? DB.get().quarters.find(x => x.id === id) : null;
  const q = Object.assign({}, existing || {}, {
    id: existing ? existing.id : DB.uid('q'),
    name,
    year: el('quarterYear').value.trim(),
    season: el('quarterSeason').value,
    startDate: el('quarterStart').value || null,
    endDate: el('quarterEnd').value || null,
    status: el('quarterStatus').value,
    notes: el('quarterNotes').value,
  });
  DB.upsertQuarter(q);
  hideModal('quarterModalBackdrop');
  showToast('Term saved.');
  renderAll();
}

function deleteQuarterConfirm(id) {
  if (!confirm('Delete this term?')) return;
  DB.deleteQuarter(id);
  hideModal('quarterModalBackdrop');
  showToast('Term deleted.');
  renderAll();
}

/* ---------------- HABIT MODAL ---------------- */
function openHabitModal(id) {
  const h = id ? DB.get().habits.find(x => x.id === id) : null;
  el('habitId').value = h ? h.id : '';
  el('habitModalTitle').textContent = h ? 'Edit Habit' : 'New Habit';
  el('habitName').value = h ? h.name : '';
  el('habitGoalType').value = h ? h.goalType : 'daily';
  el('habitWeeklyTarget').value = h ? h.weeklyTarget : 3;
  el('habitColor').value = h ? h.color : '#8b5cf6';
  renderHabitColorPresets(el('habitColor').value);
  el('deleteHabitBtn').classList.toggle('hidden', !h);
  updateHabitGoalUIVisibility();
  showModal('habitModalBackdrop');
}

function updateHabitGoalUIVisibility() {
  el('habitWeeklyTargetRow').classList.toggle('hidden', el('habitGoalType').value !== 'weekly');
}

function renderHabitColorPresets(selected) {
  const sel = (selected || '').toLowerCase();
  el('habitColorPresets').innerHTML = COURSE_COLOR_PRESETS.map(c => `
    <button type="button" class="color-swatch-btn ${c.toLowerCase() === sel ? 'selected' : ''}"
            style="background:${c}" title="${c}" onclick="selectHabitColor('${c}')"></button>
  `).join('');
}

function selectHabitColor(color) {
  el('habitColor').value = color;
  renderHabitColorPresets(color);
}

function saveHabitFromForm(opts = {}) {
  const name = el('habitName').value.trim();
  if (!name) {
    if (opts.silent) { hideModal('habitModalBackdrop'); return; }
    showToast('Habit name is required.');
    return;
  }
  const id = el('habitId').value || null;
  const existing = id ? DB.get().habits.find(x => x.id === id) : null;
  const habit = Object.assign({}, existing || DB.mkHabit({}), {
    id: existing ? existing.id : DB.uid('hb'),
    name,
    goalType: el('habitGoalType').value,
    weeklyTarget: Math.max(1, parseInt(el('habitWeeklyTarget').value, 10) || 3),
    color: el('habitColor').value,
  });
  DB.upsertHabit(habit);
  hideModal('habitModalBackdrop');
  showToast('Habit saved.');
  renderAll();
}

function deleteHabitConfirm(id) {
  const h = DB.get().habits.find(x => x.id === id);
  if (!h) return;
  if (!confirm(`Delete "${h.name}" and all its tracked history?`)) return;
  DB.deleteHabit(id);
  hideModal('habitModalBackdrop');
  showToast('Habit deleted.');
  renderAll();
}

// Shared by every heatmap cell and the card's quick "today" button.
function toggleHabitDay(habitId, dateIso) {
  DB.toggleHabitCompletion(habitId, dateIso);
  renderAll();
}

function findOrCreateCourseByName(name) {
  if (!name) return '';
  const state = DB.get();
  const match = state.courses.find(c => c.name.toLowerCase() === name.toLowerCase() || (c.code && c.code.toLowerCase() === name.toLowerCase()));
  if (match) return match.id;
  const activeQ = state.quarters.find(q => q.status === 'Active');
  const palette = ['#8b5cf6', '#3b82f6', '#06b6d4', '#ec4899', '#f59e0b', '#30a46c'];
  const course = DB.mkCourse({
    name,
    quarterId: activeQ ? activeQ.id : '',
    color: palette[state.courses.length % palette.length],
  });
  DB.upsertCourse(course);
  return course.id;
}

/* ---------------- CALENDAR MODE ---------------- */
function openDayView(dateIso) {
  calendarMode = 'day';
  calendarDayOffset = Math.round((new Date(dateIso) - new Date(DB.todayISO())) / 86400000);
  document.querySelectorAll('#calendarModeToggle .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'day'));
  renderCalendar();
}

/* ---------------- CUSTOM POINTER-DRAG ENGINE ----------------
   Replaces native HTML5 drag-and-drop everywhere (Kanban + Calendar):
   it's unreliable inside Tauri's WKWebView (the OS-level drag handler
   swallows dragover/drop before the page ever sees them) and gives no
   control over precise visual feedback even in a plain browser. This is
   a plain mousedown/mousemove/mouseup tracker, same technique already
   used for the day-event resize handle below -- never interferes with a
   normal click: nothing in here fires until the mouse has actually moved
   past a small threshold, so a quick click-without-moving still lets the
   browser's native `click` event fire afterward exactly as before. */
const DRAG_MOVE_THRESHOLD_PX = 4;

function trackMouseDrag(e, { onStart, onMove, onEnd }) {
  const startX = e.clientX, startY = e.clientY;
  let dragging = false;
  function move(ev) {
    if (!dragging) {
      if (Math.abs(ev.clientX - startX) < DRAG_MOVE_THRESHOLD_PX && Math.abs(ev.clientY - startY) < DRAG_MOVE_THRESHOLD_PX) return;
      dragging = true;
      document.body.classList.add('dragging-task');
      if (onStart) onStart(ev.clientX, ev.clientY);
    }
    if (onMove) onMove(ev.clientX, ev.clientY);
  }
  function up(ev) {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('dragging-task');
    if (onEnd) onEnd(ev.clientX, ev.clientY, dragging);
  }
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

/* ---------------- DAY/WEEK VIEW: drag-to-schedule + resize-to-estimate ---------------- */
const MIN_EVENT_HOURS = 0.25;

// Clears a task's time slot, moving it from the grid/Scheduled box back to
// Unscheduled. Its date (and estimate) are left alone -- only the specific
// time commitment goes away.
function unscheduleTask(taskId) {
  const task = DB.get().tasks.find(t => t.id === taskId);
  if (!task) return;
  task.startTime = null;
  task.endTime = null;
  DB.upsertTask(task);
  showToast(`"${task.title}" moved back to Unscheduled.`);
  renderCalendar();
}

// Drag any task row/chip/event block (Unscheduled sidebar, a Week all-day
// chip, or an already-scheduled .day-event being moved) onto an hour grid
// to schedule it, or onto the Unscheduled box to clear its time. Shows a
// live preview block snapped to the exact 15-minute slot under the
// cursor -- precise, not a whole-grid tint -- and drops into whichever
// day column (Week view) or the single day (Day view) the cursor ends
// up over.
function startCalendarTaskDrag(e, taskId) {
  // Mousedown on a checkbox/button nested inside a draggable row still
  // bubbles up here -- let it through untouched rather than risk
  // interfering with its own click handling.
  if (e.target.closest('input, button')) return;
  const task = DB.get().tasks.find(t => t.id === taskId);
  if (!task) return;
  e.preventDefault();
  const duration = parseFloat(task.estHours) > 0 ? parseFloat(task.estHours) : 1;
  // Capture the element now -- e.currentTarget is nulled out once this
  // mousedown event finishes dispatching, so reading it later inside
  // onStart/onEnd (which run on later mousemove/mouseup events) would throw.
  const sourceEl = e.currentTarget;
  const sourceIsDayEvent = sourceEl.classList.contains('day-event');

  let preview = null;
  let previewHost = null;
  let resolution = null;

  function clearTargets() {
    document.querySelectorAll('.day-side-box.drag-target').forEach(b => b.classList.remove('drag-target'));
  }
  function clearPreview() {
    if (preview) { preview.remove(); preview = null; }
    previewHost = null;
  }

  trackMouseDrag(e, {
    onStart() {
      if (sourceIsDayEvent) sourceEl.classList.add('being-dragged');
    },
    onMove(x, y) {
      const hit = document.elementFromPoint(x, y);
      const unscheduleBox = hit && hit.closest('#unscheduledBox');
      const grid = hit && hit.closest('.day-hour-grid, .week-day-col');

      if (unscheduleBox) {
        clearPreview();
        clearTargets();
        unscheduleBox.classList.add('drag-target');
        resolution = { type: 'unschedule' };
        return;
      }
      clearTargets();
      if (grid) {
        const rect = grid.getBoundingClientRect();
        let startDecimal = DAY_VIEW_START_HOUR + (y - rect.top) / DAY_VIEW_PX_PER_HOUR;
        startDecimal = Math.round(startDecimal * 4) / 4; // snap to 15 min
        startDecimal = Math.max(DAY_VIEW_START_HOUR, Math.min(DAY_VIEW_END_HOUR - duration, startDecimal));

        if (previewHost !== grid) {
          clearPreview();
          preview = document.createElement('div');
          preview.className = 'drag-preview-block';
          preview.style.left = '2%';
          preview.style.width = '96%';
          preview.style.background = courseColor(task.courseId);
          grid.appendChild(preview);
          previewHost = grid;
        }
        preview.style.top = (startDecimal - DAY_VIEW_START_HOUR) * DAY_VIEW_PX_PER_HOUR + 'px';
        preview.style.height = Math.max(18, duration * DAY_VIEW_PX_PER_HOUR) + 'px';
        preview.textContent = `${decimalHoursToHHMM(startDecimal)}–${decimalHoursToHHMM(startDecimal + duration)}`;
        resolution = { type: 'schedule', startDecimal, date: grid.dataset.date };
        return;
      }
      clearPreview();
      resolution = null;
    },
    onEnd() {
      if (sourceIsDayEvent) sourceEl.classList.remove('being-dragged');
      clearPreview();
      clearTargets();
      if (!resolution) return;
      if (resolution.type === 'unschedule') {
        unscheduleTask(taskId);
      } else {
        task.startTime = decimalHoursToHHMM(resolution.startDecimal);
        task.endTime = decimalHoursToHHMM(resolution.startDecimal + duration);
        task.estHours = duration;
        task.scheduledDate = resolution.date;
        DB.upsertTask(task);
        showToast(`Scheduled "${task.title}" at ${DB.fmtTime(task.startTime)}.`);
        renderCalendar();
      }
    },
  });
}

// Drag a Kanban card onto another column to change its status (By Status
// mode) or scheduled date (By Day mode) -- a cursor-following ghost
// instead of the browser's native drag image, and just the target
// column highlighted (cards always re-sort by priority within a column,
// there's no manual ordering to show a precise insertion point for).
function startKanbanCardDrag(e, taskId) {
  if (e.target.closest('input, button')) return;
  const task = DB.get().tasks.find(t => t.id === taskId);
  if (!task) return;
  e.preventDefault();
  const sourceCard = e.currentTarget;
  let ghost = null;
  let targetCol = null;

  trackMouseDrag(e, {
    onStart(x, y) {
      sourceCard.classList.add('kc-dragging-source');
      ghost = sourceCard.cloneNode(true);
      ghost.className = 'kanban-card-ghost';
      ghost.style.width = sourceCard.getBoundingClientRect().width + 'px';
      ghost.style.left = x + 'px';
      ghost.style.top = y + 'px';
      document.body.appendChild(ghost);
    },
    onMove(x, y) {
      if (ghost) { ghost.style.left = x + 'px'; ghost.style.top = y + 'px'; }
      const hit = document.elementFromPoint(x, y);
      const col = hit && hit.closest('.kanban-col');
      if (col !== targetCol) {
        if (targetCol) targetCol.classList.remove('drag-target');
        targetCol = col;
        if (targetCol) targetCol.classList.add('drag-target');
      }
    },
    onEnd() {
      sourceCard.classList.remove('kc-dragging-source');
      if (ghost) ghost.remove();
      if (targetCol) targetCol.classList.remove('drag-target');
      if (!targetCol) return;
      const key = targetCol.dataset.key, mode = targetCol.dataset.mode;
      // Build a fresh copy for upsertTask instead of mutating the
      // live-referenced task directly -- see toggleTaskDone's comment: a
      // mutate-then-upsert on the same object makes upsertTask's wasDone
      // check always read true, so dragging a card into Done would never
      // get logged to taskHistory.
      const patch = mode === 'status' ? { status: key } : { scheduledDate: key === '__unscheduled__' ? null : key };
      DB.upsertTask(Object.assign({}, task, patch));
      renderKanban();
      if (el('view-dashboard') && !el('view-dashboard').classList.contains('hidden')) renderDashboard();
    },
  });
}

// Drag the bottom edge of a day-event block to change its duration --
// this is a plain mouse-tracked resize (not HTML5 drag-and-drop), since
// that gives smooth continuous feedback as the mouse moves.
function startEventResize(e, taskId) {
  e.preventDefault();
  e.stopPropagation();
  const task = DB.get().tasks.find(t => t.id === taskId);
  if (!task || !task.startTime) return;

  const [sh, sm] = task.startTime.split(':').map(Number);
  const startDecimal = sh + sm / 60;
  const originalDuration = DB.hoursBetween(task.startTime, task.endTime) || 1;
  const startY = e.clientY;
  const el = document.querySelector(`.day-event[data-task-id="${taskId}"]`);
  let liveDuration = originalDuration;

  function onMove(ev) {
    const deltaHours = (ev.clientY - startY) / DAY_VIEW_PX_PER_HOUR;
    let newDuration = originalDuration + deltaHours;
    newDuration = Math.max(MIN_EVENT_HOURS, Math.round(newDuration * 4) / 4);
    newDuration = Math.min(newDuration, DAY_VIEW_END_HOUR - startDecimal);
    liveDuration = newDuration;
    if (el) el.style.height = (newDuration * DAY_VIEW_PX_PER_HOUR) + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (Math.abs(liveDuration - originalDuration) < 0.01) return; // no real change, skip a pointless save+rerender
    task.endTime = decimalHoursToHHMM(startDecimal + liveDuration);
    task.estHours = liveDuration;
    DB.upsertTask(task);
    showToast(`"${task.title}" now estimated at ${liveDuration}h.`);
    renderCalendar();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/* ---------------- SMART PLAN ---------------- */
function runSmartPlan() {
  const result = Planner.smartPlan(DB.get());
  // Tasks Smart Plan couldn't place get named explicitly instead of
  // just vanishing with no explanation -- the two fields it actually
  // needs (Est. Hours + Due Date) are reported separately so it's clear
  // which one to go fill in.
  const skipped = [];
  if (result.missingEstimate) skipped.push(`${result.missingEstimate} missing Est. Hours`);
  if (result.missingDueDate) skipped.push(`${result.missingDueDate} missing a Due Date`);
  if (result.missingBoth) skipped.push(`${result.missingBoth} missing both Est. Hours and a Due Date`);

  if (!result.planned) {
    showToast(skipped.length
      ? `Nothing to plan -- ${skipped.join(', ')}. Fill those in (or use "Fill in missing estimates" in Settings) and try again.`
      : 'Nothing to plan -- every flexible task is already scheduled.');
    return;
  }
  const parts = [`Scheduled ${result.planned} task(s) across ${result.days} day(s)`];
  if (result.split) parts.push(`${result.split} split across multiple days`);
  if (skipped.length) parts.push(`skipped: ${skipped.join(', ')}`);
  showToast(parts.join('. ') + '.');
  renderAll();
}

/* ---------------- SMART REPLAN ---------------- */
// Pulls every currently-overdue task back into view and tags it Backlog
// -- a one-click "stop staring at a growing overdue pile, just deal with
// it" reset. dueDate is left untouched (it's the real historical
// deadline; Backlog already means "needs triage" elsewhere in this app),
// only scheduledDate moves -- which also pulls it into Kanban's "By
// Week"/"By Day" columns immediately, since those key off scheduledDate.
// Uses the same overdue definition the Dashboard's Today's Agenda section
// does: has a dueDate in the past, not Done/Cancelled, not a fixed-time
// class (a missed lecture isn't "overdue"). isOverduePileTask's own
// scheduledDate check is strictly "<" today specifically so this doesn't
// become a no-op the moment it runs.
//
// Capacity-aware: today only has so many free hours, so not everything
// can land there -- what stays on today vs. gets bumped one more day out
// is decided primarily by the task's own High/Medium/Low priority (the
// student's explicit, deliberate signal), then by how overdue it is
// (longer-overdue claims the room first), and only falls back to
// RESCHEDULE_RANK (js/ui.js, the type-based reschedulability hierarchy)
// as a last tiebreak -- a High-priority ToDo must outrank a Low-priority
// PSET for today's limited room, not the other way around, since type
// alone used to completely override the priority the student actually set.
function runSmartReplan() {
  const today = DB.todayISO();
  const overdue = activeTasks().filter(t => isOverduePileTask(t, today));
  if (!overdue.length) {
    showToast('Nothing overdue to replan. 🎉');
    return;
  }
  DB.snapshotForUndo('Smart Replan');

  const tomorrow = DB.addDaysISO(today, 1);
  const state = DB.get();
  const capacityToday = Planner.dailyCapacity(state);
  const usedToday = Planner.fixedHoursOnDay(state, today) + Planner.flexHoursOnDay(state, today);
  let remaining = Math.max(0, capacityToday - usedToday);

  const sorted = overdue.slice().sort((a, b) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || DB.isoCompare(a.dueDate, b.dueDate)
    || rescheduleRank(a.type) - rescheduleRank(b.type));

  let movedToday = 0, bumpedTomorrow = 0;
  sorted.forEach(t => {
    const hours = parseFloat(t.estHours) || 0;
    // No estimate at all means we can't weigh it against capacity -- let
    // it through as long as today isn't already full from sized work,
    // rather than letting an unbounded pile of unknown-size tasks bypass
    // the capacity check entirely and overpack the day.
    const fitsToday = hours === 0 ? remaining > 0.01 : hours <= remaining;
    if (fitsToday) { remaining -= hours; movedToday++; } else bumpedTomorrow++;
    DB.upsertTask(Object.assign({}, t, { scheduledDate: fitsToday ? today : tomorrow, status: 'Backlog' }));
  });

  const parts = [`${movedToday} moved to today`];
  if (bumpedTomorrow) parts.push(`${bumpedTomorrow} bumped to tomorrow (today's full -- least-protected types first)`);
  showToast(`Replanned ${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}: ${parts.join(', ')}, tagged Backlog.`);
  showUndoBanner('Smart Replan');
  renderAll();
}

/* ---------------- AI SMART RESCHEDULE ----------------
   Unlike Smart Replan above (deterministic, applies instantly), this
   hands the AI full context on every at-risk task -- overdue, due soon,
   or sitting unresolved today -- and gets back a PROPOSED reschedule
   plan, never applied directly. Every suggested move is shown in a
   review modal the student approves/denies per-row (see
   openAiRescheduleModal/applyAiReschedule below) before anything
   actually changes, same "AI suggests, you decide" posture as the rest
   of this app's AI integration. */
let aiReschedulePlan = []; // [{id, newScheduledDate, reason, task}] from the most recent proposal, backing the review modal
let aiRescheduleQuote = ''; // a short, contextual encouragement the AI returns alongside the plan

function candidateTasksForAiReschedule() {
  const today = DB.todayISO();
  const horizon = DB.addDaysISO(today, 7);
  return activeTasks().filter(t =>
    !t.isTemplate && !t.startTime && !isResolvedStatus(t.status) &&
    ((t.dueDate && DB.isoCompare(t.dueDate, horizon) <= 0) ||
      t.scheduledDate === today ||
      (t.scheduledDate && DB.isoCompare(t.scheduledDate, today) < 0))
  );
}

async function runAiSmartReschedule() {
  const state = DB.get();
  if (!AI.isConfigured(state)) { showToast('Add an API key in Settings first.'); return; }
  const candidates = candidateTasksForAiReschedule();
  if (!candidates.length) { showToast('Nothing at risk enough to reschedule right now. 🎉'); return; }

  const btn = el('aiRescheduleBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '🤖 Thinking...';
  try {
    const { quote, moves } = await AI.suggestReschedulePlan(state, candidates);
    if (!moves.length) { showToast('AI found nothing worth moving.'); return; }
    const byId = new Map(candidates.map(t => [t.id, t]));
    aiReschedulePlan = moves.filter(m => byId.has(m.id)).map(m => Object.assign({}, m, { task: byId.get(m.id) }));
    aiRescheduleQuote = quote || '';
    renderAiRescheduleRows();
    showModal('aiRescheduleModalBackdrop');
  } catch (err) {
    showToast(`AI reschedule failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function renderAiRescheduleRows() {
  el('aiRescheduleQuote').classList.toggle('hidden', !aiRescheduleQuote);
  el('aiRescheduleQuote').textContent = aiRescheduleQuote ? `💬 ${aiRescheduleQuote}` : '';
  const container = el('aiRescheduleRowsContainer');
  container.innerHTML = aiReschedulePlan.map(m => `
    <div class="ai-reschedule-row">
      <input type="checkbox" checked class="ai-reschedule-check" data-task-id="${m.id}">
      <div class="ai-reschedule-info">
        <div class="ai-reschedule-title">${escapeHtml(m.task.title)} <span class="pill pill-xs ${statusClass(m.task.status)}">${escapeHtml(m.task.type)}</span></div>
        <div class="ai-reschedule-dates">${m.task.scheduledDate ? DB.fmtDate(m.task.scheduledDate) : 'Unscheduled'} → <strong>${DB.fmtDate(m.newScheduledDate)}</strong></div>
        <div class="ai-reschedule-reason hint">${escapeHtml(m.reason)}</div>
      </div>
    </div>`).join('');
  container.querySelectorAll('.ai-reschedule-check').forEach(cb => cb.addEventListener('change', updateAiRescheduleSelectedCount));
  updateAiRescheduleSelectedCount();
}

function updateAiRescheduleSelectedCount() {
  const n = el('aiRescheduleRowsContainer').querySelectorAll('.ai-reschedule-check:checked').length;
  el('aiRescheduleSelectedCount').textContent = `${n} of ${aiReschedulePlan.length} selected`;
  el('applyAiRescheduleBtn').disabled = n === 0;
}

function applyAiReschedule() {
  const checkedIds = new Set(Array.from(el('aiRescheduleRowsContainer').querySelectorAll('.ai-reschedule-check:checked')).map(cb => cb.dataset.taskId));
  const toApply = aiReschedulePlan.filter(m => checkedIds.has(m.id));
  if (!toApply.length) return;
  DB.snapshotForUndo('AI Reschedule');
  toApply.forEach(m => {
    const fresh = DB.get().tasks.find(t => t.id === m.id);
    if (!fresh) return;
    DB.upsertTask(Object.assign({}, fresh, { scheduledDate: m.newScheduledDate }));
  });
  aiReschedulePlan = [];
  aiRescheduleQuote = '';
  hideModal('aiRescheduleModalBackdrop');
  showToast(`Rescheduled ${toApply.length} task(s).`);
  showUndoBanner('AI Reschedule');
  renderAll();
}

/* ---------------- AI ADD/EDIT TASK (free text -> structured tasks) ----------------
   Same "AI suggests, you decide" posture as AI Smart Reschedule above:
   the student types whatever's on their mind in plain text, AI turns it
   into a structured proposal of NEW tasks and/or EDITs to existing ones,
   and every single item is shown on a review screen the student
   approves/denies before anything is actually created or changed. */
let aiAddTaskItems = []; // [{kind:'new', fields} | {kind:'edit', id, patch, task}] from the most recent proposal

// Open (not Done/Cancelled) tasks only, nearest-due first, capped -- the
// pool AI.suggestTasksFromText can reference when the request is clearly
// about editing something that already exists (see js/ai.js's comment
// on why this is bounded rather than the whole dataset).
const AI_ADD_TASK_CANDIDATE_CAP = 150;
function candidateTasksForAiAdd() {
  const dateKey = t => t.dueDate || t.scheduledDate || '9999-99-99';
  return activeTasks().filter(t => !t.isTemplate && !isResolvedStatus(t.status))
    .sort((a, b) => DB.isoCompare(dateKey(a), dateKey(b)))
    .slice(0, AI_ADD_TASK_CANDIDATE_CAP);
}

function openAiAddTaskModal() {
  el('aiAddTaskInput').value = '';
  el('aiAddTaskStatusLine').textContent = '';
  showModal('aiAddTaskModalBackdrop');
  el('aiAddTaskInput').focus();
}

async function runAiAddTaskGenerate() {
  const state = DB.get();
  if (!AI.isConfigured(state)) { showToast('Add an API key in Settings first.'); return; }
  const text = el('aiAddTaskInput').value.trim();
  if (!text) { el('aiAddTaskStatusLine').textContent = 'Type something first.'; return; }

  const statusLine = el('aiAddTaskStatusLine');
  const btn = el('aiAddTaskGenerateBtn');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '✨ Thinking...';
  statusLine.textContent = '';
  try {
    const candidates = candidateTasksForAiAdd();
    const items = await AI.suggestTasksFromText(state, text, candidates);
    if (!items.length) { statusLine.textContent = "AI didn't find anything to add or change -- try rephrasing."; return; }
    const byId = new Map(candidates.map(t => [t.id, t]));
    // An EDIT referencing a task id the candidate pool no longer has by
    // the time we get here (deleted/resolved mid-request) is dropped
    // rather than shown broken.
    aiAddTaskItems = items
      .map(it => it.kind === 'edit' ? Object.assign({}, it, { task: byId.get(it.id) }) : it)
      .filter(it => it.kind !== 'edit' || it.task);
    if (!aiAddTaskItems.length) { statusLine.textContent = 'AI only referenced tasks that are no longer available -- try rephrasing.'; return; }
    hideModal('aiAddTaskModalBackdrop');
    renderAiAddTaskRows();
    showModal('aiAddTaskReviewModalBackdrop');
  } catch (err) {
    statusLine.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// One field-change line per changed key, e.g. "Due: Oct 9 → Oct 12" --
// courseName is resolved to a real course at apply time (see
// applyAiAddTasks), so it's shown here as a plain name, not an id.
function describeTaskPatch(task, patch) {
  const labels = { title: 'Title', type: 'Type', courseName: 'Course', dueDate: 'Due', scheduledDate: 'Scheduled', estHours: 'Est. Hours', priority: 'Priority', status: 'Status' };
  const fmt = (key, v) => (key === 'dueDate' || key === 'scheduledDate') ? DB.fmtDate(v) : (key === 'estHours' ? `${v}h` : v);
  const oldCourseName = task.courseId ? (courseName(task.courseId) || '') : '';
  return Object.keys(patch).map(key => {
    const oldVal = key === 'courseName' ? oldCourseName : (key === 'estHours' ? (task.estHours || '—') : (task[key] ?? '—'));
    return `<span class="ai-reschedule-reason">${labels[key] || key}: ${escapeHtml(String(fmt(key, oldVal) || '—'))} → <strong>${escapeHtml(String(fmt(key, patch[key])))}</strong></span>`;
  }).join('');
}

function renderAiAddTaskRows() {
  const container = el('aiAddTaskRowsContainer');
  container.innerHTML = aiAddTaskItems.map((it, i) => {
    if (it.kind === 'new') {
      const f = it.fields;
      const metaBits = [
        f.courseName ? `Course: ${escapeHtml(f.courseName)}` : '',
        f.dueDate ? `Due: ${DB.fmtDate(f.dueDate)}` : '',
        f.scheduledDate ? `Scheduled: ${DB.fmtDate(f.scheduledDate)}` : '',
        f.estHours ? `Est: ${f.estHours}h` : '',
        `Priority: ${f.priority}`,
      ].filter(Boolean).join(' · ');
      return `<div class="ai-reschedule-row">
        <input type="checkbox" checked class="ai-addtask-check" data-index="${i}">
        <div class="ai-reschedule-info">
          <div class="ai-reschedule-title"><span class="pill pill-xs pill-todo">New Task</span> ${escapeHtml(f.title)} <span class="pill pill-xs">${escapeHtml(f.type)}</span></div>
          <div class="ai-reschedule-dates hint">${metaBits}</div>
        </div>
      </div>`;
    }
    return `<div class="ai-reschedule-row">
      <input type="checkbox" checked class="ai-addtask-check" data-index="${i}">
      <div class="ai-reschedule-info">
        <div class="ai-reschedule-title"><span class="pill pill-xs pill-blocked">Edit</span> ${escapeHtml(it.task.title)} <span class="pill pill-xs ${statusClass(it.task.status)}">${escapeHtml(it.task.type)}</span></div>
        <div class="ai-reschedule-dates">${describeTaskPatch(it.task, it.patch)}</div>
      </div>
    </div>`;
  }).join('');
  container.querySelectorAll('.ai-addtask-check').forEach(cb => cb.addEventListener('change', updateAiAddTaskSelectedCount));
  updateAiAddTaskSelectedCount();
}

function updateAiAddTaskSelectedCount() {
  const n = el('aiAddTaskRowsContainer').querySelectorAll('.ai-addtask-check:checked').length;
  el('aiAddTaskSelectedCount').textContent = `${n} of ${aiAddTaskItems.length} selected`;
  el('applyAiAddTaskBtn').disabled = n === 0;
}

function applyAiAddTasks() {
  const checkedIndexes = new Set(Array.from(el('aiAddTaskRowsContainer').querySelectorAll('.ai-addtask-check:checked')).map(cb => parseInt(cb.dataset.index, 10)));
  const toApply = aiAddTaskItems.filter((it, i) => checkedIndexes.has(i));
  if (!toApply.length) return;
  DB.snapshotForUndo('AI Add/Edit Tasks');
  let created = 0, updated = 0;
  toApply.forEach(it => {
    if (it.kind === 'new') {
      const f = it.fields;
      const courseId = f.courseName ? findOrCreateCourseByName(f.courseName) : '';
      const task = DB.mkTask({
        title: f.title,
        type: f.type,
        courseId,
        dueDate: f.dueDate || f.scheduledDate || null,
        scheduledDate: f.scheduledDate || f.dueDate || null,
        estHours: f.estHours,
        priority: f.priority,
      });
      DB.upsertTask(task);
      created++;
    } else {
      const fresh = DB.get().tasks.find(t => t.id === it.id);
      if (!fresh) return;
      const patch = Object.assign({}, it.patch);
      if (patch.courseName !== undefined) {
        patch.courseId = patch.courseName ? findOrCreateCourseByName(patch.courseName) : fresh.courseId;
        delete patch.courseName;
      }
      DB.upsertTask(Object.assign({}, fresh, patch));
      updated++;
    }
  });
  aiAddTaskItems = [];
  hideModal('aiAddTaskReviewModalBackdrop');
  showToast(`AI tasks -- ${created} added, ${updated} updated.`);
  showUndoBanner('AI Add/Edit Tasks');
  renderAll();
}

/* ---------------- CALENDARS (import / subscribe / enable-disable) ---------------- */
const CALENDAR_PALETTE = ['#3b82f6', '#ec4899', '#f59e0b', '#06b6d4', '#8b5cf6', '#30a46c'];

function importCalendarEvents(calendar, icsText) {
  let rows;
  try {
    rows = IStudiez.parseCalendarICS(icsText);
  } catch (e) {
    showToast('Could not parse that calendar: ' + e.message);
    return 0;
  }
  rows.forEach(r => {
    const base = {
      title: r.title, type: r.type, courseId: '',
      notes: r.notes, startTime: r.startTime || null, endTime: r.endTime || null,
      calendarId: calendar.id, energy: 'medium', priority: 'Medium', status: 'To Do',
    };
    const task = r.recurrence
      ? DB.mkTask(Object.assign({}, base, { dueDate: r.recurrence.startDate, scheduledDate: r.recurrence.startDate, isTemplate: true, recurrence: r.recurrence }))
      : DB.mkTask(Object.assign({}, base, { dueDate: r.dueDate, scheduledDate: r.scheduledDate }));
    DB.upsertTask(task);
  });
  Recurrence.generateUpcoming(DB.get());
  return rows.length;
}

function handleCalendarFileImport(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const color = CALENDAR_PALETTE[(DB.get().calendars || []).length % CALENDAR_PALETTE.length];
    const calendar = DB.mkCalendar({ name: file.name.replace(/\.ics$/i, ''), source: 'file', color });
    DB.upsertCalendar(calendar);
    const count = importCalendarEvents(calendar, reader.result);
    showToast(`Imported "${calendar.name}" -- ${count} event(s).`);
    renderAll();
  };
  reader.onerror = () => showToast('Could not read that file.');
  reader.readAsText(file);
}

function handleCalendarUrlSubscribe() {
  const url = el('calendarUrlInput').value.trim();
  if (!url) { showToast('Enter a .ics feed URL first.'); return; }
  let name = 'Subscribed Calendar';
  try { name = new URL(url).hostname; } catch (e) { /* keep default name */ }

  showToast('Fetching calendar feed...');
  fetch(url)
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); })
    .then(text => {
      const color = CALENDAR_PALETTE[(DB.get().calendars || []).length % CALENDAR_PALETTE.length];
      const calendar = DB.mkCalendar({ name, source: 'url', url, color });
      DB.upsertCalendar(calendar);
      const count = importCalendarEvents(calendar, text);
      el('calendarUrlInput').value = '';
      showToast(`Subscribed to "${name}" -- ${count} event(s).`);
      renderAll();
    })
    .catch(() => {
      showToast('Could not fetch that feed directly -- most providers block this from a browser (CORS). Download the .ics file yourself and use "Import File" instead.');
    });
}

function refreshCalendar(id) {
  const cal = DB.get().calendars.find(c => c.id === id);
  if (!cal || cal.source !== 'url') return;
  showToast('Refreshing...');
  fetch(cal.url)
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); })
    .then(text => {
      DB.clearCalendarEvents(id);
      const count = importCalendarEvents(cal, text);
      showToast(`Refreshed "${cal.name}" -- ${count} event(s).`);
      renderAll();
    })
    .catch(() => showToast('Refresh failed -- the feed may be unreachable or blocked by CORS.'));
}

function toggleCalendarEnabled(id, enabled) {
  const cal = DB.get().calendars.find(c => c.id === id);
  if (!cal) return;
  cal.enabled = enabled;
  DB.upsertCalendar(cal);
  renderAll();
}

function deleteCalendarConfirm(id) {
  const cal = DB.get().calendars.find(c => c.id === id);
  if (!cal) return;
  const count = DB.get().tasks.filter(t => t.calendarId === id).length;
  if (!confirm(`Delete "${cal.name}" and all ${count} of its imported events?`)) return;
  DB.deleteCalendar(id);
  showToast('Calendar deleted.');
  renderAll();
}

/* ---------------- SETTINGS ---------------- */
function applyTheme(theme) {
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : (theme === 'dark' ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', resolved);
}

// Pushes the current saved settings into every Settings-view input --
// shared by init and every path that can replace the whole state out
// from under those inputs (restore backup, restore auto-backup, load
// real iStudiez data).
function syncSettingsInputs() {
  const settings = DB.get().settings;
  el('themeInput').value = settings.theme || 'light';
  el('capacityInput').value = settings.capacityHoursPerWeek || 30;
  el('pomodoroFocusInput').value = settings.pomodoroFocusMinutes || 25;
  el('pomodoroBreakInput').value = settings.pomodoroBreakMinutes || 5;
  el('pomodoroNotifyToggle').checked = !!settings.pomodoroDesktopNotify;
  const ai = settings.ai || {};
  el('aiProviderInput').value = ai.provider || 'anthropic';
  el('aiApiKeyInput').value = ai.apiKey || '';
  el('aiTestStatusLine').textContent = '';
  const canvas = settings.canvas || {};
  el('canvasBaseUrlInput').value = canvas.baseUrl || '';
  el('canvasApiTokenInput').value = canvas.apiToken || '';
  el('canvasAutosyncInput').checked = !!canvas.autosync;
  el('canvasScheduleLeadDaysInput').value = canvas.scheduleLeadDays != null ? canvas.scheduleLeadDays : 2;
  el('canvasImportUndatedInput').checked = !!canvas.importUndated;
  el('canvasImportWeeksAheadInput').value = canvas.importWeeksAhead != null ? canvas.importWeeksAhead : 1;
  el('canvasTestStatusLine').textContent = '';
  el('canvasSyncAllStatusLine').textContent = canvas.lastSyncAt ? `Last synced ${new Date(canvas.lastSyncAt).toLocaleString()}` : '';
  el('appVersionLine').textContent = `v${APP_VERSION}`;
}

// Shared by both restore paths (hidden <input type="file"> + FileReader
// in a plain browser, native Open dialog + tauri-plugin-fs inside Tauri).
function applyRestoredBackupText(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed.tasks || !parsed.courses || !parsed.quarters) throw new Error('Missing expected keys.');
    DB.replaceAll(parsed);
    applyTheme(DB.get().settings.theme || 'light');
    syncSettingsInputs();
    showToast('Backup restored.');
    renderAll();
  } catch (err) {
    showToast('Invalid backup file: ' + err.message);
  }
}

function markBackupExported() {
  localStorage.setItem(LAST_EXPORT_KEY, String(Date.now()));
  dismissedBackupReminderUntil = 0; // a fresh export supersedes any pending dismissal
  updateBackupReminder();
}

async function exportBackup() {
  const data = JSON.stringify(DB.get(), null, 2);
  const filename = `doOS_backup_${DB.todayISO()}.json`;

  // Inside Tauri, use the real native Save dialog + a real file write
  // instead of the browser's Blob-download trick -- same outcome, but it
  // feels like an actual desktop app and the user picks where it lands.
  if (DB.isTauriEnv && DB.isTauriEnv() && window.__TAURI__ && window.__TAURI__.dialog) {
    try {
      const path = await window.__TAURI__.dialog.save({ defaultPath: filename, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!path) return; // user cancelled
      await window.__TAURI__.fs.writeTextFile(path, data);
      markBackupExported();
      showToast('Backup saved.');
      return;
    } catch (e) {
      console.warn('doOS: native save dialog failed, falling back to browser download', e);
    }
  }

  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  markBackupExported();
  showToast('Backup downloaded.');
}

/* ---------------- BACKUP SAFETY NET ----------------
   Every DB mutation already saves to localStorage synchronously (see
   db.js) -- there's no "unsaved changes" window a closed tab could lose.
   What this section protects against instead: (1) a save silently
   failing (quota/private-browsing), surfaced via DB.setSaveErrorHandler
   below, and (2) the user never having an out-of-browser copy, which is
   the one thing local storage genuinely cannot survive (clearing site
   data, a new device, a reinstalled browser). */
const LAST_EXPORT_KEY = 'doos_last_export_at';
const BACKUP_REMINDER_STALE_DAYS = 3;
let dismissedBackupReminderUntil = 0;

function daysSinceLastExport() {
  const raw = localStorage.getItem(LAST_EXPORT_KEY);
  if (!raw) return Infinity;
  return (Date.now() - parseInt(raw, 10)) / 86400000;
}

function hasMeaningfulData() {
  const s = DB.get();
  return s.tasks.length > 0 || s.courses.length > 0 || s.quarters.length > 0;
}

function isBackupStale() {
  return hasMeaningfulData() && daysSinceLastExport() >= BACKUP_REMINDER_STALE_DAYS;
}

function updateBackupReminder() {
  const stale = isBackupStale();
  el('settingsBackupDot').classList.toggle('hidden', !stale);
  const banner = el('backupReminderBanner');
  const dismissed = Date.now() < dismissedBackupReminderUntil;
  banner.classList.toggle('hidden', !stale || dismissed);

  const statusLine = el('backupStatusLine');
  if (statusLine) {
    const raw = localStorage.getItem(LAST_EXPORT_KEY);
    statusLine.textContent = raw
      ? `Last backup: ${new Date(parseInt(raw, 10)).toLocaleString()}`
      : 'Last backup: never -- export one below.';
    statusLine.style.color = stale ? 'var(--yellow)' : 'var(--text)';
  }
}

async function renderAutoBackupsList() {
  const container = el('autoBackupList');
  if (!container) return;
  const backups = await DB.getAutoBackups();
  if (!backups.length) {
    container.innerHTML = `<div class="empty-note">No local snapshots yet -- they build up automatically as you use doOS.</div>`;
    return;
  }
  container.innerHTML = backups.map(b => {
    const d = new Date(b.at);
    const counts = b.data ? `${(b.data.tasks || []).length} tasks, ${(b.data.courses || []).length} courses` : '';
    return `<div class="auto-backup-row">
      <span>${d.toLocaleString()}</span>
      <span class="hint">${counts}</span>
      <button class="btn btn-ghost btn-sm" onclick="restoreAutoBackupConfirm(${b.at})">Restore</button>
    </div>`;
  }).join('');
}

async function restoreAutoBackupConfirm(at) {
  if (!confirm('Restore doOS to this local snapshot? This replaces everything currently in the app with that snapshot.')) return;
  const ok = await DB.restoreAutoBackup(at);
  if (ok) {
    applyTheme(DB.get().settings.theme || 'light');
    syncSettingsInputs();
    showToast('Restored from local snapshot.');
    renderAll();
  } else {
    showToast('Could not find that snapshot.');
  }
}

/* ---------------- INIT ---------------- */
document.addEventListener('DOMContentLoaded', async () => {
  DB.setSaveErrorHandler(() => {
    showToast('⚠️ Could not save locally -- storage may be full or restricted. Export a backup now!');
  });
  // No-op in a plain browser; inside the Tauri desktop build this pulls
  // the durable on-disk copy into localStorage first so the rest of
  // init (and every other call site in this app) can keep treating
  // DB.load()/DB.get() as synchronous, same as always.
  await DB.hydrateFromTauri();
  DB.load();
  Recurrence.generateUpcoming(DB.get());
  applyTheme(DB.get().settings.theme);
  syncSettingsInputs();
  populateTypeFilterOptions();
  populateCourseTypeOptions();

  // Live display refresh for the active clock-in session -- see the
  // TIME TRACKING / POMODORO section above for why this is purely a
  // display tick and not the source of truth. Set up once, here, so it
  // is never recreated on a render.
  setInterval(tickActiveSession, 1000);
  el('aswClockOutBtn').addEventListener('click', clockOutActiveSession);
  el('aiInsightsRefreshBtn').addEventListener('click', () => fetchAiInsights(true));
  el('workloadRecalcBtn').addEventListener('click', () => {
    // Forces a fresh recompute end to end (recurrence chain advance, then
    // the Daily Workload card) rather than trusting whatever's already in
    // the DOM -- a manual escape hatch for "this number looks stale/wrong"
    // instead of a full page reload.
    Recurrence.generateUpcoming(DB.get());
    renderDashboard();
    const match = el('workloadMeter').textContent.match(/([\d.]+)h scheduled/);
    showToast(match ? `Recalculated: ${match[1]}h scheduled today.` : 'Workload recalculated.');
  });
  setupTauriIntegrations();

  // nav
  document.querySelectorAll('.nav-link').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  const startView = (location.hash || '').replace('#', '') || 'dashboard';
  switchView(VIEWS.includes(startView) ? startView : 'dashboard');

  // quick add / section add buttons
  el('quickAddBtn').addEventListener('click', () => openTaskModal(null));
  el('tasksAddBtn').addEventListener('click', () => openTaskModal(null));
  el('coursesAddBtn').addEventListener('click', () => openCourseModal(null));
  el('quartersAddBtn').addEventListener('click', () => openQuarterModal(null));
  el('habitsAddBtn').addEventListener('click', () => openHabitModal(null));

  // modal close (× autosaves, Cancel discards, clicking outside autosaves)
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.autosave) closeModalWithAutosave(btn.dataset.close);
      else hideModal(btn.dataset.close);
    });
  });
  document.querySelectorAll('.modal-backdrop').forEach(bd => {
    bd.addEventListener('click', e => { if (e.target === bd) closeModalWithAutosave(bd.id); });
  });

  // task modal
  el('saveTaskBtn').addEventListener('click', saveTaskFromForm);
  el('deleteTaskBtn').addEventListener('click', () => deleteTaskConfirm(el('taskId').value));
  el('cancelTaskBtn').addEventListener('click', () => cancelTaskConfirm(el('taskId').value));
  el('uncancelTaskBtn').addEventListener('click', () => uncancelTask(el('taskId').value));
  el('recurrenceActionJustThisBtn').addEventListener('click', () => resolveRecurrenceAction('one'));
  el('recurrenceActionAllFutureBtn').addEventListener('click', () => resolveRecurrenceAction('future'));
  el('taskRecurs').addEventListener('change', () => el('recurrenceOptions').classList.toggle('hidden', !el('taskRecurs').checked));
  el('recFreq').addEventListener('change', updateRecurrenceUIVisibility);
  el('splitTaskBtn').addEventListener('click', splitCurrentTask);
  el('addSubtaskBtn').addEventListener('click', addSubtaskRow);
  ['taskName', 'taskEstHours'].forEach(id => el(id).addEventListener('input', refreshEstimateHint));
  ['taskType', 'taskCourse', 'taskStartTime'].forEach(id => el(id).addEventListener('change', refreshEstimateHint));
  el('taskType').addEventListener('change', () => { updateTaskEstHoursLabel(); nudgePriorityForGoalType(); });
  el('aiEstimateBtn').addEventListener('click', askAiForEstimate);
  el('taskDueDate').addEventListener('change', () => {
    if (!scheduledDateTouched) el('taskScheduledDate').value = el('taskDueDate').value;
  });
  el('taskScheduledDate').addEventListener('input', () => { scheduledDateTouched = true; });

  // course modal
  el('saveCourseBtn').addEventListener('click', saveCourseFromForm);
  el('deleteCourseBtn').addEventListener('click', () => deleteCourseConfirm(el('courseId').value));
  el('addExamBtn').addEventListener('click', addExamRow);
  el('addMeetingBtn').addEventListener('click', addMeetingRow);
  el('courseCanvasSyncBtn').addEventListener('click', () => runCanvasSync(el('courseId').value));
  el('courseColor').addEventListener('input', () => renderColorPresets(el('courseColor').value));

  // smart plan
  el('smartPlanBtn').addEventListener('click', runSmartPlan);
  el('smartReplanBtn').addEventListener('click', runSmartReplan);
  el('aiRescheduleBtn').addEventListener('click', runAiSmartReschedule);
  el('applyAiRescheduleBtn').addEventListener('click', applyAiReschedule);
  el('aiAddTaskBtn').addEventListener('click', openAiAddTaskModal);
  el('aiAddTaskGenerateBtn').addEventListener('click', runAiAddTaskGenerate);
  el('applyAiAddTaskBtn').addEventListener('click', applyAiAddTasks);

  // quarter modal
  el('saveQuarterBtn').addEventListener('click', saveQuarterFromForm);
  el('deleteQuarterBtn').addEventListener('click', () => deleteQuarterConfirm(el('quarterId').value));

  // habit modal
  el('saveHabitBtn').addEventListener('click', saveHabitFromForm);
  el('deleteHabitBtn').addEventListener('click', () => deleteHabitConfirm(el('habitId').value));
  el('habitGoalType').addEventListener('change', updateHabitGoalUIVisibility);

  // dashboard
  document.querySelectorAll('#remainingWorkloadRangeToggle .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      remainingWorkloadRange = btn.dataset.range;
      document.querySelectorAll('#remainingWorkloadRangeToggle .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderDashboard();
    });
  });

  // kanban
  document.querySelectorAll('#kanbanModeToggle .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      kanbanMode = btn.dataset.mode;
      document.querySelectorAll('#kanbanModeToggle .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      const showNav = kanbanMode === 'day' || kanbanMode === 'week';
      el('kanbanPrev').classList.toggle('hidden', !showNav);
      el('kanbanToday').classList.toggle('hidden', !showNav);
      el('kanbanNext').classList.toggle('hidden', !showNav);
      renderKanban();
    });
  });
  el('kanbanPrev').classList.add('hidden');
  el('kanbanToday').classList.add('hidden');
  el('kanbanNext').classList.add('hidden');
  el('kanbanPrev').addEventListener('click', () => {
    if (kanbanMode === 'day') kanbanDayOffset--; else kanbanWeekOffset--;
    renderKanban();
  });
  el('kanbanNext').addEventListener('click', () => {
    if (kanbanMode === 'day') kanbanDayOffset++; else kanbanWeekOffset++;
    renderKanban();
  });
  el('kanbanToday').addEventListener('click', () => {
    kanbanDayOffset = 0;
    kanbanWeekOffset = 0;
    renderKanban();
  });

  // calendar
  document.querySelectorAll('#calendarModeToggle .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      calendarMode = btn.dataset.mode;
      document.querySelectorAll('#calendarModeToggle .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderCalendar();
    });
  });
  el('calPrevWeek').addEventListener('click', () => {
    if (calendarMode === 'day') calendarDayOffset--;
    else if (calendarMode === 'month') calendarMonthOffset--;
    else calendarWeekOffset--;
    renderCalendar();
  });
  el('calNextWeek').addEventListener('click', () => {
    if (calendarMode === 'day') calendarDayOffset++;
    else if (calendarMode === 'month') calendarMonthOffset++;
    else calendarWeekOffset++;
    renderCalendar();
  });
  el('calToday').addEventListener('click', () => {
    calendarWeekOffset = 0; calendarDayOffset = 0; calendarMonthOffset = 0;
    renderCalendar();
  });

  el('habitsPrevRange').addEventListener('click', () => {
    habitHeatmapPageOffset++;
    renderHabits();
  });
  el('habitsNextRange').addEventListener('click', () => {
    habitHeatmapPageOffset = Math.max(0, habitHeatmapPageOffset - 1);
    renderHabits();
  });

  // filters
  ['filterCourse', 'filterType', 'filterStatus', 'filterEnergy', 'filterNeedHelp', 'filterHideDone', 'filterCanvasHidden'].forEach(id => {
    el(id).addEventListener('change', renderTasksTable);
  });
  el('filterSearch').addEventListener('input', renderTasksTable);

  // settings
  el('themeInput').addEventListener('change', () => {
    const theme = el('themeInput').value;
    DB.get().settings.theme = theme;
    DB.save();
    applyTheme(theme);
  });
  // Live-follows the OS theme while 'system' is selected -- no reload needed.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (DB.get().settings.theme === 'system') applyTheme('system');
  });
  el('pomodoroNotifyToggle').addEventListener('change', () => {
    DB.get().settings.pomodoroDesktopNotify = el('pomodoroNotifyToggle').checked;
    DB.save();
  });
  el('capacityInput').addEventListener('change', () => {
    const parsed = parseFloat(el('capacityInput').value);
    const capacity = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
    DB.get().settings.capacityHoursPerWeek = capacity;
    el('capacityInput').value = capacity;
    DB.save();
    renderDashboard();
  });
  el('pomodoroFocusInput').addEventListener('change', () => {
    const parsed = parseInt(el('pomodoroFocusInput').value, 10);
    const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
    DB.get().settings.pomodoroFocusMinutes = minutes;
    el('pomodoroFocusInput').value = minutes;
    DB.save();
  });
  el('pomodoroBreakInput').addEventListener('change', () => {
    const parsed = parseInt(el('pomodoroBreakInput').value, 10);
    const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
    DB.get().settings.pomodoroBreakMinutes = minutes;
    el('pomodoroBreakInput').value = minutes;
    DB.save();
  });
  function saveAiSettingsFromForm() {
    const provider = el('aiProviderInput').value;
    const apiKey = el('aiApiKeyInput').value.trim();
    DB.get().settings.ai = (provider && apiKey) ? { provider, apiKey } : { provider, apiKey: '' };
    DB.save();
  }
  el('aiProviderInput').addEventListener('change', saveAiSettingsFromForm);
  el('aiApiKeyInput').addEventListener('change', saveAiSettingsFromForm);
  el('aiKeyToggleBtn').addEventListener('click', () => {
    const input = el('aiApiKeyInput');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    el('aiKeyToggleBtn').textContent = showing ? 'Show' : 'Hide';
  });
  el('aiTestConnectionBtn').addEventListener('click', async () => {
    const statusLine = el('aiTestStatusLine');
    saveAiSettingsFromForm();
    if (!AI.isConfigured(DB.get())) {
      statusLine.textContent = 'Pick a provider and paste in an API key first.';
      return;
    }
    const provider = DB.get().settings.ai.provider;
    statusLine.textContent = `Testing ${AI.providerLabel(provider)}...`;
    try {
      const reply = await AI.complete(DB.get(), 'Reply with exactly: OK');
      statusLine.textContent = `✅ ${AI.providerLabel(provider)} responded: ${reply.trim().slice(0, 80)}`;
    } catch (err) {
      statusLine.textContent = `❌ ${err.message}`;
    }
  });
  el('aiBulkEstimateBtn').addEventListener('click', runBulkAiEstimate);
  el('aiBulkEstimateCancelBtn').addEventListener('click', () => { aiBulkEstimateCancelled = true; });
  function saveCanvasSettingsFromForm() {
    const baseUrl = el('canvasBaseUrlInput').value.trim();
    const apiToken = el('canvasApiTokenInput').value.trim();
    const prev = DB.get().settings.canvas || {};
    DB.get().settings.canvas = {
      baseUrl, apiToken,
      autosync: !!prev.autosync,
      lastSyncAt: prev.lastSyncAt || null,
      scheduleLeadDays: prev.scheduleLeadDays != null ? prev.scheduleLeadDays : 2,
      importUndated: !!prev.importUndated,
      importWeeksAhead: prev.importWeeksAhead != null ? prev.importWeeksAhead : 1,
    };
    DB.save();
  }
  el('canvasBaseUrlInput').addEventListener('change', saveCanvasSettingsFromForm);
  el('canvasApiTokenInput').addEventListener('change', saveCanvasSettingsFromForm);
  el('canvasAutosyncInput').addEventListener('change', () => {
    saveCanvasSettingsFromForm();
    DB.get().settings.canvas.autosync = el('canvasAutosyncInput').checked;
    DB.save();
  });
  el('canvasScheduleLeadDaysInput').addEventListener('change', () => {
    saveCanvasSettingsFromForm();
    const n = parseInt(el('canvasScheduleLeadDaysInput').value, 10);
    DB.get().settings.canvas.scheduleLeadDays = Number.isFinite(n) && n >= 0 ? n : 2;
    DB.save();
  });
  el('canvasImportUndatedInput').addEventListener('change', () => {
    saveCanvasSettingsFromForm();
    DB.get().settings.canvas.importUndated = el('canvasImportUndatedInput').checked;
    DB.save();
  });
  el('canvasImportWeeksAheadInput').addEventListener('change', () => {
    saveCanvasSettingsFromForm();
    const n = parseInt(el('canvasImportWeeksAheadInput').value, 10);
    DB.get().settings.canvas.importWeeksAhead = Number.isFinite(n) && n > 0 ? n : 1;
    DB.save();
  });
  el('canvasTokenToggleBtn').addEventListener('click', () => {
    const input = el('canvasApiTokenInput');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    el('canvasTokenToggleBtn').textContent = showing ? 'Show' : 'Hide';
  });
  el('canvasTestConnectionBtn').addEventListener('click', async () => {
    const statusLine = el('canvasTestStatusLine');
    saveCanvasSettingsFromForm();
    if (!Canvas.isConfigured(DB.get())) {
      statusLine.textContent = 'Enter your Canvas URL and access token first.';
      return;
    }
    statusLine.textContent = 'Testing Canvas...';
    try {
      const name = await Canvas.testConnection(DB.get());
      statusLine.textContent = `✅ Connected as ${name}`;
    } catch (err) {
      statusLine.textContent = `❌ ${err.message}`;
    }
  });
  el('canvasSyncAllBtn').addEventListener('click', () => runCanvasSyncAll());
  el('canvasSyncAllBtnDash').addEventListener('click', () => runCanvasSyncAll());
  el('canvasSyncAllBtnInbox').addEventListener('click', () => runCanvasSyncAll());
  el('exportJsonBtn').addEventListener('click', exportBackup);
  el('calendarFileInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) handleCalendarFileImport(file);
    e.target.value = '';
  });
  el('calendarUrlSubscribeBtn').addEventListener('click', handleCalendarUrlSubscribe);
  el('importJsonInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => applyRestoredBackupText(reader.result);
    reader.readAsText(file);
  });
  el('restoreBackupBtn').addEventListener('click', async () => {
    // Inside Tauri, use the real native Open dialog + a real file read
    // instead of the hidden <input type="file"> trick.
    if (DB.isTauriEnv && DB.isTauriEnv() && window.__TAURI__ && window.__TAURI__.dialog) {
      try {
        const path = await window.__TAURI__.dialog.open({ multiple: false, filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (!path) return; // user cancelled
        const text = await window.__TAURI__.fs.readTextFile(path);
        applyRestoredBackupText(text);
        return;
      } catch (e) {
        console.warn('doOS: native open dialog failed, falling back to browser file picker', e);
      }
    }
    el('importJsonInput').click();
  });
  el('resetDataBtn').addEventListener('click', () => {
    // DB.clearAll() keeps theme/capacity/pomodoro/AI/Canvas settings --
    // this warning is specifically about the academic data, which is
    // the part that's actually gone for good (plus local auto-backup
    // snapshots, so an old one can't quietly undo this).
    const staleWarning = isBackupStale() ? ' You have not exported a backup recently -- consider doing that first.' : '';
    if (!confirm(`This permanently deletes every term, course, task, habit, and calendar in doOS, including local auto-backup snapshots. Your theme, capacity, and AI/Canvas settings are kept.${staleWarning} Continue?`)) return;
    DB.clearAll();
    showToast('All data cleared.');
    renderAll();
  });
  el('loadSampleSeedBtn').addEventListener('click', () => {
    if (typeof SAMPLE_SEED_DATA === 'undefined') { showToast('No bundled example data found in this copy of doOS.'); return; }
    if (!confirm('This replaces everything currently in doOS with the example term/courses/tasks. Continue?')) return;
    DB.replaceAll(JSON.parse(JSON.stringify(SAMPLE_SEED_DATA)));
    applyTheme(DB.get().settings.theme || 'light');
    syncSettingsInputs();
    showToast('Loaded example data.');
    renderAll();
  });

  // backup reminder banner
  el('backupReminderExportBtn').addEventListener('click', exportBackup);
  el('backupReminderDismissBtn').addEventListener('click', () => {
    dismissedBackupReminderUntil = Date.now() + 24 * 60 * 60 * 1000;
    updateBackupReminder();
  });

  // batch-undo banner
  el('undoBatchBtn').addEventListener('click', () => {
    const label = DB.undoLastBatch();
    hideUndoBanner();
    if (label) { showToast(`Undid: ${label}.`); renderAll(); }
  });
  el('dismissUndoBatchBtn').addEventListener('click', hideUndoBanner);

  // Browsers won't let a page truly block closing (and won't show a custom
  // message -- Chrome/Firefox replace it with a generic "Leave site?"
  // prompt), but this at least forces that confirmation to appear when
  // there's real data and no recent export, giving a last chance to back up.
  window.addEventListener('beforeunload', (e) => {
    if (!isBackupStale()) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  // Canvas autosync: one throttled check right after launch, then
  // re-checked periodically for the rest of the session so a long-lived
  // tab/desktop window still eventually picks up new assignments without
  // the student ever clicking Sync -- maybeAutosyncCanvas's own throttle
  // (CANVAS_AUTOSYNC_THROTTLE_MS) is what actually paces real syncs, this
  // interval just re-checks whether that window has elapsed.
  maybeAutosyncCanvas();
  setInterval(maybeAutosyncCanvas, 5 * 60 * 1000);
});
