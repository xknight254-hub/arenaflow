import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "arenaflow.db");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let rawDb: Database.Database | null = null;
let initialized = false;

export function initializeDatabase(): Database.Database {
  if (rawDb && initialized) return rawDb;

  rawDb = new Database(DB_PATH);
  rawDb.pragma("journal_mode = WAL");
  rawDb.pragma("foreign_keys = ON");

  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      avatar_url TEXT,
      is_admin INTEGER DEFAULT 0,
      is_super_admin INTEGER DEFAULT 0,
      telegram_id TEXT,
      telegram_username TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      platform TEXT DEFAULT 'generic',
      format TEXT NOT NULL DEFAULT 'knockout',
      max_players INTEGER NOT NULL DEFAULT 32,
      best_of INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'registration_open',
      owner_id INTEGER NOT NULL REFERENCES users(id),
      winner_id INTEGER REFERENCES users(id),
      prize_pool REAL DEFAULT 0,
      registration_deadline TEXT,
      result_deadline_hours INTEGER DEFAULT 48,
      rules TEXT,
      group_count INTEGER DEFAULT 0,
      bracket_type TEXT DEFAULT 'single',
      image_url TEXT,
      entry_fee REAL DEFAULT 0,
      is_private INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT DEFAULT 'registered',
      seed INTEGER,
      team_name TEXT,
      team_logo_url TEXT,
      joined_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tournament_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
      round INTEGER NOT NULL DEFAULT 1,
      match_number INTEGER NOT NULL DEFAULT 0,
      player1_id INTEGER REFERENCES users(id),
      player2_id INTEGER REFERENCES users(id),
      player1_score INTEGER,
      player2_score INTEGER,
      winner_id INTEGER REFERENCES users(id),
      status TEXT DEFAULT 'pending',
      player1_team TEXT,
      player2_team TEXT,
      screenshot_url TEXT,
      opponent_screenshot_url TEXT,
      verification_status TEXT DEFAULT 'none',
      submitted_by INTEGER REFERENCES users(id),
      submitted_at TEXT,
      confirmed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS result_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      uploader_id INTEGER NOT NULL REFERENCES users(id),
      screenshot_url TEXT,
      screenshot_hash TEXT,
      ocr_team_left TEXT,
      ocr_team_right TEXT,
      ocr_score_left INTEGER,
      ocr_score_right INTEGER,
      ocr_match_time TEXT,
      ocr_raw_text TEXT,
      ocr_confidence REAL DEFAULT 0,
      verification_confidence REAL DEFAULT 0,
      team_match_result TEXT DEFAULT 'pending',
      fraud_score REAL DEFAULT 0,
      fraud_flags TEXT,
      verification_status TEXT DEFAULT 'pending',
      admin_review_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      reviewed_at TEXT,
      reviewed_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS fraud_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER REFERENCES result_submissions(id),
      user_id INTEGER REFERENCES users(id),
      match_id INTEGER REFERENCES matches(id),
      detection_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'low',
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      body TEXT,
      type TEXT DEFAULT 'info',
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_tournaments_owner ON tournaments(owner_id);
    CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);
    CREATE INDEX IF NOT EXISTS idx_tournaments_format ON tournaments(format);
    CREATE INDEX IF NOT EXISTS idx_participants_tournament ON participants(tournament_id);
    CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id);
    CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament_id);
    CREATE INDEX IF NOT EXISTS idx_matches_player1 ON matches(player1_id);
    CREATE INDEX IF NOT EXISTS idx_matches_player2 ON matches(player2_id);
    CREATE INDEX IF NOT EXISTS idx_matches_winner ON matches(winner_id);
    CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
    CREATE INDEX IF NOT EXISTS idx_submissions_match ON result_submissions(match_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_uploader ON result_submissions(uploader_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_status ON result_submissions(verification_status);
    CREATE INDEX IF NOT EXISTS idx_submissions_fraud ON result_submissions(fraud_score);
    CREATE INDEX IF NOT EXISTS idx_fraud_user ON fraud_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_fraud_match ON fraud_logs(match_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
  `);

  initialized = true;
  console.log("[DB] Database initialized at", DB_PATH);
  return rawDb;
}

function getDb(): Database.Database {
  if (!rawDb) return initializeDatabase();
  return rawDb;
}

export const db: any = {
  prepare: (sql: string) => getDb().prepare(sql),
  exec: (sql: string) => { getDb().exec(sql); },
  transaction: (fn: ((...args: any[]) => any)) => getDb().transaction(fn),
  get raw() { return getDb(); },
};

export { DB_PATH };
