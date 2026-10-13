/* sample-seed-data.js -- fictional example data (a term, a few courses, a
   handful of tasks covering most task types/statuses) so a fresh install
   of doOS opens to a populated, representative dashboard instead of a
   blank one. Loaded exactly once, only into a browser that has never held
   any real content yet -- see DB.maybeBootstrapSampleSeed(). Contains no
   real person's data; every date below is computed relative to today, not
   hardcoded, so the demo never looks stale no matter when it's opened. */
const SAMPLE_SEED_DATA = (function () {
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  const now = new Date();
  function add(days) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() + days);
    return ymd(d);
  }
  // 0=Sun..6=Sat, matching DB.dayIndex's convention used by course meetings.
  const todayDow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getDay();

  const quarterId = 'q_sample_term';
  const csId = 'c_sample_cs';
  const calcId = 'c_sample_calc';
  const histId = 'c_sample_hist';
  const clubId = 'c_sample_club';

  return {
    quarters: [
      { id: quarterId, name: 'Fall Term', year: '', season: 'Autumn', startDate: add(-42), endDate: add(60), status: 'Active', notes: 'Example term -- edit or delete this and add your own.' },
    ],
    courses: [
      { id: csId, name: 'Intro to Computer Science', type: 'Academic Class', code: 'CS 101', units: 0, location: '', instructor: 'Prof. Rivera', targetGrade: '', quarterId, status: 'Active', color: '#8b5cf6', exams: [], meetings: [{ id: 'm_sample_cs', label: 'Lecture', daysOfWeek: [1, 3, 5], startTime: '10:00', endTime: '10:50' }], canvasCourseId: '' },
      { id: calcId, name: 'Calculus II', type: 'Academic Class', code: 'MATH 102', units: 0, location: '', instructor: 'Prof. Okafor', targetGrade: '', quarterId, status: 'Active', color: '#3b82f6', exams: [], meetings: [{ id: 'm_sample_calc', label: 'Lecture', daysOfWeek: [2, 4], startTime: '13:00', endTime: '14:20' }], canvasCourseId: '' },
      { id: histId, name: 'World History', type: 'Academic Class', code: 'HIST 50', units: 0, location: '', instructor: 'Prof. Lindqvist', targetGrade: '', quarterId, status: 'Active', color: '#f59e0b', exams: [], meetings: [{ id: 'm_sample_hist', label: 'Seminar', daysOfWeek: [1, 3], startTime: '15:00', endTime: '16:15' }], canvasCourseId: '' },
      { id: clubId, name: 'Robotics Club', type: 'Extracurricular/Club', code: '', units: 0, location: '', instructor: '', targetGrade: '', quarterId, status: 'Active', color: '#30a46c', exams: [], meetings: [{ id: 'm_sample_club', label: 'Meeting', daysOfWeek: [4], startTime: '18:00', endTime: '19:30' }], canvasCourseId: '' },
    ],
    tasks: [
      { id: 't_sample_1', title: 'Problem Set 3', type: 'PSET', courseId: csId, dueDate: add(2), scheduledDate: add(1), estHours: 4, actualHours: 0, energy: 'high', needHelp: false, status: 'To Do', priority: 'High', notes: '', recurrence: null, isTemplate: false, seriesId: null, startTime: null, endTime: null, splitGroupId: null, splitIndex: null, splitTotal: null, autoplanned: false, subtasks: [], calendarId: null, canvasAssignmentId: null, canvasOverrideId: null, timeLog: [], createdAt: now.getTime() },
      { id: 't_sample_2', title: 'Midterm Exam', type: 'Exam/Quiz', courseId: calcId, dueDate: add(9), scheduledDate: null, estHours: 3, actualHours: 0, energy: 'high', needHelp: false, status: 'To Do', priority: 'High', notes: 'Covers chapters 1-5 -- integration techniques and series.', recurrence: null, isTemplate: false, seriesId: null, startTime: null, endTime: null, splitGroupId: null, splitIndex: null, splitTotal: null, autoplanned: false, subtasks: [], calendarId: null, canvasAssignmentId: null, canvasOverrideId: null, timeLog: [], createdAt: now.getTime() },
      { id: 't_sample_3', title: 'Chapters 5 & 6', type: 'Reading', courseId: histId, dueDate: add(1), scheduledDate: add(1), estHours: 1.5, actualHours: 0, energy: 'medium', needHelp: false, status: 'To Do', priority: 'Medium', notes: '', recurrence: null, isTemplate: false, seriesId: null, startTime: null, endTime: null, splitGroupId: null, splitIndex: null, splitTotal: null, autoplanned: false, subtasks: [], calendarId: null, canvasAssignmentId: null, canvasOverrideId: null, timeLog: [], createdAt: now.getTime() },
      { id: 't_sample_4', title: 'Lab 2 Prelab', type: 'Lab/Prelab', courseId: csId, dueDate: add(3), scheduledDate: null, estHours: 1, actualHours: 0, energy: 'medium', needHelp: false, status: 'Backlog', priority: 'Medium', notes: '', recurrence: null, isTemplate: false, seriesId: null, startTime: null, endTime: null, splitGroupId: null, splitIndex: null, splitTotal: null, autoplanned: false, subtasks: [], calendarId: null, canvasAssignmentId: null, canvasOverrideId: null, timeLog: [], createdAt: now.getTime() },
      { id: 't_sample_5', title: 'Review derivatives', type: 'Study/Review/Practice', courseId: calcId, dueDate: add(5), scheduledDate: null, estHours: 2, actualHours: 0, energy: 'medium', needHelp: false, status: 'To Do', priority: 'Medium', notes: '', recurrence: null, isTemplate: false, seriesId: null, startTime: null, endTime: null, splitGroupId: null, splitIndex: null, splitTotal: null, autoplanned: false, subtasks: [], calendarId: null, canvasAssignmentId: null, canvasOverrideId: null, timeLog: [], createdAt: now.getTime() },
      { id: 't_sample_6', title: 'Robotics prototype v1', type: 'Project Milestone', courseId: clubId, dueDate: add(10), scheduledDate: null, estHours: 5, actualHours: 0, energy: 'medium', needHelp: false, status: 'To Do', priority: 'High', notes: '', recurrence: null, isTemplate: false, seriesId: null, startTime: null, endTime: null, splitGroupId: null, splitIndex: null, splitTotal: null, autoplanned: false, subtasks: [{ id: 'st_sample_1', title: 'Wire up motor controllers', done: true }, { id: 'st_sample_2', title: 'Write basic control loop', done: false }], calendarId: null, canvasAssignmentId: null, canvasOverrideId: null, timeLog: [], createdAt: now.getTime() },
      { id: 't_sample_7', title: 'Email professor about office hours', type: 'ToDo', courseId: '', dueDate: add(1), scheduledDate: null, estHours: 0.25, actualHours: 0, energy: 'medium', needHelp: false, status: 'To Do', priority: 'Low', notes: '', recurrence: null, isTemplate: false, seriesId: null, startTime: null, endTime: null, splitGroupId: null, splitIndex: null, splitTotal: null, autoplanned: false, subtasks: [], calendarId: null, canvasAssignmentId: null, canvasOverrideId: null, timeLog: [], createdAt: now.getTime() },
      { id: 't_sample_8', title: 'Grocery shopping', type: 'Personal Task', courseId: '', dueDate: add(0), scheduledDate: null, estHours: 0.5, actualHours: 0, energy: 'medium', needHelp: false, status: 'To Do', priority: 'Low', notes: '', recurrence: null, isTemplate: false, seriesId: null, startTime: null, endTime: null, splitGroupId: null, splitIndex: null, splitTotal: null, autoplanned: false, subtasks: [], calendarId: null, canvasAssignmentId: null, canvasOverrideId: null, timeLog: [], createdAt: now.getTime() },
      { id: 't_sample_9', title: 'Chapter 3 Reading', type: 'Reading', courseId: histId, dueDate: add(-2), scheduledDate: add(-2), estHours: 1, actualHours: 0, energy: 'medium', needHelp: false, status: 'Backlog', priority: 'Medium', notes: '', recurrence: null, isTemplate: false, seriesId: null, startTime: null, endTime: null, splitGroupId: null, splitIndex: null, splitTotal: null, autoplanned: false, subtasks: [], calendarId: null, canvasAssignmentId: null, canvasOverrideId: null, timeLog: [], createdAt: now.getTime() },
      { id: 't_sample_10', title: 'Problem Set 2', type: 'PSET', courseId: csId, dueDate: add(-5), scheduledDate: add(-5), estHours: 3, actualHours: 3.5, energy: 'medium', needHelp: false, status: 'Done', priority: 'High', notes: '', recurrence: null, isTemplate: false, seriesId: null, startTime: null, endTime: null, splitGroupId: null, splitIndex: null, splitTotal: null, autoplanned: false, subtasks: [], calendarId: null, canvasAssignmentId: null, canvasOverrideId: null, timeLog: [], createdAt: now.getTime() },
      { id: 't_sample_11', title: 'Quiz 1', type: 'Exam/Quiz', courseId: calcId, dueDate: add(-10), scheduledDate: add(-10), estHours: 1, actualHours: 1.25, energy: 'medium', needHelp: false, status: 'Done', priority: 'Medium', notes: '', recurrence: null, isTemplate: false, seriesId: null, startTime: null, endTime: null, splitGroupId: null, splitIndex: null, splitTotal: null, autoplanned: false, subtasks: [], calendarId: null, canvasAssignmentId: null, canvasOverrideId: null, timeLog: [], createdAt: now.getTime() },
      // Recurring template only -- no baked-in instance. DB.maybeBootstrapSampleSeed
      // runs Recurrence.generateUpcoming right after seeding, which materializes
      // the correct occurrence for whatever "today" actually is, same as any
      // other recurring task created by hand.
      { id: 't_sample_12', title: 'Weekly reading check-in', type: 'Study/Review/Practice', courseId: histId, dueDate: null, scheduledDate: null, estHours: 1, actualHours: 0, energy: 'medium', needHelp: false, status: 'To Do', priority: 'Low', notes: '', recurrence: { freq: 'weekly', interval: 1, daysOfWeek: [todayDow], startDate: add(0), endDate: null, count: null }, isTemplate: true, seriesId: null, startTime: null, endTime: null, splitGroupId: null, splitIndex: null, splitTotal: null, autoplanned: false, subtasks: [], calendarId: null, canvasAssignmentId: null, canvasOverrideId: null, timeLog: [], createdAt: now.getTime() },
    ],
    taskHistory: [],
    settings: { theme: 'light', capacityHoursPerWeek: 25 },
  };
})();
