export const SCHEMA = `
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT, email TEXT, phone TEXT, city TEXT, state TEXT, linkedin TEXT,
  work_authorization TEXT, needs_sponsorship INTEGER,
  pay_floor INTEGER, work_modes TEXT, target_titles TEXT
);
CREATE TABLE IF NOT EXISTS experience (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employer TEXT NOT NULL, title TEXT NOT NULL, start TEXT, end TEXT,
  bullets TEXT NOT NULL DEFAULT '[]',  -- JSON: [{text, verified}]
  skills TEXT NOT NULL DEFAULT '[]',
  people_managed INTEGER, team_size INTEGER, is_side_project INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_pattern TEXT NOT NULL, answer TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user-confirmed'
);
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE, ats TEXT, title TEXT, company TEXT,
  pay_min INTEGER, pay_max INTEGER, work_mode TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','scored','drafted','queued','submitted','skipped','needs_user')),
  skip_reason TEXT, posting_text TEXT, posted_at TEXT, fit_score INTEGER, stretch_notes TEXT
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  resume_version TEXT, cover_letter TEXT, submitted_at TEXT,
  confirmation_url TEXT, screenshot_before TEXT, screenshot_after TEXT,
  response_status TEXT DEFAULT 'no_response', response_date TEXT,
  variant TEXT CHECK (variant IN ('tailored','control')),
  attempt_status TEXT NOT NULL DEFAULT 'planned', notes TEXT
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  json TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ats TEXT NOT NULL CHECK (ats IN ('greenhouse','lever','ashby')),
  token TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  last_polled_at TEXT, last_error TEXT, job_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ats, token)
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE, label TEXT NOT NULL, kind TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0, sensitivity TEXT NOT NULL DEFAULT 'none',
  seen_count INTEGER NOT NULL DEFAULT 0, companies TEXT NOT NULL DEFAULT '[]',
  suggestion TEXT NOT NULL DEFAULT '', basis TEXT NOT NULL DEFAULT '', dismissed INTEGER NOT NULL DEFAULT 0, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS question_sightings (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE, job_url TEXT NOT NULL, UNIQUE (question_id, job_url)
);
CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL UNIQUE, job_id INTEGER NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('tailored','control')),
  excluded INTEGER NOT NULL DEFAULT 0, -- user opted out of the experiment for this posting
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS past_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  applied_at TEXT, note TEXT NOT NULL DEFAULT ''
);
-- Job-response emails the app recognized. Only a short summary is kept, never the message body.
CREATE TABLE IF NOT EXISTS email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, msg_hash TEXT NOT NULL UNIQUE, date TEXT, from_addr TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL, company TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', confidence TEXT NOT NULL DEFAULT 'medium', evidence TEXT NOT NULL DEFAULT '',
  application_id INTEGER, applied INTEGER NOT NULL DEFAULT 0, prev_status TEXT, prev_date TEXT, added_past INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0
);
-- Hashes of messages already looked at (kept or not), so they are never reprocessed. No content.
CREATE TABLE IF NOT EXISTS email_seen (hash TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`
