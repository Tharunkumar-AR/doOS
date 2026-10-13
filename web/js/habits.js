/* ===================================================================
   habits.js -- streak/stat/graph logic for the Habit Tracker.
   Deliberately independent of the task/recurrence system: a habit is
   just a list of dates it was done, nothing more. Everything here is a
   pure read of that list; js/db.js owns the one mutation (toggle).
=================================================================== */

const Habits = (function () {
  function isDone(habit, dateIso) {
    return habit.completions.includes(dateIso);
  }

  function mondayOf(dateIso) {
    const dow = DB.dayIndex(dateIso); // 0 Sun .. 6 Sat
    const diff = (dow + 6) % 7; // days since most recent Monday
    return DB.addDaysISO(dateIso, -diff);
  }

  // Completions within the Mon-Sun week that contains weekStart (itself
  // already a Monday).
  function countInWeek(habit, weekStart) {
    let n = 0;
    for (let i = 0; i < 7; i++) {
      if (isDone(habit, DB.addDaysISO(weekStart, i))) n++;
    }
    return n;
  }

  // Current streak as of today: consecutive days done (daily goal), or
  // consecutive Mon-Sun weeks that met weeklyTarget (weekly goal). A
  // daily habit not yet done today doesn't break the streak until the
  // day is actually over (today just doesn't count yet); a weekly habit
  // still short of target with days left in the current week doesn't
  // break it either -- the same "don't punish an unfinished today" idea
  // the recurrence engine's own streak math already uses.
  function currentStreak(habit, todayIso) {
    todayIso = todayIso || DB.todayISO();
    if (habit.goalType === 'daily') {
      let cursor = todayIso;
      if (!isDone(habit, cursor)) cursor = DB.addDaysISO(cursor, -1);
      let streak = 0;
      while (isDone(habit, cursor)) { streak++; cursor = DB.addDaysISO(cursor, -1); }
      return streak;
    }
    // weekly
    const target = Math.max(1, habit.weeklyTarget || 3);
    let weekStart = mondayOf(todayIso);
    const weekEnd = DB.addDaysISO(weekStart, 6);
    const thisWeekCount = countInWeek(habit, weekStart);
    const thisWeekStillOpen = DB.isoCompare(todayIso, weekEnd) < 0;
    if (thisWeekCount < target && thisWeekStillOpen) {
      weekStart = DB.addDaysISO(weekStart, -7); // this week doesn't count yet either way -- look at the last finished week first
    }
    let streak = 0;
    while (countInWeek(habit, weekStart) >= target) {
      streak++;
      weekStart = DB.addDaysISO(weekStart, -7);
    }
    return streak;
  }

  // Longest streak ever, scanning the habit's full history (from its
  // oldest completion through today).
  function bestStreak(habit, todayIso) {
    todayIso = todayIso || DB.todayISO();
    if (!habit.completions.length) return 0;
    const sorted = habit.completions.slice().sort();
    if (habit.goalType === 'daily') {
      let best = 0, run = 0, prev = null;
      sorted.forEach(d => {
        if (prev && DB.addDaysISO(prev, 1) === d) run++;
        else run = 1;
        best = Math.max(best, run);
        prev = d;
      });
      return best;
    }
    // weekly -- walk week by week from the first completion to today
    const target = Math.max(1, habit.weeklyTarget || 3);
    let cursor = mondayOf(sorted[0]);
    const lastWeek = mondayOf(todayIso);
    let best = 0, run = 0;
    while (DB.isoCompare(cursor, lastWeek) <= 0) {
      if (countInWeek(habit, cursor) >= target) run++;
      else run = 0;
      best = Math.max(best, run);
      cursor = DB.addDaysISO(cursor, 7);
    }
    return best;
  }

  // % of applicable days/weeks met, over the last `days` calendar days
  // (daily goal: % of days done; weekly goal: % of weeks that hit target,
  // counting only weeks that have actually started).
  function completionRate(habit, days, todayIso) {
    todayIso = todayIso || DB.todayISO();
    if (habit.goalType === 'daily') {
      let done = 0;
      for (let i = 0; i < days; i++) {
        if (isDone(habit, DB.addDaysISO(todayIso, -i))) done++;
      }
      return Math.round((done / days) * 100);
    }
    const target = Math.max(1, habit.weeklyTarget || 3);
    const weeks = Math.max(1, Math.round(days / 7));
    let met = 0;
    let weekStart = mondayOf(todayIso);
    for (let i = 0; i < weeks; i++) {
      if (countInWeek(habit, weekStart) >= target) met++;
      weekStart = DB.addDaysISO(weekStart, -7);
    }
    return Math.round((met / weeks) * 100);
  }

  // Grid data for the GitHub-style heatmap: `weeks` columns of 7 days
  // (Mon..Sun), oldest first, ending on the Sunday of the week containing
  // `anchorIso` -- so "today" lands in the rightmost column on the
  // current (unpaged) view, wherever it falls in that column's week.
  // `anchorIso` defaults to today (page 0); pass an earlier date to page
  // back through history without changing what counts as "future" --
  // that's always relative to the real `todayIso`, not the page anchor.
  function heatmapWeeks(habit, weeks, anchorIso, todayIso) {
    todayIso = todayIso || DB.todayISO();
    anchorIso = anchorIso || todayIso;
    const lastMonday = mondayOf(anchorIso);
    const firstMonday = DB.addDaysISO(lastMonday, -(weeks - 1) * 7);
    const cols = [];
    for (let w = 0; w < weeks; w++) {
      const colStart = DB.addDaysISO(firstMonday, w * 7);
      const days = [];
      for (let d = 0; d < 7; d++) {
        const dateIso = DB.addDaysISO(colStart, d);
        days.push({ dateIso, done: isDone(habit, dateIso), isFuture: DB.isoCompare(dateIso, todayIso) > 0 });
      }
      cols.push(days);
    }
    return cols;
  }

  function describeGoal(habit) {
    return habit.goalType === 'daily' ? 'Daily' : `${habit.weeklyTarget}x / week`;
  }

  return { isDone, mondayOf, countInWeek, currentStreak, bestStreak, completionRate, heatmapWeeks, describeGoal };
})();
