CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  admin_telegram_id BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id BIGSERIAL PRIMARY KEY,
  telegram_username TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT 'Клиент',
  telegram_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS clients_username_unique_idx ON clients (LOWER(telegram_username));
CREATE INDEX IF NOT EXISTS clients_telegram_id_idx ON clients (telegram_id);

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
  payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (payment_amount >= 0),
  training_sessions_total INTEGER NOT NULL DEFAULT 0 CHECK (training_sessions_total >= 0),
  training_sessions_remaining INTEGER NOT NULL DEFAULT 0 CHECK (training_sessions_remaining >= 0 AND training_sessions_remaining <= training_sessions_total),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS trainer_profiles_updated_at_idx ON trainer_profiles (updated_at DESC);

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

CREATE TABLE IF NOT EXISTS payment_history (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL REFERENCES trainer_profiles(telegram_user_id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('payment','training')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  sessions INTEGER NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  remaining INTEGER NOT NULL DEFAULT 0 CHECK (remaining >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payment_history_user_created_idx
  ON payment_history (telegram_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS measurements (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL REFERENCES trainer_profiles(telegram_user_id) ON DELETE CASCADE,
  weight_kg NUMERIC(6,2) CHECK (weight_kg IS NULL OR weight_kg >= 0),
  chest_cm NUMERIC(6,2) CHECK (chest_cm IS NULL OR chest_cm >= 0),
  waist_cm NUMERIC(6,2) CHECK (waist_cm IS NULL OR waist_cm >= 0),
  hips_cm NUMERIC(6,2) CHECK (hips_cm IS NULL OR hips_cm >= 0),
  arm_cm NUMERIC(6,2) CHECK (arm_cm IS NULL OR arm_cm >= 0),
  thigh_cm NUMERIC(6,2) CHECK (thigh_cm IS NULL OR thigh_cm >= 0),
  body_fat_pct NUMERIC(5,2) CHECK (body_fat_pct IS NULL OR (body_fat_pct >= 0 AND body_fat_pct <= 100)),
  note TEXT NOT NULL DEFAULT '',
  measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS measurements_user_date_idx
  ON measurements (telegram_user_id, measured_at DESC);

CREATE TABLE IF NOT EXISTS exercise_library (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  equipment TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  muscle_group TEXT NOT NULL DEFAULT '',
  secondary_muscles JSONB NOT NULL DEFAULT '[]'::jsonb,
  instructions_ru TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL,
  gif_url TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS exercise_library_equipment_idx ON exercise_library (equipment);
CREATE INDEX IF NOT EXISTS exercise_library_category_idx ON exercise_library (category);
CREATE INDEX IF NOT EXISTS exercise_library_target_idx ON exercise_library (target);
