/* ===================================================================
   canvas.js -- optional, opt-in Canvas LMS integration (BYOK: your
   institution's Canvas URL + your own personal access token, generated
   from Account -> Settings -> "+ New Access Token" in Canvas itself).

   Like js/ai.js, this is a deliberate exception to doOS staying fully
   local -- it only activates once a user pastes in their own token, and
   only talks to their own institution's Canvas instance.

   IMPORTANT, confirmed via Instructure's own issue tracker and developer
   docs (not guessed): Canvas's hosted instances never send an
   Access-Control-Allow-Origin header, and this is NOT configurable --
   there is no opt-in header the way Anthropic's API has one. A plain
   `fetch()` from a browser tab OR from inside Tauri's webview (which
   enforces the same CORS rules a real browser does) WILL be blocked.
   Inside the desktop build, doFetch() below routes around this via
   tauri-plugin-http (window.__TAURI__.http.fetch, registered in
   src-tauri/src/lib.rs) -- a request made through it runs in the Rust
   process itself, never through the webview's fetch(), so it isn't
   subject to CORS at all. In the plain browser build (or if that global
   isn't present for any reason), doFetch() falls back to plain fetch(),
   which still hits the CORS wall -- see corsBlockedError, still correct
   and still explained clearly rather than a confusing generic error.

   Future extension point, explicitly out of scope here: pulling in
   actual textbook content for even better estimates would hang off the
   same per-assignment description text this module already fetches.
=================================================================== */

const Canvas = (function () {
  function isConfigured(state) {
    const c = state && state.settings && state.settings.canvas;
    return !!(c && c.baseUrl && c.apiToken);
  }

  // Accepts "stanford.instructure.com", "https://stanford.instructure.com",
  // or with a trailing slash -- normalizes to a bare https:// origin.
  function apiBase(state) {
    let url = (state.settings.canvas.baseUrl || '').trim();
    url = url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return `https://${url}`;
  }

  function corsBlockedError() {
    const err = new Error(
      "Canvas can't be reached directly from here -- Canvas doesn't allow direct browser requests (confirmed: no CORS support on hosted instances, with no opt-in), " +
      "and this build can't find the desktop app's native networking to route around it. Try the desktop app if you're not already in it."
    );
    err.corsBlocked = true;
    return err;
  }

  // Inside Tauri, window.__TAURI__.http.fetch (tauri-plugin-http) is a
  // Fetch-API-compatible function that runs the actual request from the
  // Rust process -- no CORS involved, since CORS is a browser/webview
  // concept this never passes through. Everywhere else, plain fetch(),
  // which will still hit Canvas's CORS wall (see corsBlockedError).
  function doFetch(url, opts) {
    if (DB.isTauriEnv() && window.__TAURI__ && window.__TAURI__.http) {
      return window.__TAURI__.http.fetch(url, opts);
    }
    return fetch(url, opts);
  }

  async function canvasFetch(state, path, opts = {}) {
    const url = `${apiBase(state)}${path}`;
    let res;
    try {
      res = await doFetch(url, {
        method: opts.method || 'GET',
        headers: Object.assign(
          { Authorization: `Bearer ${state.settings.canvas.apiToken}` },
          opts.body ? { 'Content-Type': 'application/json' } : {}
        ),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      if (e instanceof TypeError) throw corsBlockedError();
      throw new Error(`Network error calling Canvas: ${e.message}`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const msg = (body && (body.message || (body.errors && body.errors[0] && body.errors[0].message))) || `HTTP ${res.status}`;
      throw new Error(`Canvas API error: ${msg}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function testConnection(state) {
    const me = await canvasFetch(state, '/api/v1/users/self');
    return me && me.name ? me.name : 'connected';
  }

  // Active, currently-enrolled courses only -- a student's full Canvas
  // history can span many terms, and only the current ones are relevant
  // to map against doOS courses.
  async function listCourses(state) {
    const courses = await canvasFetch(state, '/api/v1/courses?enrollment_state=active&per_page=100');
    return (courses || []).map(c => ({ id: c.id, name: c.name, code: c.course_code }));
  }

  // NOTE: fetches only the first 100 assignments per course (no
  // Link-header pagination follow-through) -- comfortably covers a
  // normal course's assignment list; a course with more than that would
  // need a follow-up fix, not attempted here to keep this scoped.
  async function listAssignments(state, canvasCourseId) {
    return canvasFetch(state, `/api/v1/courses/${canvasCourseId}/assignments?per_page=100&order_by=due_at`);
  }

  // Canvas assignment descriptions are HTML -- strip tags and collapse
  // whitespace for use as plain-text task notes / AI-estimate grounding.
  // Deliberately simple regex stripping, not a real HTML parser; good
  // enough for "readable plain text," not byte-perfect.
  function stripHtml(html) {
    if (!html) return '';
    return html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Best-effort type guess from the assignment name, same spirit as
  // istudiez.js's istd_estimate -- a starting point, not a measurement.
  function guessType(name) {
    const n = (name || '').toLowerCase();
    if (/exam|midterm|final|quiz/.test(n)) return 'Exam/Quiz';
    if (/lab|prelab/.test(n)) return 'Lab/Prelab';
    if (/lecture/.test(n)) return 'Lecture Videos';
    if (/reading|chapter/.test(n)) return 'Reading';
    if (/pset|problem set|homework|\bhw\b/.test(n)) return 'PSET';
    if (/project|milestone/.test(n)) return 'Project Milestone';
    if (/study|review|practice/.test(n)) return 'Study/Review/Practice';
    return 'ToDo';
  }

  // Bidirectional completion sync uses Canvas's Planner Override API --
  // confirmed via Instructure's own API docs there is no per-assignment
  // GET, so every sync lists ALL overrides for the current user once and
  // filters client-side by plannable_id. NOTE: same single-page
  // limitation as listAssignments -- no Link-header pagination follow.
  async function listPlannerOverrides(state) {
    return canvasFetch(state, '/api/v1/planner/overrides?per_page=100');
  }

  // Creates a new override if the task has never gotten one yet
  // (task.canvasOverrideId unset), otherwise updates the existing one --
  // callers pass whichever of marked_complete/dismissed changed, the
  // other is left alone by Canvas when omitted.
  async function setAssignmentOverride(state, assignmentId, overrideId, patch) {
    if (overrideId) {
      return canvasFetch(state, `/api/v1/planner/overrides/${overrideId}`, { method: 'PUT', body: patch });
    }
    return canvasFetch(state, '/api/v1/planner/overrides', {
      method: 'POST',
      body: Object.assign({ plannable_type: 'assignment', plannable_id: assignmentId }, patch),
    });
  }

  return {
    isConfigured, testConnection, listCourses, listAssignments, stripHtml, guessType,
    listPlannerOverrides, setAssignmentOverride,
  };
})();
