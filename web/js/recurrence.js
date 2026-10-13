/* ===================================================================
   recurrence.js -- turns a recurring task template into real,
   independently-completable task instances, one at a time.

   Model: a template never has more than one *pending* (not Done, not
   past its due date) instance live at once. The next occurrence is only
   materialized once the current one is marked Done OR its due date has
   passed -- not pre-generated on a rolling window. This keeps the Inbox
   from filling up with weeks of a weekly chore all at once, while still
   catching up automatically (one step at a time) if the app sits unused
   past several occurrences.
=================================================================== */

const Recurrence = (function () {
  const BACKFILL_DAYS = 14; // how far into the past a brand-new template's first instance can start
  const MAX_SCAN_DAYS = 400; // guards occurrence search against pathological/never-matching rules
  const MAX_CHAIN_STEPS = 300; // per-template cap per call, so a years-abandoned series can't runaway; it just finishes catching up over a few more calls

  function occursOnDate(rule, iso) {
    const start = rule.startDate;
    if (DB.isoCompare(iso, start) < 0) return false;
    if (rule.endDate && DB.isoCompare(iso, rule.endDate) > 0) return false;

    if (rule.freq === 'daily') {
      const daysSinceStart = Math.round((new Date(iso) - new Date(start)) / 86400000);
      return daysSinceStart >= 0 && daysSinceStart % (rule.interval || 1) === 0;
    }

    if (rule.freq === 'weekly') {
      const days = rule.daysOfWeek && rule.daysOfWeek.length ? rule.daysOfWeek : [DB.dayIndex(start)];
      if (!days.includes(DB.dayIndex(iso))) return false;
      const weeksSinceStart = Math.floor((new Date(iso) - new Date(start)) / (7 * 86400000));
      return weeksSinceStart >= 0 && weeksSinceStart % (rule.interval || 1) === 0;
    }

    return false;
  }

  // First date >= iso (and within the rule's own bounds) that satisfies
  // the rule, or null if none found within the scan window / endDate.
  function nextOccurrenceOnOrAfter(rule, iso) {
    let cursor = iso;
    for (let i = 0; i < MAX_SCAN_DAYS; i++) {
      if (rule.endDate && DB.isoCompare(cursor, rule.endDate) > 0) return null;
      if (occursOnDate(rule, cursor)) return cursor;
      cursor = DB.addDaysISO(cursor, 1);
    }
    return null;
  }

  function nextOccurrenceAfter(rule, iso) {
    return nextOccurrenceOnOrAfter(rule, DB.addDaysISO(iso, 1));
  }

  // Integer day count from `fromIso` to `toIso` (positive if `toIso` is
  // later). Missing either side defaults to 0 -- a template with no
  // separate Scheduled Date just means "scheduled the same day it's due".
  function daysBetween(fromIso, toIso) {
    if (!fromIso || !toIso) return 0;
    const [fy, fm, fd] = fromIso.split('-').map(Number);
    const [ty, tm, td] = toIso.split('-').map(Number);
    return Math.round((new Date(ty, tm - 1, td) - new Date(fy, fm - 1, fd)) / 86400000);
  }

  // For every recurring template, chain forward one occurrence at a time:
  // once the latest existing instance is Done or its due date has passed,
  // materialize the next one -- carrying over the same due/scheduled
  // offset the template itself was set up with, unless that particular
  // instance is later edited by hand (editing never feeds back here).
  function generateUpcoming(state) {
    const today = DB.todayISO();
    const templates = state.tasks.filter(t => t.isTemplate && t.recurrence);
    if (!templates.length) return 0;
    let created = 0;

    // Build seriesId -> instances once up front instead of re-filtering
    // the entire tasks array on every chain step of every template --
    // this runs on every renderAll() call, and the real dataset has
    // thousands of tasks, so that used to be a real repeated O(n) cost.
    const instancesBySeries = new Map();
    state.tasks.forEach(t => {
      if (!t.seriesId) return;
      if (!instancesBySeries.has(t.seriesId)) instancesBySeries.set(t.seriesId, []);
      instancesBySeries.get(t.seriesId).push(t);
    });

    templates.forEach(tpl => {
      // One malformed template (bad recurrence shape from old/edited data,
      // an unexpected null somewhere) must never take down this whole
      // function -- generateUpcoming runs on EVERY renderAll(), so an
      // uncaught throw here would silently freeze the entire UI on stale
      // data with no visible error, which is far worse than skipping one
      // broken series and logging it.
      try {
        created += generateUpcomingForTemplate(tpl, today, instancesBySeries, state);
      } catch (err) {
        console.error(`doOS: skipping recurring template "${tpl.title}" (${tpl.id}) -- generateUpcoming failed:`, err);
      }
    });

    if (created > 0) DB.save();
    return created;
  }

  function generateUpcomingForTemplate(tpl, today, instancesBySeries, state) {
      let createdForThisTemplate = 0;
      const offsetDays = daysBetween(tpl.scheduledDate, tpl.dueDate);
      let guard = 0;
      let instances = instancesBySeries.get(tpl.id);
      if (!instances) { instances = []; instancesBySeries.set(tpl.id, instances); }

      while (guard++ < MAX_CHAIN_STEPS) {
        if (tpl.recurrence.count && instances.length >= tpl.recurrence.count) break;

        const latest = instances.length
          ? instances.reduce((a, b) => DB.isoCompare(a.dueDate, b.dueDate) >= 0 ? a : b)
          : null;
        // generatedThrough remembers the furthest occurrence date this
        // series has EVER materialized, even after that instance is
        // later deleted or cancelled -- without it, deleting/cancelling
        // the most recent instance would make `latest` fall back to an
        // earlier (already-resolved) one, and the chain below would
        // immediately regenerate the exact occurrence that was just
        // removed, making delete/cancel look like it silently "didn't work."
        const generatedThrough = tpl.recurrence.generatedThrough || null;
        const effectiveLatestDate = generatedThrough && (!latest || DB.isoCompare(generatedThrough, latest.dueDate) > 0)
          ? generatedThrough : (latest ? latest.dueDate : null);
        const isAtFurthestPoint = !!latest && latest.dueDate === effectiveLatestDate;

        let nextCursor;
        if (!effectiveLatestDate) {
          const earliestBackfill = DB.addDaysISO(today, -BACKFILL_DAYS);
          const startFrom = DB.isoCompare(tpl.recurrence.startDate, earliestBackfill) > 0 ? tpl.recurrence.startDate : earliestBackfill;
          nextCursor = nextOccurrenceOnOrAfter(tpl.recurrence, startFrom);
        } else {
          // Only a real, still-present latest instance needs to actually
          // be resolved before advancing -- if the furthest-generated
          // occurrence was removed (not at the furthest point anymore),
          // that removal itself already counts as "handled."
          const isResolved = !isAtFurthestPoint || isResolvedStatus(latest.status) || DB.isoCompare(latest.dueDate, today) < 0;
          if (!isResolved) break; // still pending and not due yet -- wait
          nextCursor = nextOccurrenceAfter(tpl.recurrence, effectiveLatestDate);
        }

        if (!nextCursor) break; // series ended (endDate/count/no matching date)
        if (instances.some(t => t.dueDate === nextCursor)) break; // already exists -- safety net

        const scheduledDate = DB.addDaysISO(nextCursor, -offsetDays);
        const instance = DB.mkTask({
          title: tpl.title,
          type: tpl.type,
          courseId: tpl.courseId,
          dueDate: nextCursor,
          scheduledDate,
          estHours: tpl.estHours,
          energy: tpl.energy,
          priority: tpl.priority,
          notes: tpl.notes,
          startTime: tpl.startTime || null,
          endTime: tpl.endTime || null,
          calendarId: tpl.calendarId || null,
          status: DB.isoCompare(nextCursor, today) < 0 ? 'Backlog' : 'To Do',
          seriesId: tpl.id,
        });
        state.tasks.push(instance);
        instances.push(instance);
        tpl.recurrence.generatedThrough = nextCursor;
        createdForThisTemplate++;
      }
      return createdForThisTemplate;
  }

  return { generateUpcoming, occursOnDate };
})();
