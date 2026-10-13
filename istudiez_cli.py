#!/usr/bin/env python3
"""
istudiez_cli.py
---------------
Optional batch/offline companion to the doOS web app.

The doOS dashboard (index.html) already has a built-in iStudiez importer
under the "Import iStudiez" tab -- drag a .ics/.csv there and it merges
straight into your live data, recurring classes included. Use THIS script
only if you'd rather convert a big export on the command line first, e.g.
to inspect it, batch-process several files, or do a one-time "fresh start"
migration of your entire iStudiez history into doOS.

It parses an iStudiez Pro .ics (calendar) export, .csv (assignment list)
export, or a full .istd data backup (the file iStudiez writes from
Settings -> Backup, a zip containing a real SQLite database) and writes a
doOS-compatible backup JSON file. That file can be loaded via Settings ->
"Restore from Backup" in the app -- note this REPLACES whatever is
currently in the browser, exactly like any other backup restore.

USAGE
-----
    python3 istudiez_cli.py <input.ics|input.csv|input.istd> [output.json]

    python3 istudiez_cli.py "iStudiez Pro Data Backup.istd"
    python3 istudiez_cli.py MyStanfordSchedule.ics doos_import_backup.json

No third-party packages required -- pure Python 3 standard library
(including sqlite3 and zipfile for .istd).
"""

import argparse
import csv
import hashlib
import json
import os
import random
import re
import sqlite3
import sys
import tempfile
import time
import zipfile
from datetime import datetime, date, timedelta

TYPE_RULES = [
    (re.compile(r"assignment|homework|problem ?set|pset", re.I), "PSET"),
    (re.compile(r"lab|prelab|discussion|section", re.I), "Lab/Prelab"),
    (re.compile(r"exam|quiz|midterm|final|test", re.I), "Exam/Quiz"),
    (re.compile(r"reading|paper|essay", re.I), "Reading"),
    (re.compile(r"meeting|club|event", re.I), "Club Meeting"),
    (re.compile(r"project|milestone", re.I), "Project Milestone"),
    (re.compile(r"habit|routine", re.I), "Habit"),
]

BYDAY_MAP = {"SU": 0, "MO": 1, "TU": 2, "WE": 3, "TH": 4, "FR": 5, "SA": 6}

PALETTE = ["#8b5cf6", "#3b82f6", "#06b6d4", "#ec4899", "#f59e0b", "#30a46c"]


def uid(prefix):
    return f"{prefix}_{int(time.time() * 1000):x}_{random.randint(0, 999999):x}"


def guess_type(*texts):
    hay = " ".join(t for t in texts if t)
    for pattern, task_type in TYPE_RULES:
        if pattern.search(hay):
            return task_type
    return "ToDo"


def unfold_ics(raw_text):
    lines = raw_text.replace("\r\n", "\n").split("\n")
    out = []
    for line in lines:
        if line.startswith((" ", "\t")) and out:
            out[-1] += line[1:]
        else:
            out.append(line)
    return out


def ics_date_to_iso(raw):
    if not raw:
        return None
    m = re.match(r"^(\d{4})(\d{2})(\d{2})", raw)
    if not m:
        return None
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"


def parse_rrule(rrule, dtstart_iso):
    if not rrule or not dtstart_iso:
        return None
    parts = {}
    for p in rrule.split(";"):
        if "=" in p:
            k, v = p.split("=", 1)
            parts[k.upper()] = v

    freq_raw = parts.get("FREQ")
    freq = "daily" if freq_raw == "DAILY" else "weekly" if freq_raw == "WEEKLY" else None
    if not freq:
        return None  # MONTHLY / YEARLY not modeled in doOS

    rule = {
        "freq": freq,
        "interval": int(parts["INTERVAL"]) if "INTERVAL" in parts else 1,
        "startDate": dtstart_iso,
        "endDate": ics_date_to_iso(parts["UNTIL"]) if "UNTIL" in parts else None,
        "count": int(parts["COUNT"]) if "COUNT" in parts else None,
        "daysOfWeek": None,
    }
    if "BYDAY" in parts:
        rule["daysOfWeek"] = [BYDAY_MAP[d.strip().upper()] for d in parts["BYDAY"].split(",") if d.strip().upper() in BYDAY_MAP]
    return rule


def parse_ics(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()

    events, current = [], None
    for line in unfold_ics(raw):
        stripped = line.strip()
        if stripped == "BEGIN:VEVENT":
            current = {}
            continue
        if stripped == "END:VEVENT":
            if current is not None:
                events.append(current)
            current = None
            continue
        if current is None or ":" not in stripped:
            continue
        key_part, value = stripped.split(":", 1)
        key = key_part.split(";", 1)[0].upper()
        current[key] = value

    records = []
    for ev in events:
        title = ev.get("SUMMARY", "Untitled iStudiez Event").strip()
        category = ev.get("CATEGORIES", "").strip()
        location = ev.get("LOCATION", "").strip()
        description = ev.get("DESCRIPTION", "").replace("\\n", " ").replace("\\,", ",").strip()
        due_date = ics_date_to_iso(ev.get("DTSTART", ""))
        if not due_date:
            continue
        recurrence = parse_rrule(ev.get("RRULE"), due_date)
        notes = " | ".join(p for p in (description, f"Location: {location}" if location else "") if p)
        records.append({
            "title": title,
            "type": guess_type(category, title),
            "course": category,
            "due_date": due_date,
            "recurrence": recurrence,
            "notes": notes,
        })
    return records


CSV_ALIASES = {
    "title": ["title", "name", "assignment", "summary", "task"],
    "type": ["type", "category", "categories", "kind"],
    "course": ["course", "class", "subject"],
    "due_date": ["due date", "due", "date", "deadline"],
    "notes": ["notes", "description", "details", "note"],
}


def parse_date_any(value):
    if not value:
        return None
    value = value.strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", value)
    if m:
        return m.group(0)
    for fmt in ("%m/%d/%Y", "%m-%d-%Y", "%m/%d/%y", "%B %d, %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def parse_csv(path):
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        lower_map = {fn.strip().lower(): fn for fn in fieldnames}
        lookup = {}
        for field, aliases in CSV_ALIASES.items():
            lookup[field] = next((lower_map[a] for a in aliases if a in lower_map), None)

        records = []
        for row in reader:
            def get(field):
                col = lookup.get(field)
                return (row.get(col) or "").strip() if col else ""

            title = get("title") or "Untitled iStudiez Task"
            due_date = parse_date_any(get("due_date"))
            records.append({
                "title": title,
                "type": guess_type(get("type"), title),
                "course": get("course"),
                "due_date": due_date,
                "recurrence": None,
                "notes": get("notes"),
            })
    return records


def build_doos_backup(records):
    courses_by_name = {}
    courses = []
    tasks = []

    def course_id_for(name):
        if not name:
            return ""
        key = name.lower()
        if key in courses_by_name:
            return courses_by_name[key]
        course = {
            "id": uid("c"),
            "name": name,
            "type": "Academic Class",
            "code": "",
            "units": 0,
            "location": "",
            "instructor": "",
            "targetGrade": "",
            "quarterId": "",
            "status": "Active",
            "color": PALETTE[len(courses) % len(PALETTE)],
        }
        courses.append(course)
        courses_by_name[key] = course["id"]
        return course["id"]

    for r in records:
        course_id = course_id_for(r["course"])
        is_template = r["recurrence"] is not None
        tasks.append({
            "id": uid("t"),
            "title": r["title"],
            "type": r["type"],
            "courseId": course_id,
            "dueDate": r["due_date"],
            "scheduledDate": r["due_date"],
            "estHours": "",
            "actualHours": 0,
            "energy": "medium",
            "needHelp": False,
            "status": "To Do",
            "priority": "Medium",
            "notes": r["notes"],
            "recurrence": r["recurrence"],
            "isTemplate": is_template,
            "seriesId": None,
            "createdAt": int(time.time() * 1000),
        })

    return {
        "quarters": [{
            "id": uid("q"),
            "name": "Imported Term",
            "year": str(date.today().year),
            "season": "Autumn",
            "startDate": date.today().isoformat(),
            "endDate": date.today().isoformat(),
            "status": "Active",
            "notes": "Placeholder term created by istudiez_cli.py -- edit it in the Quarters tab.",
        }],
        "courses": courses,
        "tasks": tasks,
        "settings": {"theme": "light", "capacityHoursPerWeek": 30},
    }


# ===========================================================================
# .istd parsing -- a real iStudiez Data Backup: a zip containing main.db
# (a SQLite database with semesters/courses/assignments/exams/occurrences)
# and meta.xml. Dates are stored as a plain integer day count since the
# Unix epoch (1970-01-01) -- no time-of-day, no timezone to worry about.
# ===========================================================================

ISTD_EPOCH = date(1970, 1, 1)

ISTD_PRIORITY_MAP = {0: "Low", 1: "Medium", 2: "High"}

# (pattern, doOS Task Type, estimated hours). First match wins. These are
# this assistant's own best-effort estimates (iStudiez has no time-tracking
# field at all) based on how these abbreviations are actually used in real
# Stanford course structures -- PCRQ (Pre-Class Reading Quiz), DW (Discussion
# Worksheet), PLP (Pre-Lecture Problem) -- not a measurement of anything.
ISTD_TYPE_HOUR_RULES = [
    (re.compile(r"lab safety|sign[- ]?up for lab|ppe pickup|plan for lab|pickup", re.I), ("ToDo", 0.5)),
    (re.compile(r"\bplp\b", re.I), ("PSET", 2.0)),
    (re.compile(r"\bpcrq\b", re.I), ("Reading", 0.75)),
    (re.compile(r"\bdw\b|discussion worksheet", re.I), ("Lab/Prelab", 1.0)),
    (re.compile(r"problem ?set|\bpset\b|assignment", re.I), ("PSET", None)),  # hours filled in via PSET_HOUR_RANGE
    (re.compile(r"pre[- ]?lab|prelab", re.I), ("Lab/Prelab", 1.5)),
    (re.compile(r"\blab\b", re.I), ("Lab/Prelab", 2.0)),
    (re.compile(r"exam|midterm|final\b|quiz", re.I), ("Exam/Quiz", 3.0)),
    (re.compile(r"lecture|chapters|\bread\b|reading|memoriz|\bstudy\b|scribe|review", re.I), ("Reading", 1.0)),
    (re.compile(r"project|milestone|presentation", re.I), ("Project Milestone", 3.0)),
    (re.compile(r"meeting|practice|rehearsal|interview", re.I), ("Club Meeting", 1.0)),
]
PSET_HOUR_RANGE = (6, 9)  # per the user: "PSETs usually take 6-9 hours"


def istd_estimate(title):
    """Returns (type, estHours) using keyword heuristics. A real problem
    set gets a stable-but-varied value in PSET_HOUR_RANGE (hashed from the
    title, so re-running the import gives the same numbers, not random
    ones) rather than a flat constant -- some psets are bigger than others
    and a single repeated number would look fake."""
    for pattern, (task_type, hours) in ISTD_TYPE_HOUR_RULES:
        if pattern.search(title):
            if hours is None:  # PSET-range case
                span = PSET_HOUR_RANGE[1] - PSET_HOUR_RANGE[0]
                offset = int(hashlib.md5(title.encode("utf-8")).hexdigest(), 16) % (span + 1)
                hours = PSET_HOUR_RANGE[0] + offset
            return task_type, float(hours)
    return "ToDo", 0.75


def istd_course_type(course_name, semester_name):
    name = course_name.strip()
    if re.match(r"^[A-Za-z&]+\s*\d", name):  # e.g. "ENGR 40M", "Chem 31A", "PWR 1"
        return "Academic Class"
    if name.lower() == "general":
        return "Personal/Life Project"
    if "spacex" in name.lower() or "spacex" in semester_name.lower():
        return "Campus Job"
    if name.lower() in ("stanford",):
        return "Personal/Life Project"
    return "Extracurricular/Club"


def istd_season_for_month(m):
    if m in (9, 10, 11):
        return "Autumn"
    if m in (12, 1, 2):
        return "Winter"
    if m in (3, 4, 5):
        return "Spring"
    return "Summer"


def parse_istd(path):
    """Unzips the .istd backup and pulls semesters/courses/assignments out
    of its embedded SQLite database."""
    with tempfile.TemporaryDirectory() as tmp:
        with zipfile.ZipFile(path) as z:
            z.extract("main.db", tmp)
        conn = sqlite3.connect(os.path.join(tmp, "main.db"))
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT uid, name, start_date, duration FROM semesters WHERE DEL=0")
        semesters = [dict(r) for r in cur.fetchall()]
        cur.execute("SELECT uid, name, courseID, semester_uid, color_index FROM courses WHERE DEL=0")
        courses = [dict(r) for r in cur.fetchall()]
        cur.execute("SELECT uid, name, due_date, complete, priority, course_uid, notes FROM assignments WHERE DEL=0")
        assignments = [dict(r) for r in cur.fetchall()]
        conn.close()
    return semesters, courses, assignments


def build_doos_backup_from_istd(path, include_all_history=False):
    semesters, courses, assignments = parse_istd(path)
    today = date.today()

    quarters = []
    quarter_id_by_semester_uid = {}
    for s in semesters:
        start = ISTD_EPOCH + timedelta(days=s["start_date"]) if s["start_date"] is not None else today
        end = start + timedelta(days=s["duration"] or 0)
        status = "Active" if start <= today <= end else ("Upcoming" if start > today else "Archived")
        qid = uid("q")
        quarter_id_by_semester_uid[s["uid"]] = {"id": qid, "status": status}
        quarters.append({
            "id": qid,
            "name": s["name"] or "Imported Term",
            "year": f"{start.year}-{start.year + 1}" if start.month >= 7 else f"{start.year - 1}-{start.year}",
            "season": istd_season_for_month(start.month),
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "status": status,
            "notes": "Imported from iStudiez Pro Data Backup.",
        })

    doos_courses = []
    course_id_by_uid = {}
    active_course_uids = set()
    for c in courses:
        sem = quarter_id_by_semester_uid.get(c["semester_uid"])
        quarter_id = sem["id"] if sem else ""
        status = "Active" if sem and sem["status"] == "Active" else "Archived"
        semester_name = next((s["name"] for s in semesters if s["uid"] == c["semester_uid"]), "")
        cid = uid("c")
        course_id_by_uid[c["uid"]] = cid
        if status == "Active":
            active_course_uids.add(c["uid"])
        palette_idx = (c["color_index"] or 0) % len(PALETTE)
        doos_courses.append({
            "id": cid,
            "name": c["name"] or "Untitled Course",
            "type": istd_course_type(c["name"] or "", semester_name),
            "code": c["courseID"] or "",
            "units": 0,
            "location": "",
            "instructor": "",
            "targetGrade": "",
            "quarterId": quarter_id,
            "status": status,
            "color": PALETTE[palette_idx],
            "exams": [],
        })

    # By default only the currently-active semester's assignments become
    # live tasks -- the rest is years of already-completed history. Pass
    # include_all_history=True to bring in every term's assignments too.
    tasks = []
    for a in assignments:
        if not include_all_history and a["course_uid"] not in active_course_uids:
            continue
        title = (a["name"] or "Untitled Task").strip()
        due_iso = (ISTD_EPOCH + timedelta(days=a["due_date"])).isoformat() if a["due_date"] is not None else None
        task_type, est_hours = istd_estimate(title)
        complete = bool(a["complete"])
        if complete:
            status = "Done"
        elif due_iso and due_iso < today.isoformat():
            status = "Backlog"
        else:
            status = "To Do"
        tasks.append({
            "id": uid("t"),
            "title": title,
            "type": task_type,
            "courseId": course_id_by_uid.get(a["course_uid"], ""),
            "dueDate": due_iso,
            "scheduledDate": due_iso,
            "estHours": est_hours,
            "actualHours": 0,  # iStudiez never recorded real time spent -- 0 is honest, not a guess
            "energy": "medium",
            "needHelp": False,
            "status": status,
            "priority": ISTD_PRIORITY_MAP.get(a["priority"], "Medium"),
            "notes": (a["notes"] or "").strip(),
            "recurrence": None,
            "isTemplate": False,
            "seriesId": None,
            "startTime": None,
            "endTime": None,
            "splitGroupId": None,
            "splitIndex": None,
            "splitTotal": None,
            "autoplanned": False,
            "subtasks": [],
            "createdAt": int(time.time() * 1000),
        })

    return {
        "quarters": quarters,
        "courses": doos_courses,
        "tasks": tasks,
        "taskHistory": [],
        "settings": {"theme": "light", "capacityHoursPerWeek": 30},
    }


def main():
    parser = argparse.ArgumentParser(description="Convert an iStudiez Pro export into a doOS backup JSON file.")
    parser.add_argument("input_file", help="Path to the iStudiez .ics, .csv, or .istd export")
    parser.add_argument("output_file", nargs="?", default="doos_import_backup.json",
                         help="Path to write the doOS backup JSON (default: doos_import_backup.json)")
    parser.add_argument("--all-history", action="store_true",
                         help="(.istd only) Import every term's assignments as tasks, not just the active term's.")
    args = parser.parse_args()

    if not os.path.isfile(args.input_file):
        print(f"ERROR: input file not found: {args.input_file}", file=sys.stderr)
        sys.exit(1)

    ext = os.path.splitext(args.input_file)[1].lower()

    if ext == ".istd":
        backup = build_doos_backup_from_istd(args.input_file, include_all_history=args.all_history)
        with open(args.output_file, "w", encoding="utf-8") as f:
            json.dump(backup, f, indent=2)
        active_q = next((q for q in backup["quarters"] if q["status"] == "Active"), None)
        print(f"Converted iStudiez backup: {len(backup['quarters'])} term(s), {len(backup['courses'])} course(s), "
              f"{len(backup['tasks'])} task(s) -> '{args.output_file}'")
        if active_q and not args.all_history:
            print(f"Tasks were pulled only from the active term ('{active_q['name']}') -- pass --all-history "
                  "to bring in every term's assignments too.")
        print('Next step: in doOS, go to Settings -> "Restore from Backup" and select this file. '
              "This REPLACES whatever is currently in the app.")
        return

    if ext == ".ics":
        records = parse_ics(args.input_file)
    elif ext == ".csv":
        records = parse_csv(args.input_file)
    else:
        print(f"ERROR: unsupported file type '{ext}'. Expected .ics, .csv, or .istd.", file=sys.stderr)
        sys.exit(1)

    if not records:
        print("WARNING: no events/rows found -- writing an empty doOS backup.", file=sys.stderr)

    backup = build_doos_backup(records)
    with open(args.output_file, "w", encoding="utf-8") as f:
        json.dump(backup, f, indent=2)

    series = sum(1 for t in backup["tasks"] if t["isTemplate"])
    print(f"Converted {len(records)} item(s) ({series} recurring series, {len(backup['courses'])} courses) "
          f"-> '{args.output_file}'")
    print('Next step: in doOS, go to Settings -> "Restore from Backup" and select this file. '
          "This REPLACES whatever is currently in the app.")


if __name__ == "__main__":
    main()
