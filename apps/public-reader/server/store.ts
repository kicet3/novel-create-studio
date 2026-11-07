/**
 * 독자 서버 저장소 — its OWN SQLite file (node:sqlite, built into Node ≥ 22.5; no native addon), separate from the
 * studio database. Holds only reader accounts (nickname + scrypt hash, no e-mail / PII), sessions (token hashes),
 * likes, ratings and comments. Targets are addressed by public slug + episode number from the snapshot.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS readers (
  id INTEGER PRIMARY KEY,
  nickname TEXT NOT NULL,
  nickname_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  reader_id INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_reader_idx ON sessions (reader_id);
CREATE TABLE IF NOT EXISTS novel_likes (
  reader_id INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (reader_id, slug)
);
CREATE INDEX IF NOT EXISTS novel_likes_slug_idx ON novel_likes (slug);
CREATE TABLE IF NOT EXISTS episode_likes (
  reader_id INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  episode_no INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (reader_id, slug, episode_no)
);
CREATE INDEX IF NOT EXISTS episode_likes_target_idx ON episode_likes (slug, episode_no);
CREATE TABLE IF NOT EXISTS ratings (
  reader_id INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (reader_id, slug)
);
CREATE INDEX IF NOT EXISTS ratings_slug_idx ON ratings (slug);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  episode_no INTEGER NOT NULL,
  reader_id INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS comments_target_idx ON comments (slug, episode_no, created_at);
CREATE INDEX IF NOT EXISTS comments_parent_idx ON comments (parent_id);
`;

export type Db = DatabaseSync;

export function openStore(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  return db;
}

export interface ReaderRow {
  id: number;
  nickname: string;
  nickname_key: string;
  password_hash: string;
  created_at: string;
}

export interface CommentRow {
  id: number;
  slug: string;
  episode_no: number;
  reader_id: number;
  parent_id: number | null;
  body: string;
  created_at: string;
  deleted_at: string | null;
  hidden: number;
  nickname: string;
}

/** run `fn` in one transaction */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
