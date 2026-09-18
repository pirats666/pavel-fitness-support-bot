CREATE TABLE IF NOT EXISTS trainer_profiles (
  telegram_user_id BIGINT PRIMARY KEY,
  telegram_username TEXT,
  first_name TEXT,
  goal TEXT NOT NULL,
  experience TEXT NOT NULL,
  location TEXT NOT NULL,
  workouts_per_week INTEGER NOT NULL CHECK (workouts_per_week BETWEEN 1 AND 14),
  workout_duration INTEGER NOT NULL CHECK (workout_duration BETWEEN 10 AND 240),
  limitations TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trainer_profiles_updated_at_idx
  ON trainer_profiles (updated_at DESC);

CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  admin_telegram_id BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS training_programs (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL REFERENCES trainer_profiles(telegram_user_id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','archived')),
  program JSONB NOT NULL,
  correction_request TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_user_id, version)
);

CREATE INDEX IF NOT EXISTS training_programs_user_created_idx
  ON training_programs (telegram_user_id, created_at DESC);
