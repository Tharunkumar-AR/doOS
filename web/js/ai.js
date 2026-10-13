/* ===================================================================
   ai.js -- optional, opt-in AI integration (BYOK: bring your own key).

   Unlike every other module in doOS, this one DOES send data off the
   browser -- but only when the user has explicitly configured a
   provider + API key in Settings (see js/db.js settings.ai), and only
   ever the small, purpose-built snippets the functions below build
   (never the full task history, never anything automatic). This is a
   deliberate, clearly-labeled exception to the rest of doOS's "nothing
   ever leaves the browser" promise -- see js/estimator.js for the
   local, statistical alternative this module sits ALONGSIDE, not in
   place of.

   Three providers, three different browser-CORS situations:
     - Anthropic (Claude): direct browser fetch works, with the
       `anthropic-dangerous-direct-browser-access` opt-in header.
     - Google (Gemini): direct browser fetch works, but only via the
       legacy per-model `:generateContent` endpoint (the newer
       Interactions API has an open CORS bug).
     - OpenAI (ChatGPT): a basic chat-completions POST (Authorization +
       JSON body, no custom headers) worked fine cross-origin in direct
       testing against a real neutral page -- contradicting an online
       report that it's blocked. CORS policies can change, differ by
       request shape, or vary by account, so completeOpenAI() below
       still treats a CORS-style network failure (a bare TypeError, no
       response to inspect) as a known, explainable case rather than a
       confusing generic error -- but don't assume it on faith either way
       without testing with a real key.

   Future extension point: Canvas sync / textbook access would hang
   additional context-gathering helpers off this module -- out of scope
   for now, no code here.
=================================================================== */

const AI = (function () {
  const PROVIDER_LABELS = { anthropic: 'Claude', openai: 'ChatGPT', gemini: 'Gemini' };

  function isConfigured(state) {
    const ai = state && state.settings && state.settings.ai;
    return !!(ai && ai.apiKey && ai.provider);
  }

  function providerLabel(provider) {
    return PROVIDER_LABELS[provider] || provider || 'AI';
  }

  // Canvas/iStudiez auto-import already map "homework"/"HW" keywords to
  // type PSET (see js/canvas.js, js/istudiez.js guessType) -- but a
  // hand-typed task titled e.g. "History HW" might still be sitting
  // under ToDo/unspecified, so every prompt reasoning about type-based
  // priority/reschedulability/estimation is told this equivalence
  // explicitly rather than trusting the stored type alone.
  function hwPsetNote() {
    return 'Note: treat any task whose title mentions "HW" or "homework" the same as type PSET for priority, reschedulability, and estimation purposes, even if its stored type says otherwise.';
  }

  // Marks an Error as "this is specifically the known OpenAI-CORS wall,"
  // so callers can show the accurate, non-mysterious message instead of
  // a generic network-failure toast.
  function corsBlockedError(provider) {
    const err = new Error(
      `${providerLabel(provider)} can't be called directly from a browser -- it blocks cross-origin requests, and this would need the desktop app's native networking to work around it (not built yet). Try Claude or Gemini instead, which work directly.`
    );
    err.corsBlocked = true;
    return err;
  }

  async function parseJsonSafe(res) {
    try { return await res.json(); } catch (e) { return null; }
  }

  // ---------------- per-provider request/response shapes ----------------

  async function completeAnthropic(apiKey, promptText) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{ role: 'user', content: promptText }],
        }),
      });
    } catch (e) {
      throw new Error(`Network error calling Claude: ${e.message}`);
    }
    const data = await parseJsonSafe(res);
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      throw new Error(`Claude API error: ${msg}`);
    }
    const text = data && data.content && data.content[0] && data.content[0].text;
    if (!text) throw new Error('Claude returned an empty response.');
    return text;
  }

  // Legacy per-model endpoint, NOT the newer Interactions API (which has
  // an open, confirmed CORS bug as of now and will not work from a
  // browser). API key goes in the query string, not a header.
  async function completeGemini(apiKey, promptText) {
    const model = 'gemini-3.8-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] }),
      });
    } catch (e) {
      throw new Error(`Network error calling Gemini: ${e.message}`);
    }
    const data = await parseJsonSafe(res);
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      throw new Error(`Gemini API error: ${msg}`);
    }
    const text = data && data.candidates && data.candidates[0]
      && data.candidates[0].content && data.candidates[0].content.parts
      && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    if (!text) throw new Error('Gemini returned an empty response.');
    return text;
  }

  // Direct testing showed this request shape actually reaches OpenAI's
  // servers fine cross-origin, but CORS policies aren't something this
  // app controls and can change -- if a user's browser/account/request
  // ever does hit a CORS wall here, catch it below and explain it
  // plainly (routing around it would need Tauri's native HTTP capability
  // or a backend proxy, neither built here) instead of throwing a
  // confusing generic error.
  async function completeOpenAI(apiKey, promptText) {
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-6-luna',
          messages: [{ role: 'user', content: promptText }],
        }),
      });
    } catch (e) {
      // A CORS-blocked fetch surfaces as a bare TypeError ("Failed to
      // fetch" / "Load failed") with no response to inspect -- that
      // specific failure mode most likely means a CORS wall (which direct
      // testing suggests is not the normal case for this endpoint, but a
      // browser/account/policy difference could still hit it), so explain
      // that plainly instead of a generic network-error message.
      if (e instanceof TypeError) throw corsBlockedError('openai');
      throw new Error(`Network error calling ChatGPT: ${e.message}`);
    }
    const data = await parseJsonSafe(res);
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      throw new Error(`ChatGPT API error: ${msg}`);
    }
    const text = data && data.choices && data.choices[0]
      && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error('ChatGPT returned an empty response.');
    return text;
  }

  // ---------------- low-level entry point ----------------

  async function complete(state, promptText) {
    const ai = state && state.settings && state.settings.ai;
    if (!ai || !ai.apiKey || !ai.provider) {
      throw new Error('AI is not configured -- add a provider and API key in Settings first.');
    }
    if (ai.provider === 'anthropic') return completeAnthropic(ai.apiKey, promptText);
    if (ai.provider === 'gemini') return completeGemini(ai.apiKey, promptText);
    if (ai.provider === 'openai') return completeOpenAI(ai.apiKey, promptText);
    throw new Error(`Unknown AI provider "${ai.provider}".`);
  }

  // ---------------- AI task-duration estimate ----------------
  // Compact prompt: the task's own fields, plus a handful of the
  // student's own recently-completed tasks of the same type/course (for
  // grounding) -- never the whole taskHistory.

  function buildEstimatePrompt(state, task) {
    const course = task.courseId ? (state.courses || []).find(c => c.id === task.courseId) : null;
    const history = (DB.get().taskHistory || [])
      .filter(h => h.actualHours > 0 && (h.type === task.type || (course && h.courseId === course.id)))
      .slice(-5);
    const historyLines = history.length
      ? history.map(h => `- "${h.title}" (${h.type}${course && h.courseId === course.id ? ', same course' : ''}): took ${h.actualHours}h`).join('\n')
      : '(no comparable history logged yet)';

    const isGoal = isGoalBasedType(task.type);
    return [
      isGoal
        ? "You are helping a student set a study/review/practice TIME GOAL -- not a prediction of total work needed to finish (there's no 'finish' for open-ended review). Suggest a reasonable session-length goal, e.g. '2 hours of review,' skewed shorter than you would for graded work -- this task type is inherently lower priority and has a variable, flexible time frame."
        : 'You are helping a student estimate how many hours a task will realistically take.',
      hwPsetNote(),
      `Task: "${task.title || '(untitled)'}"`,
      `Type: ${task.type || 'unspecified'}`,
      `Course: ${course ? course.name : 'none'}`,
      `Due: ${task.dueDate || 'no due date'}`,
      task.notes ? `Notes: ${task.notes}` : '',
      '',
      isGoal
        ? "For grounding, here are a few of this student's own recently-logged study/review sessions of a similar type/course:"
        : "For grounding, here are a few of this student's own recently-completed tasks of a similar type/course:",
      historyLines,
      '',
      'Reply in EXACTLY this format and nothing else (no extra commentary):',
      isGoal ? 'HOURS: <a single number, e.g. 2>' : 'HOURS: <a single number, e.g. 3.5>',
      'REASON: <one brief sentence>',
    ].filter(line => line !== '').join('\n');
  }

  // Defensive parse -- models don't always follow the requested format
  // exactly, so fall back to grabbing the first plausible number rather
  // than crashing.
  function parseEstimateResponse(text) {
    const hoursMatch = text.match(/HOURS:\s*([\d.]+)/i);
    const reasonMatch = text.match(/REASON:\s*(.+)/i);
    if (hoursMatch) {
      const hours = parseFloat(hoursMatch[1]);
      if (Number.isFinite(hours) && hours > 0) {
        return { hours: Math.round(hours * 100) / 100, reasoning: reasonMatch ? reasonMatch[1].trim() : '' };
      }
    }
    const anyNum = text.match(/(\d+(?:\.\d+)?)\s*h(?:ours?)?\b/i) || text.match(/(\d+(?:\.\d+)?)/);
    if (anyNum) {
      const hours = parseFloat(anyNum[1]);
      if (Number.isFinite(hours) && hours > 0 && hours < 1000) {
        return { hours: Math.round(hours * 100) / 100, reasoning: text.trim().slice(0, 240) };
      }
    }
    throw new Error('Could not parse an hour estimate from the AI response.');
  }

  async function estimateTaskHours(state, task) {
    const prompt = buildEstimatePrompt(state, task);
    const text = await complete(state, prompt);
    return parseEstimateResponse(text);
  }

  // ---------------- bulk AI estimate (many tasks, few API calls) ----------------
  // One task per API call doesn't scale -- a backlog of a few hundred
  // missing estimates would mean a few hundred round trips. Instead this
  // batches many tasks into a single prompt (BULK_ESTIMATE_BATCH_SIZE at
  // a time, chunking is the caller's job -- see estimateTasksBatch) and
  // asks for one compact line of output per task, keyed by task id so
  // the response maps back unambiguously regardless of title collisions.
  //
  // Grounding is also batched: instead of repeating each task's own
  // little slice of history inline (lots of duplicated text when many
  // tasks share a type/course), one shared reference block lists an
  // average per (type, course) pair that actually appears in this batch,
  // built once, not once per task.
  const BULK_ESTIMATE_BATCH_SIZE = 30;

  function referenceLinesForBatch(tasks) {
    const history = DB.get().taskHistory || [];
    const seen = new Set();
    const lines = [];
    tasks.forEach(t => {
      const key = `${t.type}::${t.courseId || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      const course = t.courseId ? (DB.get().courses || []).find(c => c.id === t.courseId) : null;
      const matches = history.filter(h => h.actualHours > 0 && h.type === t.type && (h.courseId || '') === (t.courseId || ''));
      const label = `${t.type}${course ? ` in ${course.name}` : ''}`;
      if (!matches.length) { lines.push(`- ${label}: (no history logged yet)`); return; }
      const sample = matches.slice(-5).map(h => `${h.actualHours}h`).join(', ');
      const avg = Math.round((matches.reduce((s, h) => s + h.actualHours, 0) / matches.length) * 100) / 100;
      lines.push(`- ${label}: ${sample} (avg ${avg}h, ${matches.length} logged)`);
    });
    return lines.join('\n');
  }

  function buildBatchEstimatePrompt(state, tasks) {
    const taskLines = tasks.map(t => {
      const course = t.courseId ? (state.courses || []).find(c => c.id === t.courseId) : null;
      // A description (e.g. pulled in from a Canvas assignment -- see
      // js/canvas.js) is real grounding for how long something actually
      // takes, not just its title -- truncated so one verbose assignment
      // doesn't blow up the whole batch's prompt size.
      const desc = (t.notes || '').trim();
      const descBit = desc ? ` | desc="${desc.slice(0, 220).replace(/"/g, "'")}${desc.length > 220 ? '...' : ''}"` : '';
      return `- id=${t.id} | title="${(t.title || '(untitled)').replace(/"/g, "'")}" | type=${t.type || 'unspecified'} | course=${course ? course.name : 'none'} | due=${t.dueDate || 'none'}${descBit}`;
    }).join('\n');

    return [
      "You are helping a student estimate how many hours each of their tasks will realistically take, for tasks they haven't estimated yet.",
      "Exception: for type=Study/Review/Practice, estHours is a flexible time GOAL the student is setting for themselves (e.g. '2 hours of review'), not a prediction of total work needed to finish -- suggest a reasonable session length, skewed shorter, since this type is inherently lower priority than graded/deadline-driven work.",
      hwPsetNote(),
      '',
      "Reference -- this student's own logged durations by type/course, where available:",
      referenceLinesForBatch(tasks),
      '',
      'Tasks to estimate:',
      taskLines,
      '',
      `Reply with EXACTLY one line per task, in this format and nothing else (no headers, no commentary, no blank lines, ${tasks.length} lines total):`,
      '<id>|<hours>',
      'Example: t_ab12cd34|3.5',
    ].join('\n');
  }

  // Defensive, line-by-line parse -- returns a Map<taskId, hours>, simply
  // omitting any line that doesn't parse cleanly rather than failing the
  // whole batch over one bad line.
  function parseBatchEstimateResponse(text, expectedIds) {
    const idSet = new Set(expectedIds);
    const results = new Map();
    text.split('\n').forEach(line => {
      const m = line.match(/([A-Za-z0-9_-]+)\s*[|:]\s*([\d.]+)/);
      if (!m) return;
      const [, id, hoursStr] = m;
      if (!idSet.has(id)) return;
      const hours = parseFloat(hoursStr);
      if (Number.isFinite(hours) && hours > 0 && hours <= 200) {
        results.set(id, Math.round(hours * 100) / 100);
      }
    });
    return results;
  }

  // Estimates one batch (caller chunks the full candidate list into
  // BULK_ESTIMATE_BATCH_SIZE-sized pieces and calls this once per chunk --
  // kept separate from the chunking/looping/progress/cancellation logic,
  // which belongs to the UI layer in js/main.js, not this module).
  async function estimateTasksBatch(state, tasks) {
    const prompt = buildBatchEstimatePrompt(state, tasks);
    const text = await complete(state, prompt);
    return parseBatchEstimateResponse(text, tasks.map(t => t.id));
  }

  // ---------------- daily insights ----------------
  // Compact prompt: just today's snapshot (overdue count, today's
  // scheduled tasks/classes, habits not yet done, due-in-3-days) -- not
  // the whole dataset.

  function buildDailyInsightsPrompt(state) {
    const today = DB.todayISO();
    const tasks = (state.tasks || []).filter(t => !t.isTemplate);
    const overdue = tasks.filter(t => t.dueDate && DB.isoCompare(t.dueDate, today) < 0 && !isResolvedStatus(t.status));
    const classesToday = DB.classMeetingsOn(state, today);
    const todayTasks = tasks.filter(t => t.scheduledDate === today && !isResolvedStatus(t.status));
    // Goal-hours (Study/Review/Practice) are reported separately from
    // committed estimated hours -- they're a flexible target, not a hard
    // block of the day, and conflating them would make the day look more
    // overloaded than it really is.
    const committedToday = todayTasks.filter(t => !isGoalBasedType(t.type));
    const goalToday = todayTasks.filter(t => isGoalBasedType(t.type));
    const estHoursToday = Math.round(committedToday.reduce((s, t) => s + (parseFloat(t.estHours) || 0), 0) * 100) / 100;
    const goalHoursToday = Math.round(goalToday.reduce((s, t) => s + (parseFloat(t.estHours) || 0), 0) * 100) / 100;
    const in3Days = DB.addDaysISO(today, 3);
    const dueSoon = tasks.filter(t => t.dueDate && DB.isoCompare(t.dueDate, today) >= 0
      && DB.isoCompare(t.dueDate, in3Days) <= 0 && !isResolvedStatus(t.status));
    const habitsNotDoneToday = (state.habits || []).filter(h => !h.archived && !Habits.isDone(h, today));
    const dailyCapacity = Math.max(1, state.settings.capacityHoursPerWeek || 30) / 7;

    const lines = [
      `Today is ${today}.`,
      `Daily capacity goal: ${Math.round(dailyCapacity * 10) / 10}h.`,
      `Classes today: ${classesToday.length}${classesToday.length ? ' -- ' + classesToday.map(c => `${c.course.name} ${c.meeting.startTime}-${c.meeting.endTime}`).join(', ') : ''}`,
      `Flexible tasks scheduled today (not done): ${todayTasks.length}, totaling ~${estHoursToday}h committed${goalHoursToday ? ` + ~${goalHoursToday}h of flexible study/review goals (not hard commitments)` : ''} -- ${todayTasks.length ? todayTasks.slice(0, 8).map(t => `${t.title} (${t.estHours || '?'}h${isGoalBasedType(t.type) ? ' goal' : ''}, ${t.priority} priority)`).join(', ') : 'none'}`,
      `Overdue tasks: ${overdue.length}${overdue.length ? ' -- ' + overdue.slice(0, 5).map(t => t.title).join(', ') : ''}`,
      `Due in the next 3 days: ${dueSoon.length}${dueSoon.length ? ' -- ' + dueSoon.slice(0, 8).map(t => `${t.title} (due ${t.dueDate})`).join(', ') : ''}`,
      `Habits not yet logged today: ${habitsNotDoneToday.length}${habitsNotDoneToday.length ? ' -- ' + habitsNotDoneToday.map(h => h.name).join(', ') : ''}`,
    ];

    return [
      "You are a sharp, encouraging time-management assistant for a student, looking only at today's snapshot below. Be specific and reference actual task names/numbers from the snapshot, not generic advice.",
      `If you suggest rescheduling or dropping something, weigh each task's own priority first (don't suggest bumping a High-priority task to make room for a Low-priority one), then this reschedulability order (most protected first): ${RESCHEDULE_PRIORITY_ORDER.join(' > ')} -- never suggest bumping an exam or PSET to make room for a study/review goal or personal task unless that exam/PSET is itself low priority.`,
      hwPsetNote(),
      lines.join('\n'),
      '',
      'Reply in EXACTLY this format and nothing else (no extra commentary, no markdown):',
      'HEADLINE: <one short, specific sentence summing up today overall>',
      'Then 3-5 lines, each in the form:',
      '<category>|<one specific, actionable sentence>',
      'where <category> is exactly one of: warning, priority, tip, positive',
      '- warning: a real risk today (overloaded, conflicting deadlines, not enough time for something)',
      '- priority: what to actually do first and why',
      '- tip: a concrete time-management suggestion (e.g. reschedule something, batch similar tasks)',
      '- positive: genuine, specific encouragement (good progress, manageable day, a habit streak) -- only include if true, don\'t force it',
      'Example line: warning|PSET (7h) plus 2 classes leaves almost no buffer before it\'s due tomorrow.',
    ].join('\n');
  }

  const INSIGHT_CATEGORIES = new Set(['warning', 'priority', 'tip', 'positive']);

  // Defensive parse: a HEADLINE line plus N "category|text" lines. Any
  // line that doesn't match the category format still gets kept (as a
  // generic 'tip') rather than silently dropped, since models don't
  // always follow a requested format exactly.
  function parseDailyInsightsResponse(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let headline = '';
    const items = [];
    lines.forEach(line => {
      const headlineMatch = line.match(/^HEADLINE:\s*(.+)$/i);
      if (headlineMatch) { headline = headlineMatch[1].trim(); return; }
      const catMatch = line.match(/^[\s\-*•]*([a-zA-Z]+)\s*[|:]\s*(.+)$/);
      if (catMatch && INSIGHT_CATEGORIES.has(catMatch[1].toLowerCase())) {
        items.push({ category: catMatch[1].toLowerCase(), text: catMatch[2].trim() });
        return;
      }
      const plain = line.replace(/^[\s\-*•\d.)]+/, '').trim();
      if (plain) items.push({ category: 'tip', text: plain });
    });
    return { headline, items };
  }

  async function dailyInsights(state) {
    const prompt = buildDailyInsightsPrompt(state);
    const text = await complete(state, prompt);
    const result = parseDailyInsightsResponse(text);
    if (!result.items.length) throw new Error('AI returned no usable insights.');
    return result;
  }

  // ---------------- AI Smart Reschedule ----------------
  // Unlike Smart Replan (deterministic, instant-apply -- see
  // js/main.js's runSmartReplan), this hands the full picture of at-risk
  // tasks to the AI and asks for a reschedule PROPOSAL, never applied
  // directly -- js/main.js shows every suggested move in a review modal
  // the student approves/denies per-row before anything actually changes.

  // Told explicitly to both the deterministic engines (RESCHEDULE_RANK in
  // js/ui.js) and the AI here, so a reschedule suggestion never treats a
  // PSET as equally movable as a personal errand.
  function reschedulabilityHierarchyText() {
    return 'Reschedulability, most protected (avoid moving) to least protected (safe to bump first): '
      + RESCHEDULE_PRIORITY_ORDER.join(' > ') + '.';
  }

  // How far out a reschedule suggestion is allowed to push a task --
  // the whole point is squeezing at-risk work back into view, not
  // deferring it to next week where it'll just become the same problem
  // later. Enforced twice: as an instruction to the AI below, AND
  // programmatically in suggestReschedulePlan (never trust a model to
  // reliably self-enforce a numeric constraint).
  const RESCHEDULE_MAX_DAYS_OUT = 2;

  function buildReschedulePrompt(state, tasks) {
    const today = DB.todayISO();
    const maxDate = DB.addDaysISO(today, RESCHEDULE_MAX_DAYS_OUT);
    const dailyCapacity = Math.max(1, state.settings.capacityHoursPerWeek || 30) / 7;
    const taskLines = tasks.map(t => {
      const course = t.courseId ? (state.courses || []).find(c => c.id === t.courseId) : null;
      const goalNote = isGoalBasedType(t.type) ? ' (estHours is a flexible GOAL, not a fixed workload)' : '';
      return `- id=${t.id} | title="${(t.title || '(untitled)').replace(/"/g, "'")}" | type=${t.type || 'unspecified'}${goalNote} | course=${course ? course.name : 'none'} | due=${t.dueDate || 'none'} | scheduled=${t.scheduledDate || 'unscheduled'} | priority=${t.priority} | estHours=${t.estHours || '?'} | status=${t.status}`;
    }).join('\n');

    return [
      "You are helping a student reschedule overloaded/at-risk tasks. You have full context on each task below -- its type, due date, current scheduled date, priority, and estimated hours.",
      `Today is ${today}. Daily capacity goal: ~${Math.round(dailyCapacity * 10) / 10}h of flexible work per day.`,
      "Weigh each task's own priority (High/Medium/Low, the student's explicit and deliberate signal) ABOVE the type-based reschedulability hierarchy below -- a High-priority ToDo must keep its slot over a Low-priority PSET, not the other way around. Use the type hierarchy to break ties when two candidate tasks share the same priority, and use due date (the more overdue one first) to break ties within that.",
      reschedulabilityHierarchyText(),
      "Study/Review/Practice tasks are inherently lower priority and have variable time frames -- their hours are a goal the student set for themselves, not a hard commitment, so they're usually the easiest to shrink or move without real consequence (after Personal Task/ToDo), UNLESS the student has explicitly marked one High priority.",
      hwPsetNote(),
      '',
      'Tasks to consider:',
      taskLines,
      '',
      "Propose a new scheduledDate for any task that's overdue, overloading a day, or would benefit from moving -- respect priority first, the reschedulability hierarchy second (don't move a protected type like Exam/Quiz or PSET unless it's genuinely necessary or itself low priority), and don't move a task that's already fine where it is.",
      `CRITICAL CONSTRAINT: every newScheduledDate you propose MUST be ${today} or ${maxDate} at the absolute latest (today or the next ${RESCHEDULE_MAX_DAYS_OUT} days only) -- squeeze things into the immediate near-term, never defer further out, no matter how low-priority or reschedulable the task is. If something doesn't fit even within that window, still propose the nearest day within it rather than skipping it or pushing past it.`,
      `Reply in EXACTLY this format and nothing else (no extra commentary, no blank lines):`,
      'QUOTE: <one short, genuine motivational line for the student, under 20 words -- specific to how their day/week looks, not generic>',
      'Then one line per task you want to move (skip tasks you would leave alone):',
      '<id>|<newScheduledDate as YYYY-MM-DD, within the constraint above>|<one brief reason, under 15 words>',
      'Example: t_ab12cd34|2026-10-09|PSET due Friday needs the room exam prep is using today',
    ].join('\n');
  }

  // Defensive, line-by-line parse -- same spirit as
  // parseBatchEstimateResponse, omits any line that doesn't parse
  // cleanly or references an id outside the candidate set, rather than
  // failing the whole proposal over one bad line.
  function parseRescheduleResponse(text, expectedIds) {
    const idSet = new Set(expectedIds);
    const moves = [];
    const seen = new Set();
    let quote = '';
    text.split('\n').forEach(line => {
      const quoteMatch = line.match(/^QUOTE:\s*(.+)$/i);
      if (quoteMatch) { quote = quoteMatch[1].trim().replace(/^["']|["']$/g, ''); return; }
      const m = line.match(/([A-Za-z0-9_-]+)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.+)/);
      if (!m) return;
      const [, id, newScheduledDate, reason] = m;
      if (!idSet.has(id) || seen.has(id)) return;
      seen.add(id);
      moves.push({ id, newScheduledDate, reason: reason.trim().slice(0, 160) });
    });
    return { quote, moves };
  }

  // Returns {quote, moves: [{id, newScheduledDate, reason}]} -- a
  // PROPOSAL only, the caller is responsible for showing it to the
  // student and applying only what they approve (see js/main.js's
  // runAiSmartReschedule). newScheduledDate is clamped to
  // RESCHEDULE_MAX_DAYS_OUT regardless of what the model actually
  // returned -- the prompt instruction above is a first line of
  // defense, this is the real guarantee.
  async function suggestReschedulePlan(state, tasks) {
    if (!tasks.length) return { quote: '', moves: [] };
    const prompt = buildReschedulePrompt(state, tasks);
    const text = await complete(state, prompt);
    const result = parseRescheduleResponse(text, tasks.map(t => t.id));
    const today = DB.todayISO();
    const maxDate = DB.addDaysISO(today, RESCHEDULE_MAX_DAYS_OUT);
    result.moves.forEach(m => {
      if (DB.isoCompare(m.newScheduledDate, maxDate) > 0) m.newScheduledDate = maxDate;
      else if (DB.isoCompare(m.newScheduledDate, today) < 0) m.newScheduledDate = today;
    });
    return result;
  }

  // ---------------- AI Add/Edit Task (free text -> structured tasks) ----------------
  // The student types whatever's on their mind -- one task, several, or
  // a change to something that already exists -- and this turns it into
  // a structured PROPOSAL only. Same "AI suggests, you decide" posture
  // as AI Smart Reschedule: every NEW task and every EDIT is shown on a
  // review screen (js/main.js's runAiAddTaskGenerate/applyAiAddTasks)
  // the student approves/denies per-item before anything is actually
  // created or changed -- nothing here touches state.tasks directly.

  const EDITABLE_TASK_FIELDS = ['title', 'type', 'course', 'dueDate', 'scheduledDate', 'estHours', 'priority', 'status'];

  function buildAddTaskPrompt(state, text, candidates) {
    const today = DB.todayISO();
    const courseLines = (state.courses || []).filter(c => c.status === 'Active')
      .map(c => `- ${c.name}${c.code ? ` (${c.code})` : ''}`).join('\n') || '(no courses set up yet)';
    // Only open (not Done/Cancelled) tasks, nearest-due first, capped --
    // sending the full multi-thousand-task dataset on every quick-add
    // would be slow and expensive; this bounds the prompt to the window
    // someone is realistically trying to edit via a short command.
    const candidateLines = candidates.map(t => {
      const course = t.courseId ? (state.courses || []).find(c => c.id === t.courseId) : null;
      return `- id=${t.id} | title="${(t.title || '').replace(/"/g, "'")}" | type=${t.type} | course=${course ? course.name : 'none'} | due=${t.dueDate || 'none'} | scheduled=${t.scheduledDate || 'none'} | status=${t.status} | estHours=${t.estHours || '?'} | priority=${t.priority}`;
    }).join('\n') || '(no open tasks to reference)';

    return [
      "You are helping a student add or edit tasks in their planner from a short free-text request. The request may describe one task, several tasks, or a change to something that already exists (a due date move, marking something done, re-estimating hours, etc.).",
      `Today is ${today}.`,
      hwPsetNote(),
      `Valid task types (use exactly one of these): ${TASK_TYPES.join(', ')}.`,
      `Valid priorities: ${PRIORITY_OPTIONS.join(', ')}. Valid statuses: ${STATUS_OPTIONS.join(', ')}.`,
      'Known courses/categories (match by name if the request mentions one; if it clearly names a course not in this list, use that name anyway -- it will be created):',
      courseLines,
      '',
      "The student's own currently-open tasks (reference these ONLY if the request is clearly about editing one of them -- match by title, don't guess at a match that isn't clearly the same thing; when in doubt, propose a NEW task instead):",
      candidateLines,
      '',
      `Student's request: "${text.replace(/"/g, "'")}"`,
      '',
      'For each task to CREATE, reply with one line:',
      'NEW|<title>|<type>|<course name or none>|<due date YYYY-MM-DD or none>|<scheduled date YYYY-MM-DD or none>|<est hours as a number, or ? if unknown>|<priority>',
      'For each EXISTING task to EDIT, reply with one line (only include fields that actually change):',
      `EDIT|<id>|<field=value,field=value,...> -- fields may be: ${EDITABLE_TASK_FIELDS.join(', ')}`,
      "Default a new task's dueDate to scheduledDate (or vice versa) if the request only gives one of them. If nothing in the request needs a new task or an edit, reply with nothing at all. Reply with ONLY these lines, no headers, no commentary, no blank lines.",
    ].join('\n');
  }

  // Defensive, line-by-line parse, same philosophy as
  // parseRescheduleResponse -- a line that doesn't match cleanly, names
  // an unknown field, or references a task id outside the candidate set
  // is just skipped rather than failing the whole response. Every field
  // is validated/clamped against the real TASK_TYPES/PRIORITY_OPTIONS/
  // STATUS_OPTIONS lists and a strict date regex -- never trust a model
  // to only emit values that were actually offered to it.
  function parseAddTaskResponse(text, candidateIds) {
    const idSet = new Set(candidateIds);
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
    const items = [];
    text.split('\n').forEach(rawLine => {
      const line = rawLine.trim();
      if (!line) return;
      if (line.startsWith('NEW|')) {
        const parts = line.split('|');
        if (parts.length < 8) return;
        const [, title, type, course, dueDate, scheduledDate, estHoursRaw, priorityRaw] = parts;
        if (!title || !title.trim()) return;
        const estHoursNum = parseFloat(estHoursRaw);
        items.push({
          kind: 'new',
          fields: {
            title: title.trim().slice(0, 200),
            type: TASK_TYPES.includes(type.trim()) ? type.trim() : 'ToDo',
            courseName: course.trim().toLowerCase() === 'none' ? '' : course.trim(),
            dueDate: isDate(dueDate.trim()) ? dueDate.trim() : null,
            scheduledDate: isDate(scheduledDate.trim()) ? scheduledDate.trim() : null,
            estHours: Number.isFinite(estHoursNum) && estHoursNum > 0 ? Math.round(estHoursNum * 100) / 100 : '',
            priority: PRIORITY_OPTIONS.includes((priorityRaw || '').trim()) ? priorityRaw.trim() : 'Medium',
          },
        });
      } else if (line.startsWith('EDIT|')) {
        const m = line.match(/^EDIT\|([A-Za-z0-9_-]+)\|(.+)$/);
        if (!m) return;
        const [, id, fieldsStr] = m;
        if (!idSet.has(id)) return;
        const patch = {};
        fieldsStr.split(',').forEach(pair => {
          const eq = pair.indexOf('=');
          if (eq < 0) return;
          const key = pair.slice(0, eq).trim();
          const value = pair.slice(eq + 1).trim();
          if (!EDITABLE_TASK_FIELDS.includes(key) || !value) return;
          if (key === 'type') { if (TASK_TYPES.includes(value)) patch.type = value; return; }
          if (key === 'priority') { if (PRIORITY_OPTIONS.includes(value)) patch.priority = value; return; }
          if (key === 'status') { if (STATUS_OPTIONS.includes(value)) patch.status = value; return; }
          if (key === 'dueDate' || key === 'scheduledDate') { if (isDate(value)) patch[key] = value; return; }
          if (key === 'estHours') {
            const h = parseFloat(value);
            if (Number.isFinite(h) && h > 0) patch.estHours = Math.round(h * 100) / 100;
            return;
          }
          if (key === 'course') { patch.courseName = value; return; }
          if (key === 'title') { patch.title = value.slice(0, 200); return; }
        });
        if (Object.keys(patch).length) items.push({ kind: 'edit', id, patch });
      }
    });
    return items;
  }

  // Returns [{kind:'new', fields:{...}} | {kind:'edit', id, patch:{...}}]
  // -- a PROPOSAL only, same contract as suggestReschedulePlan. Resolving
  // a courseName string to a real courseId (creating the course if it
  // doesn't exist yet) deliberately happens later, only for items the
  // student actually approves -- see js/main.js's applyAiAddTasks --
  // so a denied item never leaves behind a phantom auto-created course.
  async function suggestTasksFromText(state, text, candidates) {
    if (!text || !text.trim()) return [];
    const prompt = buildAddTaskPrompt(state, text.trim(), candidates);
    const responseText = await complete(state, prompt);
    return parseAddTaskResponse(responseText, candidates.map(t => t.id));
  }

  return {
    isConfigured, providerLabel, complete, estimateTaskHours, dailyInsights,
    estimateTasksBatch, BULK_ESTIMATE_BATCH_SIZE,
    suggestReschedulePlan, suggestTasksFromText,
  };
})();
