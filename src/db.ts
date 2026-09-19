import pg from 'pg';
import type { Client, ClientDraft } from './types.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

export async function migrateStage1Schema(): Promise<void> {
  await pool.query(`ALTER TABLE public.clients ALTER COLUMN telegram_username DROP NOT NULL`);
  await pool.query(`ALTER TABLE public.clients RENAME COLUMN telegram_id TO telegram_user_id`);
  await pool.query(`ALTER TABLE public.clients RENAME COLUMN first_name TO telegram_first_name`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS name TEXT`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS telegram_last_name TEXT`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS age INTEGER`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS height_cm NUMERIC`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS weight_kg NUMERIC`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS goal TEXT`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS experience TEXT`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS workouts_per_week INTEGER`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS training_location TEXT`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS limitations TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT ''`);
  await pool.query(`DELETE FROM public.clients WHERE telegram_username = 'pavelmoment' AND name IS NULL`);
  await pool.query(`UPDATE public.clients SET name = COALESCE(name, CASE WHEN telegram_username IS NULL THEN 'Клиент' ELSE '@' || telegram_username END)`);
  await pool.query(`ALTER TABLE public.clients ALTER COLUMN name SET NOT NULL`);
  await pool.query(`ALTER TABLE public.clients ALTER COLUMN age SET NOT NULL`);
  await pool.query(`ALTER TABLE public.clients ALTER COLUMN height_cm SET NOT NULL`);
  await pool.query(`ALTER TABLE public.clients ALTER COLUMN weight_kg SET NOT NULL`);
  await pool.query(`ALTER TABLE public.clients ALTER COLUMN goal SET NOT NULL`);
  await pool.query(`ALTER TABLE public.clients ALTER COLUMN experience SET NOT NULL`);
  await pool.query(`ALTER TABLE public.clients ALTER COLUMN workouts_per_week SET NOT NULL`);
  await pool.query(`ALTER TABLE public.clients ALTER COLUMN training_location SET NOT NULL`);
  await pool.query(`ALTER TABLE public.clients ADD CONSTRAINT clients_age_check CHECK (age >= 1 AND age <= 120)`);
  await pool.query(`ALTER TABLE public.clients ADD CONSTRAINT clients_height_cm_check CHECK (height_cm > 0 AND height_cm <= 300)`);
  await pool.query(`ALTER TABLE public.clients ADD CONSTRAINT clients_weight_kg_check CHECK (weight_kg > 0 AND weight_kg <= 500)`);
  await pool.query(`ALTER TABLE public.clients ADD CONSTRAINT clients_workouts_per_week_check CHECK (workouts_per_week >= 2 AND workouts_per_week <= 5)`);
}

export async function listClients(): Promise<Client[]> {
  const { rows } = await pool.query<Client>('SELECT * FROM public.clients ORDER BY created_at DESC, id DESC');
  return rows;
}
export async function getClient(id: number): Promise<Client | null> {
  const { rows } = await pool.query<Client>('SELECT * FROM public.clients WHERE id = $1', [id]);
  return rows[0] ?? null;
}
export async function createClient(draft: ClientDraft): Promise<Client> {
  const { rows } = await pool.query<Client>(
    `INSERT INTO public.clients
      (name, telegram_user_id, telegram_username, telegram_first_name, telegram_last_name,
       age, height_cm, weight_kg, goal, experience, workouts_per_week, training_location, limitations, note)
     VALUES ($1, NULL, $2, NULL, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      draft.telegram_username ? '@' + draft.telegram_username : 'Клиент',
      draft.telegram_username,
      draft.age, draft.height_cm, draft.weight_kg, draft.goal, draft.experience,
      draft.workouts_per_week, draft.training_location, draft.limitations, draft.note
    ]
  );
  return rows[0];
}
export async function updateClientField(id: number, field: keyof ClientDraft, value: string | number | null): Promise<Client | null> {
  const allowed: Record<keyof ClientDraft, true> = {
    name:true, telegram_user_id:true, telegram_username:true, telegram_first_name:true, telegram_last_name:true,
    age:true, height_cm:true, weight_kg:true, goal:true, experience:true,
    workouts_per_week:true, training_location:true, limitations:true, note:true
  };
  if (!allowed[field]) throw new Error('Unsupported client field');
  const { rows } = await pool.query<Client>(
    `UPDATE public.clients SET ${field} = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [value, id]
  );
  return rows[0] ?? null;
}
export async function deleteClient(id: number): Promise<boolean> {
  const result = await pool.query('DELETE FROM public.clients WHERE id = $1', [id]);
  return result.rowCount === 1;
}
export async function closeDb(): Promise<void> { await pool.end(); }

export async function logDatabaseDiagnostics(): Promise<void> {
  try {
    const meta = await pool.query(`SELECT current_database() AS database, current_user AS user, current_schema() AS schema`);
    const cols = await pool.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' ORDER BY ordinal_position`);
    const constraints = await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.clients'::regclass`);
    console.info('[DB DIAGNOSTIC] database=%s user=%s schema=%s', meta.rows[0]?.database, meta.rows[0]?.user, meta.rows[0]?.schema);
    console.info('[DB DIAGNOSTIC] clients columns=%j', cols.rows);
    console.info('[DB DIAGNOSTIC] clients constraints=%j', constraints.rows);
  } catch (e) {
    console.error('[DB DIAGNOSTIC] Failed:', e);
  }
}
