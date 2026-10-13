/* ===================================================================
   planner.js -- "Smart Plan": automatically schedules flexible tasks
   (ones with an estimated-hours figure and a due date, but no fixed
   time) into open slots between today and their deadline, working
   around fixed-time calendar blocks (classes/lectures) and anything
   already on the calendar. Splits a task across multiple days when it
   doesn't fit in one.

   Loads after ui.js (uses PRIORITY_RANK) and before main.js.
=================================================================== */

const Planner = (function () {
  // Smooth the weekly capacity setting into a per-day budget.
  function dailyCapacity(state) {
    return Math.max(1, state.settings.capacityHoursPerWeek || 30) / 7;
  }

  // Fixed-time blocks (classes, lectures, anything with startTime+endTime,
  // including events from any enabled subscribed/imported calendar, AND
  // each course's own weekly meeting schedule -- DB.classMeetingBlocksOn --
  // so Smart Plan actually knows about a real lecture/section/lab even
  // when it was never materialized as a task row) already committed on a
  // given day -- time the planner must work around.
  function fixedHoursOnDay(state, dateIso) {
    // Done fixed blocks still count -- they really occupied that time.
    // Cancelled ones never happened, so (unlike Done) they free the slot.
    const taskBlocks = DB.visibleTasks(state)
      .filter(t => !t.isTemplate && t.scheduledDate === dateIso && t.startTime && t.endTime && t.status !== 'Cancelled');
    const blocks = [...taskBlocks, ...DB.classMeetingBlocksOn(state, dateIso)];
    // Merge before summing -- two overlapping fixed blocks (a cross-listed
    // lecture/section, or two calendar subscriptions reporting the same
    // meeting) shouldn't count that overlapping time twice against the
    // day's capacity.
    const merged = DB.mergeTimeIntervals(blocks.flatMap(t => DB.blockIntervals(t.startTime, t.endTime)));
    return DB.sumTimeIntervals(merged);
  }

  // Flexible (non-fixed-time) tasks already scheduled that day, not
  // resolved (done or cancelled) -- a cancelled task frees its slot same
  // as a done one, just without the "it actually got worked" history.
  function flexHoursOnDay(state, dateIso) {
    return DB.visibleTasks(state)
      .filter(t => !t.isTemplate && t.scheduledDate === dateIso && !isResolvedStatus(t.status) && !t.startTime)
      .reduce((sum, t) => sum + (parseFloat(t.estHours) || 0), 0);
  }

  // Free flexible-study hours left on a day, after fixed blocks, already
  // scheduled tasks, and anything this planning run has committed so far.
  function freeHoursOnDay(state, dateIso, committed) {
    const cap = dailyCapacity(state);
    const used = fixedHoursOnDay(state, dateIso) + flexHoursOnDay(state, dateIso) + (committed[dateIso] || 0);
    return Math.max(0, cap - used);
  }

  function roundQuarterHour(h) {
    return Math.round(h * 4) / 4;
  }

  // Schedules every currently-unscheduled flexible task that has both an
  // estHours figure and a dueDate. Earliest deadlines get placed first;
  // each task fills the earliest days with room, splitting across
  // multiple days (and multiple task rows) if it doesn't fit in one.
  // Returns {planned, split, days, missingEstimate, missingDueDate,
  // missingBoth} -- a task missing either field is otherwise eligible
  // (flexible, unscheduled, Backlog/To Do) but can't actually be placed
  // without it, so the caller reports the count back instead of the task
  // just silently never getting scheduled with no explanation.
  function smartPlan(state) {
    const today = DB.todayISO();

    const eligiblePool = DB.visibleTasks(state).filter(t =>
      !t.isTemplate && !t.startTime && !t.scheduledDate &&
      (t.status === 'Backlog' || t.status === 'To Do')
    );
    const hasEst = t => parseFloat(t.estHours) > 0;
    const missingEstimate = eligiblePool.filter(t => !hasEst(t) && t.dueDate).length;
    const missingDueDate = eligiblePool.filter(t => hasEst(t) && !t.dueDate).length;
    const missingBoth = eligiblePool.filter(t => !hasEst(t) && !t.dueDate).length;

    const candidates = eligiblePool.filter(t => hasEst(t) && t.dueDate)
      .sort((a, b) => DB.isoCompare(a.dueDate, b.dueDate) || effectivePriorityRank(a) - effectivePriorityRank(b));

    const committed = {};
    const daysTouched = new Set();
    let planned = 0, split = 0;

    candidates.forEach(task => {
      let remaining = parseFloat(task.estHours);
      const endCursor = DB.isoCompare(task.dueDate, today) < 0 ? today : task.dueDate;
      const chunks = [];
      let cursor = today;

      while (remaining > 0.01 && DB.isoCompare(cursor, endCursor) <= 0) {
        const free = freeHoursOnDay(state, cursor, committed);
        if (free > 0.01) {
          const take = Math.min(free, remaining);
          chunks.push({ date: cursor, hours: roundQuarterHour(take) });
          committed[cursor] = (committed[cursor] || 0) + take;
          remaining -= take;
        }
        cursor = DB.addDaysISO(cursor, 1);
      }
      if (remaining > 0.01) {
        // Nothing but overload left -- the deadline wins; dump the rest there
        // rather than silently losing hours, so the overload is visible.
        chunks.push({ date: endCursor, hours: roundQuarterHour(remaining) });
        committed[endCursor] = (committed[endCursor] || 0) + remaining;
      }
      if (!chunks.length) return;

      chunks.forEach(c => daysTouched.add(c.date));

      if (chunks.length === 1) {
        task.scheduledDate = chunks[0].date;
        task.autoplanned = true;
        DB.upsertTask(task);
      } else {
        const groupId = task.id;
        chunks.forEach((c, i) => {
          if (i === 0) {
            task.scheduledDate = c.date;
            task.estHours = c.hours;
            task.splitGroupId = groupId;
            task.splitIndex = 1;
            task.splitTotal = chunks.length;
            task.autoplanned = true;
            DB.upsertTask(task);
          } else {
            // Object.assign is a shallow copy -- array fields (timeLog,
            // subtasks) must be cloned explicitly, or every chunk of this
            // task ends up sharing the same array: clocking in or
            // checking a subtask on one chunk would silently corrupt all
            // the others too.
            const chunk = DB.mkTask(Object.assign({}, task, {
              id: DB.uid('t'),
              scheduledDate: c.date,
              estHours: c.hours,
              splitGroupId: groupId,
              splitIndex: i + 1,
              splitTotal: chunks.length,
              autoplanned: true,
              actualHours: 0,
              status: task.status,
              timeLog: [],
              subtasks: (task.subtasks || []).map(s => ({ ...s })),
            }));
            DB.upsertTask(chunk);
          }
        });
        split++;
      }
      planned++;
    });

    DB.save();
    return { planned, split, days: daysTouched.size, missingEstimate, missingDueDate, missingBoth };
  }

  // User-directed split: spread one task's hours evenly across N
  // consecutive days starting at its current scheduled date (or today).
  function manualSplit(task, numDays) {
    numDays = Math.max(1, Math.floor(numDays));
    if (numDays <= 1) return 1;
    const total = parseFloat(task.estHours) || 0;
    const perDay = roundQuarterHour(total / numDays);
    const startDate = task.scheduledDate || DB.todayISO();
    const groupId = task.id;

    for (let i = 0; i < numDays; i++) {
      const date = DB.addDaysISO(startDate, i);
      const isLast = i === numDays - 1;
      const hours = isLast ? Math.round((total - perDay * (numDays - 1)) * 100) / 100 : perDay;
      if (i === 0) {
        task.scheduledDate = date;
        task.estHours = hours;
        task.splitGroupId = groupId;
        task.splitIndex = 1;
        task.splitTotal = numDays;
        DB.upsertTask(task);
      } else {
        // Same shallow-copy hazard as smartPlan above -- clone array fields.
        const chunk = DB.mkTask(Object.assign({}, task, {
          id: DB.uid('t'),
          scheduledDate: date,
          estHours: hours,
          splitIndex: i + 1,
          splitTotal: numDays,
          splitGroupId: groupId,
          actualHours: 0,
          status: task.status,
          timeLog: [],
          subtasks: (task.subtasks || []).map(s => ({ ...s })),
        }));
        DB.upsertTask(chunk);
      }
    }
    DB.save();
    return numDays;
  }

  return { smartPlan, manualSplit, dailyCapacity, freeHoursOnDay, fixedHoursOnDay, flexHoursOnDay };
})();
