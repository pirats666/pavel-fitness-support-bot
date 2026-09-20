import pg from 'pg';
import type { Client, ClientDraft, PrimaryAssessment, TrainingStrategy, TrainingProgram, TrainingProgramDay, TrainingProgramExercise } from './types.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

export async function migrateStage1Schema(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='name'`
  );
  if (rows.length) {
    await pool.query(`ALTER TABLE public.clients ALTER COLUMN telegram_username DROP NOT NULL`);
    await pool.query(`ALTER TABLE public.clients ALTER COLUMN telegram_first_name DROP NOT NULL`);
    return;
  }

  await pool.query(`ALTER TABLE public.clients ALTER COLUMN telegram_username DROP NOT NULL`);
  await pool.query(`ALTER TABLE public.clients RENAME COLUMN telegram_id TO telegram_user_id`);
  await pool.query(`ALTER TABLE public.clients RENAME COLUMN first_name TO telegram_first_name`);
  await pool.query(`ALTER TABLE public.clients ALTER COLUMN telegram_first_name DROP NOT NULL`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN name TEXT`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN telegram_last_name TEXT`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN age INTEGER`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN height_cm NUMERIC`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN weight_kg NUMERIC`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN goal TEXT`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN experience TEXT`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN workouts_per_week INTEGER`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN training_location TEXT`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN limitations TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE public.clients ADD COLUMN note TEXT NOT NULL DEFAULT ''`);
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

export async function migrateStage2AssessmentSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.primary_assessments (
      client_id BIGINT PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
      fitness_level TEXT, strength TEXT, endurance TEXT, mobility TEXT, coordination TEXT,
      squat TEXT, hip_hinge TEXT, horizontal_press TEXT, horizontal_pull TEXT,
      vertical_press TEXT, vertical_pull TEXT, core TEXT,
      weaknesses TEXT, strengths TEXT, attention TEXT, trainer_comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}
export async function getPrimaryAssessment(clientId: number): Promise<PrimaryAssessment | null> {
  const { rows } = await pool.query<PrimaryAssessment>('SELECT * FROM public.primary_assessments WHERE client_id = $1',[clientId]);
  return rows[0] ?? null;
}
export async function upsertPrimaryAssessment(a: Omit<PrimaryAssessment,'created_at'|'updated_at'>): Promise<PrimaryAssessment> {
  const { rows } = await pool.query<PrimaryAssessment>(`
    INSERT INTO public.primary_assessments
      (client_id,fitness_level,strength,endurance,mobility,coordination,squat,hip_hinge,horizontal_press,horizontal_pull,vertical_press,vertical_pull,core,weaknesses,strengths,attention,trainer_comment)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (client_id) DO UPDATE SET
      fitness_level=EXCLUDED.fitness_level,strength=EXCLUDED.strength,endurance=EXCLUDED.endurance,
      mobility=EXCLUDED.mobility,coordination=EXCLUDED.coordination,squat=EXCLUDED.squat,hip_hinge=EXCLUDED.hip_hinge,
      horizontal_press=EXCLUDED.horizontal_press,horizontal_pull=EXCLUDED.horizontal_pull,
      vertical_press=EXCLUDED.vertical_press,vertical_pull=EXCLUDED.vertical_pull,core=EXCLUDED.core,
      weaknesses=EXCLUDED.weaknesses,strengths=EXCLUDED.strengths,attention=EXCLUDED.attention,
      trainer_comment=EXCLUDED.trainer_comment,updated_at=NOW()
    RETURNING *`,[
      a.client_id,a.fitness_level,a.strength,a.endurance,a.mobility,a.coordination,a.squat,a.hip_hinge,
      a.horizontal_press,a.horizontal_pull,a.vertical_press,a.vertical_pull,a.core,a.weaknesses,a.strengths,a.attention,a.trainer_comment
    ]);
  return rows[0];
}
export async function migrateStage3StrategySchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.training_strategies (
      client_id BIGINT PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
      main_task TEXT,
      priorities TEXT,
      what_to_account_for TEXT,
      main_focus TEXT,
      trainer_decision TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}
export async function getTrainingStrategy(clientId: number): Promise<TrainingStrategy | null> {
  const { rows } = await pool.query<TrainingStrategy>(
    'SELECT * FROM public.training_strategies WHERE client_id = $1',[clientId]
  );
  return rows[0] ?? null;
}
export async function upsertTrainingStrategy(
  s: Omit<TrainingStrategy,'created_at'|'updated_at'>
): Promise<TrainingStrategy> {
  const { rows } = await pool.query<TrainingStrategy>(`
    INSERT INTO public.training_strategies
      (client_id,main_task,priorities,what_to_account_for,main_focus,trainer_decision)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (client_id) DO UPDATE SET
      main_task=EXCLUDED.main_task,
      priorities=EXCLUDED.priorities,
      what_to_account_for=EXCLUDED.what_to_account_for,
      main_focus=EXCLUDED.main_focus,
      trainer_decision=EXCLUDED.trainer_decision,
      updated_at=NOW()
    RETURNING *
  `,[
    s.client_id,s.main_task,s.priorities,s.what_to_account_for,s.main_focus,s.trainer_decision
  ]);
  return rows[0];
}

export async function migrateStage4ProgramSchema(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS public.coach_training_programs (
    client_id BIGINT PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL, goal TEXT, duration_weeks INTEGER, comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS public.coach_training_program_days (
    id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES public.coach_training_programs(client_id) ON DELETE CASCADE,
    day_number INTEGER NOT NULL, name TEXT NOT NULL, comment TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(client_id,day_number)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS public.coach_training_program_exercises (
    id BIGSERIAL PRIMARY KEY, day_id BIGINT NOT NULL REFERENCES public.coach_training_program_days(id) ON DELETE CASCADE,
    exercise_order INTEGER NOT NULL, name TEXT NOT NULL, muscle_group TEXT, sets INTEGER NOT NULL, reps TEXT NOT NULL,
    rest_seconds INTEGER, rir NUMERIC, comment TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(day_id,exercise_order)
  )`);
}
export async function getTrainingProgram(clientId:number):Promise<TrainingProgram|null>{const {rows}=await pool.query<TrainingProgram>('SELECT * FROM public.coach_training_programs WHERE client_id=$1',[clientId]);return rows[0]??null;}
export async function upsertTrainingProgram(p:Omit<TrainingProgram,'created_at'|'updated_at'>):Promise<TrainingProgram>{const {rows}=await pool.query<TrainingProgram>(`INSERT INTO public.coach_training_programs(client_id,name,goal,duration_weeks,comment) VALUES($1,$2,$3,$4,$5) ON CONFLICT(client_id) DO UPDATE SET name=EXCLUDED.name,goal=EXCLUDED.goal,duration_weeks=EXCLUDED.duration_weeks,comment=EXCLUDED.comment,updated_at=NOW() RETURNING *`,[p.client_id,p.name,p.goal,p.duration_weeks,p.comment]);return rows[0];}
export async function listTrainingProgramDays(clientId:number):Promise<TrainingProgramDay[]>{const {rows}=await pool.query<TrainingProgramDay>('SELECT * FROM public.coach_training_program_days WHERE client_id=$1 ORDER BY day_number',[clientId]);return rows;}
export async function getTrainingProgramDay(id:number):Promise<TrainingProgramDay|null>{const {rows}=await pool.query<TrainingProgramDay>('SELECT * FROM public.coach_training_program_days WHERE id=$1',[id]);return rows[0]??null;}
export async function createTrainingProgramDay(clientId:number,name:string):Promise<TrainingProgramDay>{const {rows}=await pool.query<TrainingProgramDay>('INSERT INTO public.coach_training_program_days(client_id,day_number,name) VALUES($1,COALESCE((SELECT MAX(day_number)+1 FROM public.coach_training_program_days WHERE client_id=$1),1),$2) RETURNING *',[clientId,name]);return rows[0];}
export async function listTrainingProgramExercises(dayId:number):Promise<TrainingProgramExercise[]>{const {rows}=await pool.query<TrainingProgramExercise>('SELECT * FROM public.coach_training_program_exercises WHERE day_id=$1 ORDER BY exercise_order',[dayId]);return rows;}
export async function createTrainingProgramExercise(e:Omit<TrainingProgramExercise,'id'|'created_at'|'exercise_order'>):Promise<TrainingProgramExercise>{const {rows}=await pool.query<TrainingProgramExercise>(`INSERT INTO public.coach_training_program_exercises(day_id,exercise_order,name,muscle_group,sets,reps,rest_seconds,rir,comment) VALUES($1,COALESCE((SELECT MAX(exercise_order)+1 FROM public.coach_training_program_exercises WHERE day_id=$1),1),$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[e.day_id,e.name,e.muscle_group,e.sets,e.reps,e.rest_seconds,e.rir,e.comment]);return rows[0];}
export async function getTrainingProgramExercise(id:number):Promise<(TrainingProgramExercise&{client_id:number})|null>{const {rows}=await pool.query<TrainingProgramExercise&{client_id:number}>('SELECT e.*,d.client_id FROM public.coach_training_program_exercises e JOIN public.coach_training_program_days d ON d.id=e.day_id WHERE e.id=$1',[id]);return rows[0]??null;}
export async function deleteTrainingProgramExercise(id:number):Promise<boolean>{const r=await pool.query('DELETE FROM public.coach_training_program_exercises WHERE id=$1',[id]);return r.rowCount===1;}
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

