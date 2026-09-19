-- Stage 1 schema. Production schema is applied through Supabase migration.
CREATE TABLE IF NOT EXISTS public.clients (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  age INTEGER NOT NULL CHECK (age BETWEEN 1 AND 120),
  height_cm NUMERIC(5,2) NOT NULL CHECK (height_cm > 0 AND height_cm <= 300),
  weight_kg NUMERIC(6,2) NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 500),
  goal TEXT NOT NULL,
  experience TEXT NOT NULL,
  workouts_per_week INTEGER NOT NULL CHECK (workouts_per_week BETWEEN 2 AND 5),
  training_location TEXT NOT NULL,
  limitations TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS clients_name_idx ON public.clients (LOWER(name));
CREATE INDEX IF NOT EXISTS clients_created_at_idx ON public.clients (created_at DESC);
