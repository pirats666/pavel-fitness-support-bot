import pg from 'pg';
import type { Client, ClientDraft } from './types.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

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
      (telegram_user_id, telegram_username, telegram_first_name, telegram_last_name,
       age, height_cm, weight_kg, goal, experience, workouts_per_week, training_location, limitations, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [draft.telegram_user_id, draft.telegram_username, draft.telegram_first_name, draft.telegram_last_name,
     draft.age, draft.height_cm, draft.weight_kg, draft.goal, draft.experience, draft.workouts_per_week,
     draft.training_location, draft.limitations, draft.note]
  );
  return rows[0];
}
export async function updateClientField(id: number, field: keyof ClientDraft, value: string | number | null): Promise<Client | null> {
  const allowed: Record<keyof ClientDraft, true> = {
    telegram_user_id:true, telegram_username:true, telegram_first_name:true, telegram_last_name:true,
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
