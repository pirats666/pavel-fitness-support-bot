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
