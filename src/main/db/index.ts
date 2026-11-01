import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { SCHEMA } from './schema'

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(join(app.getPath('userData'), 'applimax.db'))
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    // Migrations for databases created before these columns existed.
    const addColumn = (table: string, col: string, def: string): void => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
    }
    addColumn('jobs', 'posting_text', 'TEXT')
    addColumn('applications', 'attempt_status', "TEXT NOT NULL DEFAULT 'planned'")
    addColumn('applications', 'notes', 'TEXT')
    addColumn('past_applications', 'job_id', 'INTEGER')
    addColumn('facts', 'previous_text', "TEXT NOT NULL DEFAULT ''")
    addColumn('questions', 'group_id', 'INTEGER')
    addColumn('questions', 'analyzed', 'INTEGER NOT NULL DEFAULT 0')
    addColumn('questions', 'years_subject', "TEXT NOT NULL DEFAULT ''")
    addColumn('questions', 'years_roles', "TEXT NOT NULL DEFAULT '[]'")
    addColumn('questions', 'years_overall', 'INTEGER NOT NULL DEFAULT 0')
    addColumn('boards', 'source', "TEXT NOT NULL DEFAULT 'manual'")
    addColumn('applications', 'draft_id', 'INTEGER')
    addColumn('stories', 'tags', "TEXT NOT NULL DEFAULT ''")
    addColumn('answers', 'question_id', 'INTEGER')
    addColumn('facts', 'source', "TEXT NOT NULL DEFAULT 'user'")
    addColumn('facts', 'confirmed', 'INTEGER NOT NULL DEFAULT 1')
    addColumn('facts', 'evidence', "TEXT NOT NULL DEFAULT ''")
    addColumn('jobs', 'board_id', 'INTEGER')
    addColumn('jobs', 'external_id', 'TEXT')
    addColumn('jobs', 'location', 'TEXT')
    addColumn('jobs', 'pay_note', 'TEXT')
    addColumn('jobs', 'triage_score', 'INTEGER')
    addColumn('jobs', 'reasons', 'TEXT')
    addColumn('jobs', 'blockers', 'TEXT')
    addColumn('jobs', 'first_seen_at', 'TEXT')
  }
  return db
}
