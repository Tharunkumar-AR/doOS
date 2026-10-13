/* ===================================================================
   estimator.js -- "how long will this actually take?" Not a hosted AI
   model: a local, privacy-preserving statistical estimate built from
   YOUR OWN completed tasks (DB.get().taskHistory). Nothing ever leaves
   the browser. Runs entirely offline, same as the rest of doOS.
=================================================================== */

const Estimator = (function () {
  function round2(n) { return Math.round(n * 100) / 100; }

  function avg(entries) {
    const hours = entries.map(e => e.actualHours).filter(h => h > 0);
    if (!hours.length) return null;
    return round2(hours.reduce((a, b) => a + b, 0) / hours.length);
  }

  // Returns {hours, sampleSize, basis} where basis explains what matched,
  // or null if there's not enough history to say anything useful yet.
  function suggest(title, type, courseId) {
    const history = (DB.get().taskHistory || []).filter(h => h.actualHours > 0);
    if (!history.length) return null;

    const titleKey = DB.normalizeTitleKey(title);

    if (titleKey) {
      const exact = history.filter(h => h.titleKey === titleKey);
      if (exact.length) {
        const hours = avg(exact);
        if (hours) return { hours, sampleSize: exact.length, basis: `you've logged "${title.trim()}" before` };
      }
    }

    if (type && courseId) {
      const byTypeCourse = history.filter(h => h.type === type && h.courseId === courseId);
      if (byTypeCourse.length) {
        const hours = avg(byTypeCourse);
        if (hours) return { hours, sampleSize: byTypeCourse.length, basis: `past ${type} tasks in this course` };
      }
    }

    if (type) {
      const byType = history.filter(h => h.type === type);
      if (byType.length) {
        const hours = avg(byType);
        if (hours) {
          const basis = isGoalBasedType(type) ? `past ${type} sessions overall` : `past ${type} tasks overall`;
          return { hours, sampleSize: byType.length, basis };
        }
      }
    }

    return null;
  }

  // Compares est. vs actual across everything logged, to surface whether
  // this student tends to under- or over-estimate. Returns null if there
  // isn't enough paired data yet to say anything meaningful. Goal-based
  // tasks (Study/Review/Practice -- see isGoalBasedType) are excluded:
  // their "actual" deliberately diverging from their "estimate" is the
  // whole point of a flexible goal, not a prediction miss, so mixing
  // them in would skew this ratio against something it was never
  // measuring in the first place.
  function accuracyInsight() {
    const history = (DB.get().taskHistory || []).filter(h => h.actualHours > 0 && h.estHours > 0 && !isGoalBasedType(h.type));
    if (history.length < 3) return null;
    const totalEst = history.reduce((s, h) => s + h.estHours, 0);
    const totalActual = history.reduce((s, h) => s + h.actualHours, 0);
    const ratio = totalActual / totalEst;
    const pct = Math.round(Math.abs(ratio - 1) * 100);
    let label;
    if (pct < 10) label = `Your estimates are usually spot on (within ${Math.max(pct, 1)}%).`;
    else if (ratio > 1) label = `Tasks tend to take about ${pct}% longer than you estimate.`;
    else label = `Tasks tend to take about ${pct}% less time than you estimate.`;
    return { ratio: round2(ratio), sampleSize: history.length, label };
  }

  return { suggest, accuracyInsight };
})();
