/**
 * Versioned migrations of the PUBLIC schema (separate from the studio's own migrations in @ncs/db).
 * Applied by the studio (module publication) over the writer connection; every statement is qualified with the
 * schema (`s` = the quoted schema identifier), so nothing outside it is created or changed.
 *
 *   novels / episodes      — written ONLY by the studio: published versions of opted-in novels (allow-listed columns)
 *   visitors               — anonymous visitor ids (random, issued as an httpOnly cookie on the first write; no PII)
 *   novel_likes / episode_likes / ratings / comments — anonymous reactions, written by the reader API
 *   rate_limits            — fixed-window counters (serverless-safe abuse limits)
 *
 * Reactions are keyed by public slug + episode number and have no FK to novels/episodes: unpublishing deletes the
 * content rows but keeps reactions (the reader API serves nothing for a target that is not published).
 * RLS is enabled on every table with NO policies for Supabase's API roles (anon / authenticated): defense in depth
 * if the schema is ever exposed through the Data API. The owner (studio writer) bypasses RLS; the restricted
 * reader role gets explicit policies from the role SQL (role-sql.ts), which the user runs manually.
 */

export interface PublicMigration {
  version: number;
  name: string;
  /** DDL for the quoted schema identifier `s` */
  sql(s: string): string;
}

/** every table of the public schema (schema_migrations included) — RLS is enabled on all */
export const PUBLIC_CONTENT_TABLES = ["novels", "episodes"] as const;
export const PUBLIC_REACTION_TABLES = ["visitors", "novel_likes", "episode_likes", "ratings", "comments", "rate_limits"] as const;
export const PUBLIC_ALL_TABLES = ["schema_migrations", ...PUBLIC_CONTENT_TABLES, ...PUBLIC_REACTION_TABLES] as const;

/** allow-listed columns of the content tables (tests assert the schema has exactly these) */
export const PUBLIC_NOVEL_COLUMNS = ["slug", "title", "author_name", "intro", "genre", "age_rating", "episode_count", "latest_published_at", "content_hash", "updated_at"] as const;
export const PUBLIC_EPISODE_COLUMNS = ["novel_slug", "episode_no", "title", "body", "char_count", "published_at", "content_hash", "updated_at"] as const;

export const PUBLIC_MIGRATIONS: readonly PublicMigration[] = [
  {
    version: 1,
    name: "init",
    sql: (s) => `
CREATE TABLE IF NOT EXISTS ${s}.novels (
  slug text PRIMARY KEY,
  title text NOT NULL,
  author_name text NOT NULL DEFAULT '',
  intro text NOT NULL DEFAULT '',
  genre text NOT NULL DEFAULT '',
  age_rating text NOT NULL DEFAULT 'all',
  episode_count integer NOT NULL DEFAULT 0,
  latest_published_at timestamptz,
  content_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT novels_slug_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$' AND position('--' in slug) = 0),
  CONSTRAINT novels_age_rating CHECK (age_rating IN ('all', 'age_12', 'age_15', 'age_19')),
  CONSTRAINT novels_title_len CHECK (char_length(title) <= 300),
  CONSTRAINT novels_author_len CHECK (char_length(author_name) <= 40),
  CONSTRAINT novels_intro_len CHECK (char_length(intro) <= 2000)
);
CREATE INDEX IF NOT EXISTS novels_latest_idx ON ${s}.novels (latest_published_at DESC);

CREATE TABLE IF NOT EXISTS ${s}.episodes (
  novel_slug text NOT NULL REFERENCES ${s}.novels (slug) ON DELETE CASCADE ON UPDATE CASCADE,
  episode_no integer NOT NULL,
  title text,
  body text NOT NULL,
  char_count integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  content_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (novel_slug, episode_no),
  CONSTRAINT episodes_no_positive CHECK (episode_no >= 1)
);

CREATE TABLE IF NOT EXISTS ${s}.visitors (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visitors_id_format CHECK (id ~ '^[A-Za-z0-9_-]{22,64}$')
);

CREATE TABLE IF NOT EXISTS ${s}.novel_likes (
  visitor_id text NOT NULL REFERENCES ${s}.visitors (id) ON DELETE CASCADE,
  novel_slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (visitor_id, novel_slug)
);
CREATE INDEX IF NOT EXISTS novel_likes_target_idx ON ${s}.novel_likes (novel_slug);

CREATE TABLE IF NOT EXISTS ${s}.episode_likes (
  visitor_id text NOT NULL REFERENCES ${s}.visitors (id) ON DELETE CASCADE,
  novel_slug text NOT NULL,
  episode_no integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (visitor_id, novel_slug, episode_no)
);
CREATE INDEX IF NOT EXISTS episode_likes_target_idx ON ${s}.episode_likes (novel_slug, episode_no);

CREATE TABLE IF NOT EXISTS ${s}.ratings (
  visitor_id text NOT NULL REFERENCES ${s}.visitors (id) ON DELETE CASCADE,
  novel_slug text NOT NULL,
  score smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (visitor_id, novel_slug),
  CONSTRAINT ratings_score CHECK (score BETWEEN 1 AND 5)
);
CREATE INDEX IF NOT EXISTS ratings_target_idx ON ${s}.ratings (novel_slug);

CREATE TABLE IF NOT EXISTS ${s}.comments (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  novel_slug text NOT NULL,
  episode_no integer NOT NULL,
  parent_id bigint REFERENCES ${s}.comments (id) ON DELETE CASCADE,
  visitor_id text NOT NULL REFERENCES ${s}.visitors (id) ON DELETE CASCADE,
  nickname text NOT NULL DEFAULT '익명',
  body text NOT NULL,
  body_hash text NOT NULL,
  ip_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  hidden boolean NOT NULL DEFAULT false,
  held_reason text,
  CONSTRAINT comments_nickname_len CHECK (char_length(nickname) BETWEEN 1 AND 20),
  CONSTRAINT comments_body_len CHECK (char_length(body) BETWEEN 1 AND 1000),
  CONSTRAINT comments_held_reason CHECK (held_reason IS NULL OR held_reason IN ('banned_word'))
);
CREATE INDEX IF NOT EXISTS comments_target_idx ON ${s}.comments (novel_slug, episode_no, id);
CREATE INDEX IF NOT EXISTS comments_parent_idx ON ${s}.comments (parent_id);
CREATE INDEX IF NOT EXISTS comments_visitor_idx ON ${s}.comments (visitor_id, created_at);
CREATE INDEX IF NOT EXISTS comments_ip_idx ON ${s}.comments (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS ${s}.rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON ${s}.rate_limits (window_start);

${PUBLIC_ALL_TABLES.map((t) => `ALTER TABLE ${s}.${t} ENABLE ROW LEVEL SECURITY;`).join("\n")}
`,
  },
];

export const PUBLIC_SCHEMA_LATEST_VERSION = PUBLIC_MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
