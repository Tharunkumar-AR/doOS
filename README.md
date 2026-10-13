# doOS — a real, dynamic Stanford student dashboard

This is **not** a pile of static CSVs. It's a working local web app: open `web/index.html` in a browser and you get a dashboard with recurring tasks, subtasks, a Day/Week/Month calendar, a drag-and-drop Kanban board, workload tracking, habit streaks, a local duration-estimate engine, and a one-time iStudiez migration path (see `istudiez_cli.py` below). Everything persists in your browser's `localStorage` — no server, no database to set up, no API keys, works completely offline.

## Run it

**Plain browser:** Double-click `web/index.html`, or open it from your browser (`File → Open`). That's the whole install process.

(If you prefer, you can also serve it — `python3 -m http.server` from the `web` folder, then visit `http://localhost:8000` — but it isn't required for anything in the app to work.)

**Desktop app (Tauri):** `cargo tauri build` from the project root produces a native installer for your current platform under `src-tauri/target/release/bundle/`. Requires Rust + the Tauri CLI (`cargo install tauri-cli --locked`) installed first. `web/` is the Tauri app's `frontendDist` — it has to live outside `src-tauri/` (which contains its own multi-gigabyte `target/` build directory) or the bundler refuses to run.

First load starts with a small set of **example** data — a fictional term, a few courses, and a handful of tasks of different types/statuses — so the dashboard isn't blank the first time you look at it (see `js/sample-seed-data.js`). It only loads once ever (tracked by its own flag, in a browser that has no real content yet), so it never silently reappears over your own data, and clearing all data later stays a real clear. Add your own term under Quarters, your own classes/clubs/jobs under Courses & Life, and your own tasks whenever you're ready — Settings → "Load Example Data" re-triggers the example layout on demand if you ever want to see it again. `js/sample-seed-data.js` contains no real person's data, so it's safe to leave in place if you hand this project to someone else.

## What's actually dynamic here

- **Recurring tasks** — mark any task "Repeats" (daily, or weekly on specific weekdays) and doOS generates one real, independently-completable instance at a time -- not a batch of future weeks up front. The *next* occurrence only appears once the current one is marked Done **or** its due date has passed, so a weekly chore doesn't clutter the Inbox with three weeks of itself at once (if you've been away a while, it catches up through whatever was missed automatically, one step at a time, the next time doOS is open). Each instance's due date comes straight from the recurrence pattern; its Scheduled Date defaults to the *same offset* the original task had between Due Date and Scheduled Date (e.g. "due Friday, work on it Wednesday" stays a 2-day gap every time), unless that particular instance is edited by hand afterward. Instances show up under their actual day everywhere (Inbox, all three Calendar views) exactly like any other task -- the recurring rule itself isn't a visible item in the Inbox; manage/edit/delete a whole series from its 🔥 streak row on the Dashboard instead.
- **Fixed-time classes** — give a task a Start/End Time and it becomes a fixed calendar block (a lecture, a section) instead of a flexible to-do. The importer does this automatically for timed events from an `.ics`.
- **Smart Plan** (Inbox view) — one click auto-schedules every unscheduled task that has a due date and an Est. Hours figure, packing it into open days between now and the deadline. It works *around* your fixed-time classes (never double-books a lecture slot) and splits a task across multiple days — as real, independently-completable task rows — when it doesn't fit in one. You can also manually split any single task into N days from its edit screen.
- **Kanban board** — drag cards between Backlog/To Do/In Progress/Blocked/Done columns, or flip to "By Day" mode and drag cards across a Monday–Sunday board to reschedule them. Uses a custom pointer-based drag engine (not native HTML5 drag-and-drop) for a snappy, cursor-following ghost instead of the browser's crude whole-pane highlighting — the same engine also drives dragging tasks onto the Calendar's hour grid.
- **Week calendar** — a real hour-by-hour time grid across all 7 days (not a stack of card-list columns): fixed classes are positioned by actual time in each day's column, flexible tasks sit in an all-day strip up top, and you can drag a flexible task straight onto any day/time slot to schedule it, same as Day view.
- **Day & Week views scroll through the full 24-hour day** — both open scrolled to around 7 AM by default, but you can scroll up for early-morning events or down for anything late at night. Scroll position is preserved across edits (e.g. scheduling a task) and only resets when you navigate to a different day/week.
- **Quarters with real progress** — each term shows an aggregate completion bar across every course inside it, plus the course list as clickable chips.
- **Courses & Life grouped by term** — courses render under a header for each quarter they belong to (newest term first), instead of one flat list, so old terms stay visually separate from your current one.
- **Standardized course colors** — the course edit screen offers 10 preset swatches alongside the native color picker, so you can pick a consistent palette across courses instead of hand-matching hex values every time.
- **Scheduled / Unscheduled split in Day view** — the sidebar is now two boxes: Unscheduled tasks (drag onto the grid to schedule) and Scheduled tasks (everything currently placed on the hour grid, listed here too — not just as a block on the grid). Unschedule a task by clicking the ✕ on its Scheduled row, or by dragging its grid block (or Scheduled row) back onto the Unscheduled box.
- **Midterms & finals per course** — add exam dates right on a course's edit screen; they show up on that course's card, on the Dashboard's "Midterms & Finals" list with a countdown, and factor into nothing silently — they're just visible everywhere that matters.
- **Class Schedule per course** — set the actual weekly meeting time(s) (days + start/end time, each optionally labeled -- Lecture, Discussion, Lab, Section, Office Hours, or anything else) on a course's edit screen. This, not "any task that happens to have a start time," is what the Dashboard's class count and workload hours go by — a task you dragged onto a time slot yourself, or an imported calendar event, is never counted as a class. These meetings show up everywhere a real class should: Today's Agenda, all three Calendar views (Day/Week/Month, read-only and recurring on their weekday automatically, click one to jump to the course), the Daily Workload window, and Smart Plan's free-hours math, so flexible work never gets planned on top of an actual class.
- **Today's Workload meter** — daily, not weekly: scheduled hours, clocked hours, and genuinely free hours, all for *today* specifically. Three distinct notions of time inside the 8am–9pm work window: "Available" (window minus events *and* tasks), "Time to Work" (window minus events only — the % denominator), and "Scheduled" (your own task hours). Color-coded green/yellow/red against your daily capacity (weekly capacity ÷ 7).
- **Habit Tracker** (its own nav tab) — a deliberately separate, simpler system from tasks: add a habit with a daily or "N times a week" goal and just mark it done/not-done per day. Shows current streak, best streak ever, a rolling completion rate, and an 18-week GitHub-style heatmap per habit. The Dashboard's "Habit Streaks" card surfaces your top habits by current streak with a one-click toggle for today.
- **Office-hours queue, overdue list, per-course progress** — all computed from your live task data, not hardcoded. (A past fixed-time class is never shown as "overdue" — it already happened, there's nothing to catch up on.)
- **iStudiez migration** — a one-time, command-line path (see `istudiez_cli.py` below) for moving your entire iStudiez history into doOS: convert a real `.ics`/`.csv`/`.istd` export to a doOS backup JSON, then load it via Settings → Restore from Backup. Recurring classes with an `RRULE` become real doOS recurring tasks; timed lecture/section blocks become fixed-time Class events, not flexible to-dos. Imported times are timezone-correct: a `DTSTART` in UTC (`...Z`) or tagged with an explicit `TZID` (e.g. `America/Los_Angeles`) is converted to *your browser's* local wall-clock time (and the date shifts too, if the conversion crosses midnight) — untagged "floating" times are taken as-is, same as before.
- **Filters & search**, a **day-grouped Inbox** (Overdue → Today → Tomorrow → each day after, color-coded by course with priority marks, no table clutter), **CRUD everywhere** through modals, **dark mode**, and **JSON backup/restore**.
- **Subtasks** — break any task into a checklist. They display as indented, independently-checkable rows nested right under their parent everywhere a task shows up (Dashboard, Inbox) — not just inside the edit modal. Check off every subtask and the parent task marks itself Done automatically, from either place.
- **Clocked hours on the Dashboard** — "Today at a Glance" shows hours actually clocked today, and the Workload meter shows hours actually clocked this week, right alongside the planned/estimated figures — both computed from real timeLog timestamps, including whatever's still running in an open session.
- **Day / Week / Month calendar views** — Week is the card-list you had before; Month is a real Google-Calendar-style grid (click any day to drill into it); Day is an hour-by-hour grid with fixed-time classes positioned by their actual time (side-by-side columns if two overlap) and flexible tasks listed alongside.
- **Drag-to-schedule, resize-to-re-estimate** (Day view) — drag any flexible task from the sidebar straight onto the hour grid and it becomes a real time block sized to its Est. Hours (snapped to 15 min). Drag an existing block's bottom edge to change its duration — that updates both its end time and its Est. Hours. Drag the block itself to move it to a new time. The planner treats anything you've placed this way the same as a real class: other auto-planning works around it.
- **Smart duration estimates** — while creating or editing a task, if you leave Est. Hours blank doOS looks at *your own* completed task history and suggests a number ("~5.5h, based on 3 past PSET tasks"), one click to accept. See below for exactly how this works and what it is **not**.
- **Estimate Accuracy insight** (Dashboard) — compares your estimates against what tasks actually took, across your whole history, so you can see if you tend to under- or over-estimate.
- **AI Assistant** (Settings, opt-in, bring your own key) — the one deliberate exception to doOS staying fully local. Paste in a Claude, Gemini, or ChatGPT API key and you get: a prominent "✨ AI Insights" card on the Dashboard (a one-line AI-written headline plus a few categorized, color-coded insight rows — ⚠️ heads up, 🎯 priority, 💡 tip, ✅ nice work — fetched only when you click "Get Today's Insights", never automatically), an "✨ Ask AI for an estimate" option in the task editor alongside the local Smart Estimate, and a "✨ Fill in missing estimates" bulk action that finds every flexible task without an Est. Hours and asks the AI to predict all of them — tens or hundreds of tasks per API call instead of one call per task, grounded in each task's type/course and your own past durations where you have any. Nothing is ever sent anywhere unless you've set a key and clicked a button that explicitly asks for it, and only small, purpose-built snippets go out — never your full task history. Claude and Gemini call their APIs directly from the browser; ChatGPT's request is fully implemented too, but see the comments in `js/ai.js` for the current, occasionally-surprising state of OpenAI's cross-origin policy.
- **Canvas Integration** (Settings, opt-in, bring your own token) — paste in your institution's Canvas URL and a personal access token, then map a Canvas course to any doOS course right from that course's edit screen and click "Sync Assignments Now" to pull its assignments in as real tasks (title, due date, description), matched on re-sync by Canvas's own assignment id so running it again updates instead of duplicating. Newly-synced assignments without an estimate get run through the same efficient batched AI pipeline as "Fill in missing estimates," grounded in the assignment's actual description text, not just its title. **Desktop app only:** Canvas's hosted instances never send the CORS headers a plain browser needs (confirmed against Instructure's own issue tracker — not configurable, no opt-in the way Anthropic's API has one), so this doesn't work in the plain browser build. The desktop (Tauri) app routes around it via `tauri-plugin-http`, which makes the actual request from the native process instead of the webview — not subject to CORS at all — so it works there.
- **Subscribe to external calendars** (Settings → Calendars) — import a `.ics` file, or try subscribing to a feed URL directly. Each imported calendar gets its own enable/disable toggle that hides/shows its events everywhere (Dashboard, Calendar, Inbox, Kanban, and the planner) with one click — see the note on CORS below before relying on live URL subscriptions.
- **Quick due-date buttons** (task editor) — "Today" / "Tomorrow" / "In 2 Days" set Due Date with one click, and Scheduled Date follows along automatically unless you've deliberately set it to something different (e.g. splitting "due Friday" from "working on it Wednesday").
- **Autosave, everywhere** — every popup (task, course, term) saves itself when you close it by clicking outside or the × — no Save button required, though it's still there if you prefer clicking it. "Cancel" is the one button that still discards instead. An empty/unnamed entry just closes without creating anything.
- **Day view: Calendar Events get their own box** — real fixed-time entries (class type, or anything from a subscribed calendar) list separately from tasks you've personally dragged onto a time slot, instead of both being lumped under "Scheduled".
- **Week view is resizable** — drag the grip in the bottom-right corner of the all-day strip or the hour grid to make either taller, so a day with a lot packed into it isn't stuck scrolling in a cramped box.
- **Clock In/Out time tracking with a built-in Pomodoro timer** — Clock In on any task row (or from its edit screen) and a floating widget tracks it everywhere in the app until you Clock Out; only one task can be "active" at a time, so clocking into a new one cleanly clocks you out of whatever was running first. Clocking in also starts a 25-min focus / 5-min break cycle (both configurable in Settings) that loops indefinitely with a toast at each phase change — but the Pomodoro phase is purely a display/notification layer, it never pauses the actual tracked time, which only stops on Clock Out. Everything (elapsed time, phase remaining) is computed from stored timestamps against the current time rather than the timer tick itself, so closing the tab or reloading mid-session and coming back resumes with the mathematically correct elapsed time, not a reset clock. Clocking out sums every one of that task's logged sessions into its Actual Hours automatically, feeding real tracked data straight into the Smart Estimate engine instead of requiring a manual number — and each logged session is still listed and editable (or deletable) afterward from the task's Time Log, re-syncing Actual Hours immediately on any change.

## Files

| File | What it does |
|---|---|
| `web/index.html` | App shell — sidebar nav, all 8 views, all modals |
| `web/css/style.css` | All styling, light + dark themes |
| `web/js/db.js` | localStorage persistence, CRUD, schema migration, blank starting state |
| `web/js/recurrence.js` | Recurring-task generator |
| `web/js/habits.js` | Habit Tracker streak/best-streak/completion-rate/heatmap logic |
| `web/js/istudiez.js` | Client-side `.ics`/`.csv` parser (RRULE- and fixed-time-aware), used by `istudiez_cli.py` |
| `web/js/estimator.js` | Local duration-estimate engine (see below) |
| `web/js/ai.js` | Opt-in AI integration (BYOK) — daily insights + AI task estimates |
| `web/js/canvas.js` | Opt-in Canvas integration (BYOK) — course mapping + assignment sync (blocked by Canvas's CORS policy until routed through native networking) |
| `web/js/ui.js` | Rendering for every view |
| `web/js/planner.js` | Smart Plan auto-scheduler + manual task splitting |
| `web/js/main.js` | Event wiring, modals, routing, settings |
| `web/js/sample-seed-data.js` | Fictional example term/courses/tasks, auto-loaded once into a brand-new empty browser — no real person's data |
| `sample_import.ics` | A generic sample calendar file, if you want to inspect the `.ics` format or feed it to the CLI tool below |
| `istudiez_cli.py` | Optional command-line batch converter: `.ics`, `.csv`, or a real `.istd` backup (see below) — not required to use the app |
| `src-tauri/` | Desktop app shell (Tauri 2.x) — native menu bar, notifications, file-backed persistence, Canvas networking workaround |

## "Smart duration estimates" — what this actually is (and isn't)

This feature specifically is **not** a connection to ChatGPT, Claude, or any hosted AI service — it never sends your data anywhere, there's no server for it to go to. It's a small local statistical model (`js/estimator.js`) built entirely from your own completed tasks. (A real, *opt-in* AI integration does exist elsewhere in the app — see "AI Assistant" above — but it's a separate, clearly-labeled feature that only activates once you paste in your own API key; it has nothing to do with this one.)

1. Every time you mark a task Done, doOS logs `{title, type, course, est. hours, actual hours}` into an append-only history list in your local data (`taskHistory`).
2. When you start a new task, it looks for a match, in order: the exact same title you've logged before → the same task type in the same course → the same task type anywhere → gives up if none of those exist yet.
3. It averages the actual hours from whatever matched and shows it as a suggestion, never auto-filling the field for you.

It needs a few completed tasks with Actual Hours filled in before it has anything to say — until then it just stays hidden. Calling this "AI" would be overselling a weighted average; it's labeled "Smart Estimate" in the UI for that reason.

## How Smart Plan actually schedules things

Click **🪄 Smart Plan** on the Inbox view. For every task with no scheduled date but a due date and an Est. Hours figure, it:

1. Takes the earliest-due, highest-priority tasks first.
2. Walks forward day by day from today to that task's due date, checking how much flexible-study time is actually free each day (your weekly capacity ÷ 7, minus any fixed-time classes that day, minus anything already scheduled).
3. Fills each day's remaining room before moving to the next, so work front-loads instead of piling up the night before.
4. If a task doesn't fit in one day, it's split into multiple real task rows ("Part 1/2", "Part 2/2", ...) each on its own day — not just a label, each part has its own checkbox and can move independently.
5. If a task genuinely can't fit anywhere before its deadline, the leftover hours land on the due date anyway, visibly overloading that day rather than silently disappearing.

It only touches tasks that are currently unscheduled — anything you've already placed on a date yourself is left alone.

## Subscribing to external calendars — what actually works

Settings → Calendars has two ways in:

- **Import .ics File** — always works. Export/download a `.ics` from Google Calendar, Outlook, Apple Calendar, anything, and import it. One-time snapshot; re-import the file later to pick up changes.
- **Subscribe (URL)** — doOS tries `fetch()`-ing the URL directly from your browser. This **will fail for most real calendar providers** — Google/Outlook/iCloud public `.ics` links are generally served without the CORS headers that let a browser read a cross-origin response, and there's no server here to work around that. When it fails you'll get a clear toast saying so, with the fallback (download the file, import it instead) spelled out. When it *does* work (some self-hosted or CORS-friendly feeds), it behaves like a live subscription with manual sync: click **↻ Refresh** on that calendar any time to re-pull it. There's no automatic background refresh — a static site with no server has no way to run on a schedule when the tab isn't open.

Every imported/subscribed calendar gets a checkbox. Unchecking it hides every event it brought in — everywhere (Dashboard, all three calendar views, Inbox, Kanban) — and the Smart Plan / free-hours calculations stop treating its events as blocked time. Deleting a calendar removes it and every event it imported.

## The Python piece: `istudiez_cli.py` (optional)

`istudiez_cli.py` is the path for moving a full iStudiez export into doOS: convert it from the command line (batch processing, scripting, or a one-time "wipe doOS and load my entire real schedule" migration) without touching the browser until the very last step.

It handles three input formats:

```bash
python3 istudiez_cli.py MyStanfordSchedule.ics
python3 istudiez_cli.py MyAssignments.csv
python3 istudiez_cli.py "iStudiez Pro Data Backup.istd"
# -> writes doos_import_backup.json
```

**The `.istd` path is the real one** — that's the actual file iStudiez Pro writes from its own Settings → Backup, a zip containing a genuine SQLite database (semesters, courses, assignments, exams, instructors). The script reads it directly with Python's built-in `sqlite3` + `zipfile` — no third-party packages. It imports your **entire term/course history** as Quarters and Courses (so old terms stay visible, correctly archived), but only turns the **currently active term's** assignments into live task rows — importing years of already-completed middle/high-school homework as individual task rows would just be clutter with zero remaining value in a day-to-day planner, not genuine fidelity.

iStudiez has no field for how long anything actually took, so Est. Hours on every imported task is this assistant's own best-effort guess from the task's title/keywords — PSET-shaped assignments land in the 6–9 hour range (varied per task, not a flat number), lighter recurring items (pre-lecture problems, reading quizzes, discussion worksheets) get smaller estimates, and generic personal to-dos get small defaults. These are starting points, not measurements — edit any of them, and once you've completed a few with real Actual Hours logged, the Smart Estimate feature takes over from your own data instead of this guess.

Then in doOS: **Settings → Restore from Backup** → select the output file. This *replaces* everything currently in the app (same as any backup restore) — it's meant for a fresh start, not an incremental merge. For incremental calendar merging without redoing a full migration, use Settings → Calendars → Import .ics File instead (events only, not full iStudiez course/task fidelity).

No pip installs needed; it's pure standard library (`argparse`, `csv`, `json`, `re`, `datetime`, `sqlite3`, `zipfile`).

## A note on data safety

Everything lives in one browser's `localStorage`. That means:
- It's tied to one browser on one machine — it won't follow you to another computer automatically.
- Clearing your browser's site data for this page wipes it.
- **Export a backup regularly** (Settings → Export Backup) — it's a plain JSON file you can keep in Drive/Dropbox/Git and restore from later or on another machine.

### What's already automatic, and what genuinely isn't

Every change you make (checking off a task, dragging an event, editing a course) saves to `localStorage` **synchronously, the instant it happens** (`js/db.js`'s `save()`) — there is no "unsaved changes" state for a closed tab to lose, the same way a native app saving to disk on every keystroke wouldn't have one either. A few things build on that to close the remaining real gaps:

- **Save failures are no longer silent.** If `localStorage.setItem` ever throws (storage full, private-browsing lockdown, storage disabled), doOS now shows a toast immediately instead of the change quietly failing to persist while looking fine on screen.
- **Local auto-backups (IndexedDB).** Every ~10 minutes of active use, doOS snapshots your full data into a separate IndexedDB database (Settings → Local Auto-Backups), keeping the last 5. If a bad import or a bug ever corrupts the live data, you can roll back to one of these from inside the app — no export needed. (This used to be implemented in `localStorage` directly, but a real multi-year iStudiez history is several MB, and a few `localStorage` copies of that blow right through the ~5MB per-origin quota — `QuotaExceededError`, confirmed while building this. IndexedDB's quota is tied to actual free disk space instead, so it doesn't hit that ceiling.)
- **A backup reminder you can't fully ignore.** If it's been 3+ days since your last exported backup, a banner appears across the app (and a dot on the Settings nav item) with a one-click "Export Now". Closing the tab while a backup is overdue triggers the browser's own "Leave site?" confirmation — **this is the actual limit of what a website is allowed to do**: no webpage can literally force a browser tab to stay open (that's an intentional browser security boundary, not a bug), and the browser shows its own generic wording, not custom text. It's a last nudge, not a lock.

None of this protects against clearing this browser's site data, reinstalling, or switching devices/browsers — only an exported JSON file survives that, which is why the reminder exists at all.
