import 'dotenv/config';
import { createServer } from 'node:http';
import { Bot, InlineKeyboard } from 'grammy';
import pg from 'pg';
import { syncExerciseCatalog, syncAnatomyExerciseCatalog } from './exercise-catalog.js';
import { ANATOMY_CATALOG_VERSION } from './anatomy-exercise-catalog.js';
import { createAIWorkoutPlan, aiEnabled, type AIPlannerProfile, type AIExerciseCandidate } from './ai-planner.js';

const { Pool } = pg;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT ?? 10000);

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const configuredAdminId = ADMIN_TELEGRAM_ID ? Number(ADMIN_TELEGRAM_ID) : null;
if (configuredAdminId !== null && !Number.isSafeInteger(configuredAdminId)) {
  throw new Error('ADMIN_TELEGRAM_ID must be a Telegram numeric user id');
}

const bot = new Bot(BOT_TOKEN);
const TELEGRAM_POLL_LOCK_KEY = 9152026;
let telegramPollLock: pg.PoolClient | null = null;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

type QuizState = {
  step: 'goal' | 'experience' | 'location' | 'workouts' | 'duration' | 'limitations';
  goal?: string;
  experience?: string;
  location?: string;
  workoutsPerWeek?: number;
  workoutDuration?: number;
  limitations?: string;
  training_focus?: string;
};

type Exercise = {
  id?: string;
  muscleGroup?: string;
  movementPattern?: string;
  name: string;
  sets: number;
  reps: string;
  rest: string;
  comment?: string;
  progression?: string;
  recommendation?: string;
  gifUrl?: string;
};

type LibraryExercise = {
  id: string;
  name: string;
  nameRu: string;
  category: string;
  bodyPartRu: string;
  equipment: string;
  equipmentRu: string;
  target: string;
  muscleGroup: string;
  muscleGroupRu: string;
  secondaryMuscles: string[];
  instructionsRu: string;
  sourceUrl: string;
  gifUrl?: string;
  imageUrl?: string;
  trainingTypes: string[];
  movementPattern: string;
  level: string;
  trainingContexts: string[];
};

type WorkoutDay = {
  day: number;
  title: string;
  focus: string;
  warmup: string;
  exercises: Exercise[];
  cooldown: string;
};

type Program = {
  title: string;
  goal: string;
  frequency: number;
  duration: number;
  location: string;
  version: number;
  weeks: number;
  progression: string;
  days: WorkoutDay[];
  notes: string[];
};

const sessions = new Map<number, QuizState>();
const correctionSessions = new Map<number, { programId: number; muscleGroup?: string; exerciseIndex?: number; day?: number; catalogExerciseId?: string; catalogChoices?: string[] }>();
const paymentSessions = new Map<number, { step: 'amount' | 'total' | 'remaining'; amount?: number; total?: number; targetId?: number }>();
const clientSearchSessions = new Map<number, { query?: string }>();
const selectedClient = new Map<number, number>();
const clientAddSessions = new Map<number, { step: 'username' | 'name' | 'telegramId'; username?: string; firstName?: string }>();
const measurementSessions = new Map<number, { step: 'data'; targetId: number }>();
const quizTargets = new Map<number, number>();
let adminId: number | null = configuredAdminId;

async function isAdmin(ctx: { from?: { id: number } }) {
  if (!ctx.from) return false;
  if (adminId !== null) return ctx.from.id === adminId;
  const { rows } = await pool.query('SELECT admin_telegram_id FROM bot_settings WHERE key = $1', ['admin_telegram_id']);
  if (!rows[0]) return false;
  adminId = Number(rows[0].admin_telegram_id);
  return ctx.from.id === adminId;
}

async function claimAdmin(ctx: { from?: { id: number } }) {
  if (!ctx.from) return false;
  if (adminId !== null) return ctx.from.id === adminId;
  await pool.query(
    'INSERT INTO bot_settings (key, admin_telegram_id) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
    ['admin_telegram_id', ctx.from.id]
  );
  const { rows } = await pool.query('SELECT admin_telegram_id FROM bot_settings WHERE key = $1', ['admin_telegram_id']);
  if (!rows[0]) return false;
  adminId = Number(rows[0].admin_telegram_id);
  return ctx.from.id === adminId;
}

function ruGoal(value: string) {
  return ({ loss: 'Похудение', mass: 'Набор массы', health: 'Здоровье и форма' } as Record<string, string>)[value] ?? value;
}
function ruExperience(value: string) {
  return ({ beginner: 'Новичок', under1: 'До 1 года', '1to3': '1–3 года', '3plus': '3+ года' } as Record<string, string>)[value] ?? value;
}
function ruLocation(value: string) {
  return ({ gym: 'Зал', home: 'Дом', outdoor: 'Улица', mixed: 'Смешанный формат' } as Record<string, string>)[value] ?? value;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value) + ' ₽';
}

function displayUsername(profile: any) {
  const username = String(profile?.telegram_username ?? '').trim();
  const firstName = String(profile?.first_name ?? '').trim();
  const person = firstName || 'Пользователь';
  return username ? `${person} (@${username.replace(/^@/, '')})` : person;
}

function identityBlock(profile: any) {
  const id = Number(profile?.telegram_user_id ?? 0);
  const idLine = id < 0
    ? `🆔 ID клиента: <code>${Math.abs(id)}</code>`
    : `🆔 внутренний ID: <code>${profile?.telegram_user_id ?? '—'}</code>`;
  return `👤 <b>${displayUsername(profile)}</b>\n${idLine}`;
}

async function ensureDatabase() {
  await pool.query(`
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
      payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      training_sessions_total INTEGER NOT NULL DEFAULT 0 CHECK (training_sessions_total >= 0),
      training_sessions_remaining INTEGER NOT NULL DEFAULT 0 CHECK (training_sessions_remaining >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS trainer_profiles_updated_at_idx ON trainer_profiles (updated_at DESC);
    CREATE TABLE IF NOT EXISTS payment_history (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT NOT NULL REFERENCES trainer_profiles(telegram_user_id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('payment','training')),
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0,
      remaining INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
    CREATE INDEX IF NOT EXISTS clients_telegram_id_idx ON clients (telegram_id);

    CREATE TABLE IF NOT EXISTS measurements (
      id BIGSERIAL PRIMARY KEY,
      telegram_user_id BIGINT NOT NULL REFERENCES trainer_profiles(telegram_user_id) ON DELETE CASCADE,
      weight_kg NUMERIC(6,2),
      chest_cm NUMERIC(6,2),
      waist_cm NUMERIC(6,2),
      hips_cm NUMERIC(6,2),
      arm_cm NUMERIC(6,2),
      thigh_cm NUMERIC(6,2),
      body_fat_pct NUMERIC(5,2),
      note TEXT NOT NULL DEFAULT '',
      measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS measurements_user_date_idx ON measurements (telegram_user_id, measured_at DESC);
    CREATE INDEX IF NOT EXISTS payment_history_user_created_idx ON payment_history (telegram_user_id, created_at DESC);
    ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS training_sessions_total INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS training_sessions_remaining INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS training_focus TEXT NOT NULL DEFAULT 'auto';
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

    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS gif_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS name_ru TEXT NOT NULL DEFAULT '';
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS body_part_ru TEXT NOT NULL DEFAULT '';
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS equipment_ru TEXT NOT NULL DEFAULT '';
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS muscle_group_ru TEXT NOT NULL DEFAULT '';
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS training_types JSONB NOT NULL DEFAULT '["maintenance"]'::jsonb;
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS movement_pattern TEXT NOT NULL DEFAULT '';
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS level TEXT NOT NULL DEFAULT 'beginner';
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS media_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS attribution TEXT NOT NULL DEFAULT '';
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS catalog_version TEXT NOT NULL DEFAULT '';
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS gif_verified BOOLEAN NOT NULL DEFAULT FALSE;

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
  `);
}

async function seedExerciseLibrary() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM exercise_library');
  if (Number(rows[0]?.count ?? 0) > 0) return;

  const sourceUrl = 'https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/data/exercises.json';
  try {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Exercise dataset HTTP ${response.status}`);
    const data = await response.json() as any[];

    for (let i = 0; i < data.length; i += 100) {
      const batch = data.slice(i, i + 100);
      const values: unknown[] = [];
      const placeholders = batch.map((ex, j) => {
        const base = j * 11;
        values.push(
          String(ex.id),
          String(ex.name ?? ''),
          String(ex.category ?? ''),
          String(ex.equipment ?? ''),
          String(ex.target ?? ''),
          String(ex.muscle_group ?? ''),
          JSON.stringify(Array.isArray(ex.secondary_muscles) ? ex.secondary_muscles : []),
          String(ex.instructions?.ru ?? ex.instructions?.en ?? ''),
          sourceUrl,
          String(ex.gif_url ?? ''),
          String(ex.image ?? '')
        );
        return `(${base + 1},${base + 2},${base + 3},${base + 4},${base + 5},${base + 6},${base + 7}::jsonb,${base + 8},${base + 9},${base + 10},${base + 11})`;
      }).join(',');
      await pool.query(
        `INSERT INTO exercise_library
          (id,name,category,equipment,target,muscle_group,secondary_muscles,instructions_ru,source_url,gif_url,image_url)
         VALUES ${placeholders}
         ON CONFLICT (id) DO NOTHING`,
        values
      );
    }
    console.log(`Exercise library seeded: ${data.length} exercises`);
  } catch (error) {
    console.error('Exercise library seed failed; using built-in fallback.', error);
    const fallback = [
      ['fallback-squat','Приседание с собственным весом','upper legs','body weight','quadriceps','quadriceps',[]],
      ['fallback-pushup','Отжимания','chest','body weight','pectorals','pectorals',[]],
      ['fallback-row','Тяга рюкзака в наклоне','back','other','latissimus dorsi','latissimus dorsi',[]],
      ['fallback-lunge','Выпады назад','upper legs','body weight','glutes','glutes',[]],
      ['fallback-good-morning','Good Morning без отягощения','upper legs','body weight','hamstrings','hamstrings',[]],
      ['fallback-dead-bug','Dead Bug','waist','body weight','abs','abs',[]],
      ['fallback-bench','Жим лёжа','chest','barbell','pectorals','pectorals',[]],
      ['fallback-lat-pulldown','Тяга верхнего блока','back','cable','lats','latissimus dorsi',[]],
      ['fallback-rdl','Румынская тяга','upper legs','barbell','hamstrings','hamstrings',[]],
      ['fallback-shoulder-press','Жим гантелей сидя','shoulders','dumbbell','delts','deltoids',[]],
      ['fallback-goblet','Гоблет-присед','upper legs','dumbbell','quadriceps','quadriceps',[]]
    ];
    for (const ex of fallback) {
      await pool.query(
        `INSERT INTO exercise_library
          (id,name,category,equipment,target,muscle_group,secondary_muscles,instructions_ru,source_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'',$8)
         ON CONFLICT (id) DO NOTHING`,
        [ex[0],ex[1],ex[2],ex[3],ex[4],ex[5],JSON.stringify(ex[6]),'builtin-fallback']
      );
    }
  }
}

function ruExerciseName(name: string) {
  const n = normalizeText(name);
  const map: Array<[RegExp, string]> = [
    [/incline.*bench press|incline.*press/, 'Жим штанги под наклоном 30–45°'],
    [/barbell.*bench press|bench press|chest press/, 'Жим лёжа'],
    [/barbell.*squat|full squat/, 'Приседание со штангой'],
    [/goblet squat/, 'Гоблет-присед'],
    [/bodyweight squat|air squat/, 'Приседание с собственным весом'],
    [/split squat/, 'Болгарский сплит-присед'],
    [/leg press/, 'Жим ногами'],
    [/leg extension/, 'Разгибание ног в тренажёре'],
    [/leg curl|inverse leg curl/, 'Сгибание ног в тренажёре'],
    [/romanian deadlift/, 'Румынская тяга'],
    [/deadlift/, 'Становая тяга'],
    [/good morning/, 'Наклон Good Morning'],
    [/pull-up|pull up|chin-up|chin up/, 'Подтягивания'],
    [/lat pulldown/, 'Тяга верхнего блока'],
    [/seated row|cable row|machine row|bent over row|barbell row|dumbbell row/, 'Тяга в наклоне'],
    [/push-up|push up/, 'Отжимания'],
    [/dip/, 'Отжимания на брусьях'],
    [/dumbbell.*shoulder press|shoulder press|overhead press/, 'Жим гантелей над головой'],
    [/lateral raise/, 'Разведения гантелей в стороны'],
    [/front raise/, 'Подъём гантелей перед собой'],
    [/biceps curl|hammer curl/, 'Сгибание рук с гантелями'],
    [/triceps extension|triceps pushdown/, 'Разгибание рук на трицепс'],
    [/calf raise/, 'Подъём на носки'],
    [/reverse lunge/, 'Выпады назад'],
    [/walking lunge|forward lunge/, 'Выпады вперёд'],
    [/step-up/, 'Зашагивания на платформу'],
    [/dead bug/, 'Dead Bug'],
    [/plank/, 'Планка'],
    [/crunch|sit-up/, 'Скручивания'],
    [/leg raise/, 'Подъём ног'],
    [/back extension/, 'Разгибание спины'],
    [/hip thrust|glute bridge/, 'Ягодичный мост'],
    [/fly|chest fly|pec deck/, 'Сведение рук для груди'],
    [/shrug/, 'Шраги']
  ];
  const hit = map.find(([pattern]) => pattern.test(n));
  if (hit) return hit[1];
  return String(name ?? '').trim() || 'Упражнение без названия';
}

type ProfileForProgram = {
  goal: string;
  experience: string;
  location: string;
  workouts_per_week: number;
  workout_duration: number;
  limitations?: string;
  training_focus?: string;
};

function deriveTrainingFocus(profile: Pick<ProfileForProgram, 'goal' | 'experience' | 'workout_duration'>) {
  if (profile.goal === 'mass') return 'hypertrophy';
  if (profile.goal === 'loss') return 'endurance';
  if (profile.workout_duration <= 30) return 'conditioning';
  if (profile.experience === 'beginner') return 'maintenance';
  return 'maintenance';
}

type ScoredLibraryExercise = LibraryExercise & { score: number };

function normalizeText(value: string) {
  return value.toLowerCase().replace(/ё/g, 'е').trim();
}

function exerciseDifficulty(row: LibraryExercise) {
  const text = normalizeText(`${row.name} ${row.target} ${row.category}`);
  if (/(snatch|clean|jerk|muscle up|handstand|pistol|barbell deadlift|heavy)/.test(text)) return 3;
  if (/(pull-up|pull up|подтяг|deadlift|станов|barbell squat|приседание со штангой)/.test(text)) return 2;
  return 1;
}

function limitationExclusions(limitations: string) {
  const text = normalizeText(limitations);
  const rules: Array<[string[], RegExp]> = [
    [['колен', 'knee'], /(squat|lunge|jump|running|step-up|присед|выпад|прыж|бег)/],
    [['спин', 'поясниц', 'back', 'lower back'], /(deadlift|good morning|row|hinge|тяга|станов|наклон)/],
    [['плеч', 'shoulder'], /(overhead|shoulder press|lateral raise|dip|жим над головой|жим гантелей|разведен)/],
    [['локт', 'elbow'], /(curl|extension|dip|push-up|push up|сгибан|разгибан|отжиман)/],
    [['запяст', 'кист', 'wrist'], /(push-up|push up|plank|barbell|отжиман|планк|штанг)/],
    [['ше', 'neck'], /(shrug|neck|шраг|шея)/],
    [['голеностоп', 'лодыж', 'ankle'], /(calf|jump|lunge|выпад|прыж|икр)/]
  ];
  return rules.filter(([keywords]) => keywords.some((keyword) => text.includes(keyword))).map(([, pattern]) => pattern);
}

function isExerciseAllowed(row: LibraryExercise, limitations: string) {
  const text = normalizeText(`${row.name} ${row.target} ${row.category} ${row.equipment}`);
  return limitationExclusions(limitations).every((pattern) => !pattern.test(text));
}

function scoreExercise(row: LibraryExercise, profile: ProfileForProgram, desiredCategory: string, usedIds: Set<string>) {
  let score = 0;
  const text = normalizeText(`${row.name} ${row.nameRu} ${row.target} ${row.muscleGroup} ${row.equipment}`);
  const difficulty = exerciseDifficulty(row);
  const focus = profile.training_focus && profile.training_focus !== 'auto'
    ? profile.training_focus
    : deriveTrainingFocus(profile);

  if (row.category === desiredCategory) score += 25;
  if (row.trainingTypes.includes(focus)) score += 35;
  if (focus === 'hypertrophy' && row.trainingTypes.includes('hypertrophy')) score += 10;
  if (focus === 'strength' && row.trainingTypes.includes('strength')) score += 10;
  if (focus === 'endurance' && row.trainingTypes.includes('endurance')) score += 10;
  if (focus === 'recovery' && row.trainingTypes.includes('recovery')) score += 15;
  if (focus === 'mobility' && row.trainingTypes.includes('mobility')) score += 15;
  if (focus === 'power' && row.trainingTypes.includes('power')) score += 15;
  if (focus === 'conditioning' && row.trainingTypes.includes('conditioning')) score += 15;

  // Prioritise foundational movements so the catalog is not dominated by exotic variations.
  if (/(squat|присед|lunge|выпад|bench press|жим|row|тяга|pull.?up|подтяг|push.?up|отжим|deadlift|станов|romanian|румын|calf raise|подъ[её]м.*нос|overhead press|жим.*плеч)/.test(text)) score += 12;

  if (profile.goal === 'mass' && /(chest|pector|back|lat|dorsi|quadr|hamstring|glute|deltoid|shoulder)/.test(text)) score += 8;
  if (profile.goal === 'loss' && /(squat|lunge|row|push|press|pull|deadlift|carry|cardio)/.test(text)) score += 7;
  if (profile.goal === 'health' && /(squat|lunge|row|push|press|pull|hinge|core|balance|mobility)/.test(text)) score += 7;

  if (profile.experience === 'beginner' || profile.experience === 'under1') {
    score += difficulty === 1 ? 10 : difficulty === 2 ? 3 : -12;
  } else if (profile.experience === '1to3') {
    score += difficulty <= 2 ? 6 : 1;
  } else {
    score += difficulty >= 2 ? 6 : 2;
  }

  const gym = profile.location === 'gym' || profile.location === 'mixed';
  if (gym && !/(body weight|bodyweight)/.test(text)) score += 4;
  if (!gym && /(body weight|bodyweight)/.test(text)) score += 10;
  if (usedIds.has(row.id)) score -= 25;
  if (profile.workout_duration <= 45 && difficulty === 3) score -= 7;
  if (!row.gifUrl) score -= 8;
  if (!row.nameRu || row.nameRu === 'Функциональное упражнение') score -= 3;

  return score;
}

async function getLibraryExercises(profile: ProfileForProgram, version: number, fullCatalog = false): Promise<LibraryExercise[]> {
  const equipmentFilter = profile.location === 'gym'
    ? `equipment <> 'body weight' AND id LIKE 'base-gym-%'`
    : profile.location === 'home'
      ? `equipment = 'body weight' AND id LIKE 'base-home-%'`
      : profile.location === 'outdoor'
        ? `equipment = 'body weight' AND id LIKE 'base-outdoor-%'`
        : `id LIKE 'base-%'`;

  const { rows } = await pool.query(
    `SELECT id, name, COALESCE(name_ru,'') AS name_ru, category, COALESCE(body_part_ru,'') AS body_part_ru,
            equipment, COALESCE(equipment_ru,'') AS equipment_ru, target, muscle_group,
            COALESCE(muscle_group_ru,'') AS muscle_group_ru, secondary_muscles, instructions_ru,
            source_url, gif_url, image_url, training_types, movement_pattern, level, training_contexts
     FROM exercise_library
     WHERE ${equipmentFilter}
       AND category IN ('upper legs','chest','back','shoulders','waist','lower legs','upper arms','lower arms')
     LIMIT 1324`
  );

  const candidates: LibraryExercise[] = rows.map((row: any) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    nameRu: String(row.name_ru ?? ''),
    category: String(row.category ?? ''),
    bodyPartRu: String(row.body_part_ru ?? ''),
    equipment: String(row.equipment ?? ''),
    equipmentRu: String(row.equipment_ru ?? ''),
    target: String(row.target ?? ''),
    muscleGroup: String(row.muscle_group ?? ''),
    muscleGroupRu: String(row.muscle_group_ru ?? ''),
    secondaryMuscles: Array.isArray(row.secondary_muscles) ? row.secondary_muscles : [],
    instructionsRu: String(row.instructions_ru ?? ''),
    sourceUrl: String(row.source_url ?? ''),
    gifUrl: String(row.gif_url ?? ''),
    imageUrl: String(row.image_url ?? ''),
    trainingTypes: Array.isArray(row.training_types) ? row.training_types.map(String) : ['maintenance'],
    movementPattern: String(row.movement_pattern ?? ''),
    level: String(row.level ?? 'beginner'),
    trainingContexts: Array.isArray(row.training_contexts) ? row.training_contexts.map(String) : []
  }));

  const allowed = candidates.filter((row) => isExerciseAllowed(row, profile.limitations ?? ''));
  const focus = profile.training_focus && profile.training_focus !== 'auto'
    ? profile.training_focus
    : deriveTrainingFocus(profile);

  // Build a genuinely diverse planning pool: every major body region must be represented.
  // The previous selector could fill the pool with a few dominant categories, which made
  // gym and outdoor programs converge on the same small set of movements.
  const categoryPlan = ['upper legs','chest','back','shoulders','upper arms','lower arms','waist','lower legs'];

  const selected: LibraryExercise[] = [];
  const used = new Set<string>();

  for (const category of categoryPlan) {
    const ranked = allowed
      .filter((row) => row.category === category)
      .map((row) => ({ ...row, score: scoreExercise(row, profile, category, used) }))
      .sort((a, b) => b.score - a.score);

    // Give the AI several alternatives per muscle region, not just one exercise.
    for (const row of ranked) {
      if (selected.length >= 32) break;
      if (used.has(row.id)) continue;
      selected.push(row);
      used.add(row.id);
      if (selected.filter((x) => x.category === category).length >= 4) break;
    }
  }

  // Fill remaining slots with the best unique exercises, but penalise duplicates of
  // the same movement so the AI sees a broad exercise vocabulary.
  const focusRanked = allowed
    .filter((row) => !used.has(row.id))
    .map((row) => ({ ...row, score: scoreExercise(row, profile, row.category, used) }))
    .sort((a, b) => b.score - a.score);

  for (const row of focusRanked) {
    if (selected.length >= 32) break;
    selected.push(row);
    used.add(row.id);
  }

  console.log('Program exercise pool:', { focus, selected: selected.length, location: profile.location });
  if (fullCatalog) return allowed;
  return selected.slice(0, 32);
}

function exerciseProgression(profile: ProfileForProgram, reps: string) {
  const upper = reps.match(/(\\d+)\\s*[–-]\\s*(\\d+)/);
  if (upper) {
    return `Когда верхняя граница диапазона выполняется во всех подходах с чистой техникой, постепенно увеличивать нагрузку и снова работать с нижней границы диапазона.`;
  }
  if (/мин|сек/.test(reps)) {
    return 'Постепенно увеличивать продолжительность или сокращать паузы небольшими шагами при сохранении техники.';
  }
  return 'Увеличивать объём или нагрузку постепенно, сохраняя контролируемую технику.';
}

function exerciseRecommendation(profile: ProfileForProgram, row: LibraryExercise) {
  const difficulty = exerciseDifficulty(row);
  if (difficulty >= 3 && profile.experience === 'beginner') {
    return 'Для новичка использовать упрощённый вариант или минимальную нагрузку; приоритет — техника.';
  }
  if (profile.limitations) {
    return 'Выполнять без боли; при появлении дискомфорта прекратить упражнение и подобрать альтернативу.';
  }
  return 'Контролировать амплитуду и технику; оставлять небольшой запас повторений и не доводить каждый подход до отказа.';
}

function exercisePrescription(row: LibraryExercise, profile: ProfileForProgram, index: number): Exercise {
  const beginner = profile.experience === 'beginner' || profile.experience === 'under1';
  const isMass = profile.goal === 'mass';
  const isHealth = profile.goal === 'health';

  let sets = isMass ? 3 : 2;
  if (!beginner && index < 4) sets += 1;
  if (profile.workout_duration <= 45 && index >= 4) sets = 2;

  let reps = isMass ? '8–12' : isHealth ? '10–15' : '10–15';
  if (beginner) reps = isMass ? '8–12' : '10–15';

  const difficulty = exerciseDifficulty(row);
  if (beginner && difficulty >= 2 && !isMass) reps = '8–12';

  return {
    id: row.id,
    muscleGroup: row.muscleGroupRu || row.bodyPartRu,
    movementPattern: row.movementPattern,
    name: row.nameRu || ruExerciseName(row.name),
    gifUrl: row.gifUrl,
    sets,
    reps,
    rest: index < 4 ? (isMass ? '90–120 сек' : '60–90 сек') : '45–60 сек',
    progression: exerciseProgression(profile, reps),
    recommendation: exerciseRecommendation(profile, row),
    comment: isMass
      ? 'Контролируемая техника, 1–3 повторения в запасе. При достижении верхней границы повторений постепенно увеличивать нагрузку.'
      : 'Выбирать вариант упражнения, который можно выполнять с устойчивой техникой без боли.'
  };
}

async function buildProgram(profile: any, version: number, correction = ''): Promise<Program> {
  const normalizedProfile: ProfileForProgram = {
    goal: String(profile.goal),
    experience: String(profile.experience),
    location: String(profile.location),
    workouts_per_week: Number(profile.workouts_per_week),
    workout_duration: Number(profile.workout_duration),
    limitations: String(profile.limitations ?? ''),
    training_focus: String(profile.training_focus ?? 'auto')
  };

  const frequency = Math.min(Math.max(normalizedProfile.workouts_per_week, 1), 5);
  const duration = normalizedProfile.workout_duration;
  const library = await getLibraryExercises(normalizedProfile, version, true);
  if (!library.length) throw new Error('No training-base exercises available for this location');

  const beginner = normalizedProfile.experience === 'beginner' || normalizedProfile.experience === 'under1';
  const uniqueByName = (rows: LibraryExercise[]) => {
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = normalizeText(row.nameRu || row.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const candidates = uniqueByName(library)
    .filter((row) => !beginner || row.level !== 'advanced')
    .filter((row) => isExerciseAllowed(row, normalizedProfile.limitations ?? ''));

  const used = new Set<string>();
  const usedNames = new Set<string>();

  const take = (count: number, filter: (row: LibraryExercise) => boolean, preferred?: (row: LibraryExercise) => number) => {
    const pool = candidates
      .filter((row) => !used.has(row.id) && !usedNames.has(normalizeText(row.nameRu || row.name)))
      .filter(filter)
      .sort((a,b) => (preferred ? preferred(b) - preferred(a) : 0));
    const result: LibraryExercise[] = [];
    for (const row of pool) {
      result.push(row);
      used.add(row.id);
      usedNames.add(normalizeText(row.nameRu || row.name));
      if (result.length >= count) break;
    }
    return result;
  };

  const priority = (row: LibraryExercise) => {
    let score = 0;
    const text = normalizeText(row.nameRu || row.name);
    if (/присед|жим|тяга|подтяг|отжим|румын|hip thrust|ягодичный мост|выпад/.test(text)) score += 20;
    if (row.movementPattern && /присед|жим|тяга|сгибание|разгибание|анти|ротац|стабилиз/.test(normalizeText(row.movementPattern))) score += 8;
    if (row.gifUrl) score += 2;
    if (row.level === 'beginner') score += beginner ? 8 : 2;
    if (normalizedProfile.goal === 'mass' && row.trainingTypes.includes('hypertrophy')) score += 8;
    if (normalizedProfile.goal === 'loss' && row.trainingTypes.includes('endurance')) score += 5;
    return score;
  };

  const toExercise = (row: LibraryExercise, index: number): Exercise => exercisePrescription(row, normalizedProfile, index);

  const mainCount = duration <= 45 ? 5 : 6;
  const makeDay = (day: number, title: string, focus: string, rows: LibraryExercise[]) => ({
    day,
    title,
    focus,
    warmup: duration <= 45
      ? '5–7 минут: общая активизация + динамическая разминка суставов и движений дня.'
      : '8–10 минут: общая активизация + динамическая разминка суставов и движений дня.',
    exercises: rows.map((row, i) => toExercise(row, i)),
    cooldown: '5–7 минут: спокойное восстановление и лёгкая мобильность без силовой работы.'
  });

  const days: WorkoutDay[] = [];

  if (frequency === 1 || frequency === 2) {
    const patterns = [
      ['Грудь','Спина','Ноги','Плечи','Руки','Кор'],
      ['Ноги','Спина','Грудь','Плечи','Руки','Голень','Кор']
    ];
    for (let d = 0; d < frequency; d++) {
      const rows: LibraryExercise[] = [];
      for (const group of patterns[d]) {
        rows.push(...take(1, (r) => r.bodyPartRu === group || r.muscleGroupRu === group, priority));
        if (rows.length >= mainCount) break;
      }
      days.push(makeDay(d + 1, `День ${d + 1} — Full Body${frequency === 2 ? (d === 0 ? ' A' : ' B') : ''}`, 'Full Body', rows.slice(0, mainCount)));
    }
  } else {
    const chest = take(normalizedProfile.location === 'outdoor' ? 1 : 3, (r) => r.category === 'chest', priority);
    const arms = take(normalizedProfile.location === 'outdoor' ? 2 : 3, (r) => r.category === 'upper arms', priority);
    let day1Rows = [...chest, ...arms];
    if (day1Rows.length < 4) {
      day1Rows.push(...take(4 - day1Rows.length, (r) => ['shoulders','back'].includes(r.category), priority));
    }
    days.push(makeDay(1, 'День 1 — Грудь + руки', 'Грудь + руки', day1Rows.slice(0, mainCount)));

    const back = take(normalizedProfile.location === 'outdoor' ? 3 : 3, (r) => r.category === 'back', priority);
    const shoulders = take(normalizedProfile.location === 'outdoor' ? 1 : 3, (r) => r.category === 'shoulders', priority);
    let day2Rows = [...back, ...shoulders];
    if (day2Rows.length < 4) {
      day2Rows.push(...take(4 - day2Rows.length, (r) => ['back','shoulders'].includes(r.category), priority));
    }
    days.push(makeDay(2, 'День 2 — Спина + плечи', 'Спина + плечи', day2Rows.slice(0, mainCount)));

    const legTargets = [
      /квадриц/i, /ягод/i, /задн.*бедр/i, /привод/i, /голен|икрон|камбал/i
    ];
    const legRows: LibraryExercise[] = [];
    for (const target of legTargets) {
      legRows.push(...take(1, (r) => r.category === 'upper legs' || r.category === 'lower legs'
        ? target.test(normalizeText(r.muscleGroupRu + ' ' + r.target + ' ' + r.nameRu))
        : false, priority));
    }
    legRows.push(...take(Math.max(0, mainCount - legRows.length), (r) => ['upper legs','lower legs'].includes(r.category), priority));
    days.push(makeDay(3, 'День 3 — Ноги', 'Ноги', legRows.slice(0, mainCount)));

    if (frequency >= 4) {
      const functionalPatterns = [
        /присед|разгибание колена|выпад/,
        /разгибание бедра|сгибание колена|тяга/,
        /жим|горизонтальное приведение/,
        /горизонтальная тяга|вертикальная тяга/,
        /антиразгибание|анти-ротация|ротация|контроль корпуса/,
        /протракция|стабилизация|отведение/
      ];
      const functionalRows: LibraryExercise[] = [];
      for (const pattern of functionalPatterns) {
        const got = take(1, (r) => pattern.test(normalizeText(r.movementPattern + ' ' + r.nameRu)), priority);
        if (got[0]) functionalRows.push(got[0]);
      }
      if (functionalRows.length < 4) {
        functionalRows.push(...take(4 - functionalRows.length, (r) => ['waist','upper legs','back','chest','shoulders'].includes(r.category), priority));
      }
      days.push(makeDay(4, 'День 4 — Функционал + растяжка', 'Функционал + растяжка', functionalRows.slice(0, Math.max(5, Math.min(6, mainCount)))));
    }

    if (frequency >= 5) {
      const extra = take(Math.max(4, Math.min(6, mainCount)), (r) => ['chest','back','shoulders','upper arms','waist'].includes(r.category), priority);
      days.push(makeDay(5, 'День 5 — Дополнительная тренировка', 'Дополнительный сплит', extra));
    }
  }

  const format = frequency <= 2 ? 'Full Body' : `Сплит ${frequency} дней`;
  return {
    title: 'Программа',
    goal: ruGoal(normalizedProfile.goal),
    frequency,
    duration,
    location: ruLocation(normalizedProfile.location),
    version,
    weeks: 4,
    progression: '4 недели: сохраняй технику, постепенно увеличивай повторения до верхней границы диапазона; после стабильного выполнения повышай сопротивление небольшим шагом.',
    days,
    notes: [
      `Источник упражнений: анатомо-тренировочная база, 120 упражнений, разделённых по мышцам и месту тренировок.`,
      `Формат: ${format}. День 1 — грудь + руки; День 2 — спина + плечи; День 3 — ноги; День 4 — функционал + растяжка.`,
      'Разминка и заминка отделены от основной тренировки.',
      'Внутри программы одно и то же упражнение не повторяется.',
      normalizedProfile.limitations ? `Ограничения из анкеты: ${normalizedProfile.limitations}.` : 'Ограничений в анкете не указано.',
      correction ? `Учтена коррекция: ${correction}` : 'Программа сформирована по исходной анкете.'
    ]
  };
}

async function saveProfile(user: { id: number; username?: string; firstName: string }, state: QuizState) {
  await pool.query(
    `INSERT INTO trainer_profiles
      (telegram_user_id, telegram_username, first_name, goal, experience, location, workouts_per_week, workout_duration, limitations, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       telegram_username=EXCLUDED.telegram_username, first_name=EXCLUDED.first_name,
       goal=EXCLUDED.goal, experience=EXCLUDED.experience, location=EXCLUDED.location,
       workouts_per_week=EXCLUDED.workouts_per_week, workout_duration=EXCLUDED.workout_duration,
       limitations=EXCLUDED.limitations,
       training_focus=CASE WHEN EXCLUDED.goal='mass' THEN 'hypertrophy' WHEN EXCLUDED.goal='loss' THEN 'endurance' ELSE 'maintenance' END,
       updated_at=NOW()`,
    [user.id, user.username ?? null, user.firstName, state.goal, state.experience, state.location,
      state.workoutsPerWeek, state.workoutDuration, state.limitations ?? '']
  );
}

async function getPaymentInfo(userId: number) {
  const { rows } = await pool.query(
    'SELECT payment_amount, training_sessions_total, training_sessions_remaining FROM trainer_profiles WHERE telegram_user_id = $1',
    [userId]
  );
  return rows[0] ?? { payment_amount: 0, training_sessions_total: 0, training_sessions_remaining: 0 };
}

async function updatePaymentInfo(userId: number, amount: number, total: number, remaining: number) {
  await pool.query(
    `UPDATE trainer_profiles
     SET payment_amount = $2, training_sessions_total = $3, training_sessions_remaining = $4, updated_at = NOW()
     WHERE telegram_user_id = $1`,
    [userId, amount, total, remaining]
  );
}

async function sendPaymentPanel(ctx: any, targetId?: number) {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.reply('Доступ закрыт.');
  const userId = targetId ?? selectedClient.get(ctx.from.id);
  if (!userId) return ctx.reply('Сначала выбери клиента.');
  const profile = await getProfile(userId);
  const p = await getPaymentInfo(userId);
  await ctx.reply(
    `${identityBlock(profile)}

💳 <b>Оплата и тренировки</b>

💰 Оплачено: <b>${formatMoney(Number(p.payment_amount))}</b>
🏋️ Всего тренировок: <b>${Number(p.training_sessions_total)}</b>
⏳ Осталось тренировок: <b>${Number(p.training_sessions_remaining)}</b>
✅ Проведено: <b>${Math.max(0, Number(p.training_sessions_total) - Number(p.training_sessions_remaining))}</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('✏️ Изменить оплату', 'payment:edit')
        .row()
        .text('➖ Провести тренировку', 'payment:use')
        .row()
        .text('📜 История оплат', 'payment:history')
        .row()
        .text('⬅️ Админ-панель', 'admin:open')
    }
  );
}

async function getProfile(id: number) {
  const { rows } = await pool.query('SELECT * FROM trainer_profiles WHERE telegram_user_id = $1', [id]);
  return rows[0] ?? null;
}

function buildExercises(location: string, goal: string, version: number): Exercise[] {
  const home = [
    { name: 'Приседание с собственным весом', sets: 3, reps: '10–15', rest: '60–90 сек' },
    { name: 'Отжимания', sets: 3, reps: '8–15', rest: '60–90 сек' },
    { name: 'Тяга рюкзака в наклоне', sets: 3, reps: '10–15', rest: '60–90 сек' },
    { name: 'Жим рюкзака над головой', sets: 2, reps: '10–12', rest: '60 сек' },
    { name: 'Dead Bug', sets: 2, reps: '8–12/сторона', rest: '45–60 сек' }
  ];
  const gym = [
    { name: 'Приседание со штангой или гоблет-присед', sets: 3, reps: '8–12', rest: '90–120 сек' },
    { name: 'Жим лёжа', sets: 3, reps: '8–12', rest: '90–120 сек' },
    { name: 'Тяга верхнего блока', sets: 3, reps: '8–12', rest: '90 сек' },
    { name: 'Румынская тяга', sets: 3, reps: '8–12', rest: '90–120 сек' },
    { name: 'Жим гантелей сидя', sets: 2, reps: '10–12', rest: '60–90 сек' },
    { name: 'Pallof Press', sets: 2, reps: '10–12/сторона', rest: '45–60 сек' }
  ];
  const outdoor = [
    { name: 'Приседание', sets: 3, reps: '10–15', rest: '60–90 сек' },
    { name: 'Отжимания от опоры', sets: 3, reps: '8–15', rest: '60–90 сек' },
    { name: 'Подтягивания с подходящей вариацией', sets: 3, reps: '5–10', rest: '90 сек' },
    { name: 'Good Morning без отягощения', sets: 3, reps: '10–15', rest: '60 сек' },
    { name: 'Выпады назад', sets: 2, reps: '8–12/нога', rest: '60–90 сек' },
    { name: 'Dead Bug', sets: 2, reps: '8–12/сторона', rest: '45–60 сек' }
  ];
  const base = location === 'gym' ? gym : location === 'outdoor' ? outdoor : home;
  if (location === 'mixed') {
    return version % 2 === 1 ? gym : home;
  }
  return base.map((e) => ({ ...e, comment: goal === 'mass' ? 'Оставлять 1–3 повторения в запасе; при выполнении верхней границы повторений постепенно повышать нагрузку.' : undefined }));
}


function convertAIPlanToProgram(aiPlan: Awaited<ReturnType<typeof createAIWorkoutPlan>>, profile: any, version: number, candidates: LibraryExercise[], correction: string): Program | null {
  if (!aiPlan) return null;
  const byId = new Map(candidates.map((e) => [e.id, e]));
  const days: WorkoutDay[] = aiPlan.days.map((day) => ({
    day: day.day,
    title: day.title,
    focus: day.focus,
    warmup: day.warmup,
    exercises: day.exercises.map((item) => {
      const row = byId.get(item.exerciseId);
      if (!row) throw new Error(`AI exercise not found in catalog: ${item.exerciseId}`);
      return {
        id: row.id,
        muscleGroup: row.bodyPartRu || row.muscleGroupRu,
        movementPattern: row.movementPattern,
        name: row.nameRu || ruExerciseName(row.name),
        gifUrl: row.gifUrl,
        sets: item.sets,
        reps: item.reps,
        rest: item.rest,
        progression: aiPlan.progression,
        recommendation: item.comment,
        comment: item.comment
      };
    }),
    cooldown: day.cooldown
  }));

  return {
    title: aiPlan.title || `AI-программа: ${ruGoal(String(profile.goal))}`,
    goal: ruGoal(String(profile.goal)),
    frequency: days.length,
    duration: Number(profile.workout_duration),
    location: ruLocation(String(profile.location)),
    version,
    weeks: 4,
    progression: aiPlan.progression,
    days,
    notes: [
      `🤖 AI-планировщик: ${aiPlan.format}.`,
      aiPlan.rationale,
      ...aiPlan.notes,
      correction ? `Учтена коррекция: ${correction}` : 'Программа сформирована с учётом профиля клиента и каталога упражнений.'
    ]
  };
}

async function createProgram(userId: number, correction = '') {
  const profile = await getProfile(userId);
  if (!profile) return null;
  const { rows: versionRows } = await pool.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM training_programs WHERE telegram_user_id = $1',
    [userId]
  );
  const version = Number(versionRows[0].next_version);

  // The workbook is authoritative. AI is not allowed to substitute exercises,
  // invent movements, or change the fixed split.
  const program = await buildProgram(profile, version, correction);
  console.log('Program planning completed', { userId, version, source: 'training-workbook' });

  const { rows } = await pool.query(
    `INSERT INTO training_programs (telegram_user_id, version, status, program, correction_request)
     VALUES ($1,$2,'draft',$3::jsonb,$4) RETURNING id, version`,
    [userId, version, JSON.stringify(program), correction]
  );
  return { id: Number(rows[0].id), version, program };
}

async function getCurrentProgram(userId: number) {
  const { rows } = await pool.query(
    `SELECT id, version, status, program, correction_request, created_at
     FROM training_programs WHERE telegram_user_id = $1
     ORDER BY version DESC LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resolveGifUrl(gifUrl?: string) {
  if (!gifUrl) return '';
  if (/^https?:\/\//i.test(gifUrl)) return gifUrl;
  return 'https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/' + gifUrl.replace(/^\/+/, '');
}

function stripHtml(value: string) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

async function sendProgramText(ctx: any, text: string, replyMarkup?: InlineKeyboard) {
  // Telegram allows up to 4096 characters in a text message. Keep a safe margin
  // and split on real newlines so we never cut an HTML tag in half.
  const limit = 3500;
  const chunks: string[] = [];
  let current = '';

  for (const line of text.split('\n')) {
    // A single generated line can theoretically be longer than the safe limit.
    // Split that line without ever breaking an HTML tag.
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      let rest = line;
      while (rest.length > limit) {
        let cut = rest.lastIndexOf(' ', limit);
        if (cut < 1) cut = limit;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
      }
      if (rest) current = rest;
      continue;
    }

    const candidate = current ? current + '\n' + line : line;
    if (current && candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    const options = i === chunks.length - 1 && replyMarkup
      ? { reply_markup: replyMarkup }
      : {};

    try {
      await ctx.reply(chunks[i], { ...options, parse_mode: 'HTML' as const });
    } catch (error) {
      const message = String((error as any)?.message ?? '');
      if (!/can't parse entities|cannot parse entities|Bad Request/i.test(message)) {
        throw error;
      }

      // Formatting must never prevent delivery of a saved program.
      // If Telegram rejects HTML, resend the exact chunk as plain text.
      console.warn('Telegram rejected program HTML; retrying plain text', { chunk: i + 1, error });
      await ctx.reply(stripHtml(chunks[i]), options);
    }
  }
}

async function sendProgramMedia(ctx: any, program: Program, replyMarkup?: InlineKeyboard) {
  await sendProgramText(ctx, [
    `🏋️ <b>${escapeHtml(program.title)}</b>`,
    `🎯 Цель: ${escapeHtml(program.goal)}`,
    `📍 Формат: ${escapeHtml(program.location)}`,
    `📅 График: ${program.frequency} тренировок/неделю`,
    `⏱ Длительность: ${program.duration} мин`,
    '',
    `📈 <b>Прогрессия</b>`,
    escapeHtml(program.progression)
  ].join('\n'));

  for (const day of program.days) {
    await sendProgramText(ctx, [
      '━━━━━━━━━━━━━━━━━━',
      `🏋️ <b>ДЕНЬ ${day.day}</b>`,
      `🎯 <b>${escapeHtml(day.focus)}</b>`,
      '',
      '🔥 <b>РАЗМИНКА</b>',
      escapeHtml(day.warmup),
      '',
      '💪 <b>УПРАЖНЕНИЯ</b>'
    ].join('\n'));

    for (let i = 0; i < day.exercises.length; i++) {
      const exercise = day.exercises[i];
      const exerciseText = [
        `<b>${i + 1}. ${escapeHtml(exercise.name)}</b>`,
        `Подходы: ${exercise.sets}`,
        `Повторения: ${escapeHtml(exercise.reps)}`,
        `Отдых: ${escapeHtml(exercise.rest)}`
      ].join('\n');

      await sendProgramText(ctx, exerciseText);

      const url = resolveGifUrl(exercise.gifUrl);
      if (url) {
        try {
          await ctx.replyWithAnimation(url, {
            caption: `<b>${i + 1}. ${escapeHtml(exercise.name)}</b>`,
            parse_mode: 'HTML'
          });
        } catch (error) {
          console.error('exercise gif send failed', { name: exercise.name, url, error });
        }
      } else {
        console.warn('exercise has no GIF', { name: exercise.name });
      }
    }

    await sendProgramText(ctx, [
      '',
      '🧘 <b>ЗАМИНКА</b>',
      escapeHtml(day.cooldown)
    ].join('\n'));
  }

  await sendProgramText(ctx, [
    '━━━━━━━━━━━━━━━━━━',
    '📝 <b>ПРИМЕЧАНИЯ</b>',
    ...program.notes.map((note) => '• ' + escapeHtml(note))
  ].join('\n'), replyMarkup);
}
function programText(program: Program) {
  const parts = [
    `🏋️ <b>${escapeHtml(program.title)}</b>`,
    '',
    '📌 <b>Параметры программы</b>',
    `🎯 Цель: <b>${escapeHtml(program.goal)}</b>`,
    `📍 Формат: <b>${escapeHtml(program.location)}</b>`,
    `📅 График: <b>${program.frequency} тренировки/неделю</b>`,
    `⏱ Длительность: <b>${program.duration} мин</b>`,
    '',
    '━━━━━━━━━━━━━━',
    '',
    '📈 <b>Прогрессия</b>',
    escapeHtml(program.progression),
    ''
  ];

  for (const day of program.days) {
    parts.push(
      '',
      '━━━━━━━━━━━━━━',
      '',
      `🏋️ <b>${escapeHtml(day.title)}</b>`,
      `🎯 Фокус: <b>${escapeHtml(day.focus)}</b>`,
      '',
      '🔥 <b>Разминка</b>',
      escapeHtml(day.warmup),
      '',
      '💪 <b>Упражнения</b>',
      ''
    );

    day.exercises.forEach((e, i) => {
      parts.push(
        `<b>${i + 1}. ${escapeHtml(e.name)}</b>`,
        `   Подходы: <b>${e.sets}</b>   Повторения: <b>${escapeHtml(e.reps)}</b>`,
        `   Отдых: <b>${escapeHtml(e.rest)}</b>`,
        `   📊 Количество: <b>${e.sets} × ${escapeHtml(e.reps)}</b>`,
        e.progression ? `   📈 Прогрессия: ${escapeHtml(e.progression)}` : '',
        e.recommendation ? `   💡 Рекомендация: ${escapeHtml(e.recommendation)}` : (e.comment ? `   💡 ${escapeHtml(e.comment)}` : ''),
        ''
      );
    });

    parts.push(
      `🧘 <b>Заминка</b>`,
      escapeHtml(day.cooldown),
      ''
    );
  }

  parts.push(
    '',
    '━━━━━━━━━━━━━━',
    '',
    '📝 <b>Важные примечания</b>',
    '',
    ...program.notes.map((note) => `• ${escapeHtml(note)}`)
  );

  return parts.join('\n');
}

function exerciseMuscleGroup(name: string, focus = '') {
  const text = normalizeText(name);
  const focusText = normalizeText(focus);

  // UI-level groups intentionally differ from the detailed anatomy taxonomy:
  // Бицепс + трицепс + плечевая мышца = Руки.
  // Квадрицепс + задняя поверхность бедра + ягодицы + икры + приводящие = Ноги.
  if (/(груд|жим.*леж|жим.*наклон|отжим|кроссовер|сведен.*груд|pec deck|chest fly)/.test(text)) {
    return 'Грудь';
  }

  if (/(широч|спин|подтяг|пуловер|ромб|трапец|тяга.*верхн|тяга.*гориз|тяга.*пояс|тяга.*гантел|тяга.*штанг)/.test(text)) {
    return 'Спина';
  }

  if (/(плеч|дельт|разведен.*сторон|жим.*над.*голов|жим.*плеч|задн.*дельт|мах.*сторон)/.test(text)) {
    return 'Плечи';
  }

  // All arm musculature is one correction group.
  if (/(бицеп|трицеп|плечев.*мышц|сгибан.*рук|разгибан.*рук|молот|hammer curl|curl|triceps|француз)/.test(text)) {
    return 'Руки';
  }

  // All lower-body musculature is one correction group.
  if (/(квадриц|присед|выпад|жим ног|разгибан.*ног|сгибан.*ног|зашаг|step[- ]?up|ягод|hip thrust|glute bridge|отведен.*бедр|румын|станов|good morning|бицепс бедр|задн.*поверх.*бедр|икр|голен|носк|приводящ)/.test(text)) {
    return 'Ноги';
  }

  if (/(пресс|живот|скручив|планк|dead bug|dead bug|кор|pallof|anti[- ]rotation|rotation|подъем.*ног)/.test(text)) {
    return 'Кор';
  }

  if (/(зубчат|лопат|вращательн.*манжет|манжет.*плеч)/.test(text)) {
    return 'Плечевой пояс';
  }

  // If the exercise name is generic, use the day focus only as a last resort.
  if (focusText.includes('груд')) return 'Грудь';
  if (focusText.includes('спин')) return 'Спина';
  if (focusText.includes('плеч')) return 'Плечи';
  if (focusText.includes('рук')) return 'Руки';
  if (focusText.includes('ног')) return 'Ноги';
  if (focusText.includes('кор')) return 'Кор';

  return 'Другое';
}

function correctionCategorySet(group: string) {
  if (group === 'Грудь') return new Set(['chest']);
  if (group === 'Спина') return new Set(['back']);
  if (group === 'Плечи') return new Set(['shoulders']);
  if (group === 'Руки') return new Set(['upper arms','lower arms']);
  if (group === 'Ноги') return new Set(['upper legs','lower legs']);
  if (group === 'Кор') return new Set(['waist']);
  return new Set<string>();
}

function correctionGroupsForDay(program: Program, dayNumber: number) {
  const day = program.days.find((d) => d.day === dayNumber);
  if (!day) return [];
  const groups = new Set<string>();
  for (const exercise of day.exercises) {
    const group = exerciseMuscleGroup(exercise.name, day.focus);
    if (group !== 'Другое') groups.add(group);
  }
  return [...groups];
}

async function showCorrectionDays(ctx: any, programId: number) {
  const { rows } = await pool.query('SELECT program FROM training_programs WHERE id=$1', [programId]);
  if (!rows[0]) return ctx.reply('Программа не найдена.');
  const program = rows[0].program as Program;
  const kb = new InlineKeyboard();
  for (const day of program.days) kb.text(`🏋️ День ${day.day} — ${day.focus}`, `program:correct:day:${programId}:${day.day}`).row();
  kb.text('⬅️ Назад к программе', `program:correct:back:${programId}`);
  await ctx.reply('🔧 <b>Коррекция программы</b>\n\nВыбери день:', {parse_mode:'HTML',reply_markup:kb});
}

async function showCorrectionGroups(ctx: any, programId: number, dayNumber: number) {
  const { rows } = await pool.query('SELECT program FROM training_programs WHERE id=$1', [programId]);
  if (!rows[0]) return ctx.reply('Программа не найдена.');
  const program = rows[0].program as Program;
  const groups = correctionGroupsForDay(program, dayNumber);
  const kb = new InlineKeyboard();
  for (const group of groups) kb.text(`💪 ${group}`, `program:correct:group:${programId}:${dayNumber}:${correctionGroupSlug(group)}`).row();
  kb.text('⬅️ Дни', `program:correct:days:${programId}`);
  await ctx.reply(`🏋️ <b>День ${dayNumber}</b>\n\nВыбери группу мышц:`, {parse_mode:'HTML',reply_markup:kb});
}

async function showCorrectionExercises(ctx: any, programId: number, dayNumber: number, group: string) {
  const { rows } = await pool.query('SELECT program FROM training_programs WHERE id=$1', [programId]);
  if (!rows[0]) return ctx.reply('Программа не найдена.');
  const profileId = selectedClient.get(ctx.from?.id ?? 0) ?? ctx.from?.id;
  const profile = profileId ? await getProfile(profileId) : null;
  const library = await getLibraryExercises({
    goal:String(profile?.goal ?? 'health'), experience:String(profile?.experience ?? 'beginner'),
    location:String(profile?.location ?? 'gym'), workouts_per_week:Number(profile?.workouts_per_week ?? 4),
    workout_duration:Number(profile?.workout_duration ?? 60), limitations:String(profile?.limitations ?? '')
  }, Number(rows[0].program?.version ?? 1), true);

  const categories = correctionCategorySet(group);
  const candidates = library
    .filter((row) => categories.has(row.category))
    .filter((row) => isExerciseAllowed(row, String(profile?.limitations ?? '')));

  const unique: LibraryExercise[] = [];
  const seen = new Set<string>();
  for (const row of candidates) {
    const name = row.nameRu || ruExerciseName(row.name);
    const key = normalizeText(name);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }

  const program = rows[0].program as Program;
  const day = program.days.find((d) => d.day === dayNumber);
  const targetExerciseIndex = day?.exercises.findIndex((exercise) =>
    exercise.muscleGroup === group ||
    exerciseMuscleGroup(exercise.name, day.focus) === group
  ) ?? -1;
  if (targetExerciseIndex < 0) return ctx.reply('В выбранном дне нет упражнения этой группы.');

  correctionSessions.set(ctx.from?.id ?? 0, {
    programId,
    day: dayNumber,
    muscleGroup: group,
    exerciseIndex: targetExerciseIndex,
    catalogChoices: unique.map((row) => row.id)
  });

  const kb = new InlineKeyboard();
  unique.slice(0, 50).forEach((row, index) => {
    const name = row.nameRu || ruExerciseName(row.name);
    kb.text(`🏋️ ${name.slice(0, 32)}`, `program:correct:pick:${programId}:${dayNumber}:${index}`).row();
  });
  kb.text('⬅️ Группы', `program:correct:day:${programId}:${dayNumber}`);

  await ctx.reply(
    `💪 <b>${escapeHtml(group)}</b>\n\nУпражнения из нашей анатомо-тренировочной базы для текущего места тренировок.\nВыбери упражнение — оно заменит текущее упражнение этой группы в выбранном дне.`,
    {parse_mode:'HTML',reply_markup:kb}
  );
}

function programKeyboard(programId: number, status = 'draft') {
  const kb = new InlineKeyboard()
    .text('🔄 Скорректировать программу', `program:correct:${programId}`)
    .row()
    .text('📚 История программ', 'program:history')
    .text('👤 Профиль', 'profile');
  if (status === 'draft') kb.row().text('✅ Подтвердить программу', `program:approve:${programId}`);
  return kb;
}

async function sendCurrentProgram(ctx: any, targetId?: number) {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.reply('Доступ закрыт.');
  const userId = targetId ?? selectedClient.get(ctx.from.id) ?? ctx.from.id;
  const profile = await getProfile(userId);
  const current = await getCurrentProgram(userId);
  if (!current) {
    const created = await createProgram(userId);
    if (!created) return ctx.reply('Сначала заполните профиль.');
    return sendProgramMedia(ctx, created.program, programKeyboard(created.id));
  }
  await sendProgramMedia(ctx, current.program, programKeyboard(Number(current.id), current.status));
}

async function startQuiz(ctx: any) {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.reply('Доступ закрыт.');
  const targetId = selectedClient.get(ctx.from.id);
  if (!targetId) return ctx.reply('Сначала выбери клиента в разделе «Клиенты» или добавь нового клиента.');
  quizTargets.set(ctx.from.id, targetId);
  clientSearchSessions.delete(ctx.from.id);
  sessions.set(ctx.from.id, { step: 'goal' });
  await ctx.reply('Шаг 1/6. Какая главная цель?', {
    reply_markup: new InlineKeyboard()
      .text('Похудение', 'goal:loss')
      .text('Набор массы', 'goal:mass')
      .row()
      .text('Здоровье и форма', 'goal:health')
  });
}

async function startKeyboard() {
  const keyboard = new InlineKeyboard();
  if (adminId !== null) keyboard.text('🛠 Админ-панель', 'admin:open');
  return keyboard;
}

async function sendAdminPanel(ctx: any) {
  if (!(await isAdmin(ctx))) return ctx.reply('Доступ закрыт.');
  await ctx.reply('🛠 Админ-панель\n\nУправление профилем, программами и версиями.', {
    reply_markup: new InlineKeyboard()
      .text('📊 Статистика', 'admin:stats')
      .row()
      .text('💳 Оплата и тренировки', 'payment:open')
      .row()
      .text('👥 Клиенты', 'admin:profiles')
      .row()
      .text('➕ Добавить клиента', 'admin:client:add')
  });
}

async function getAdminStats() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE goal = 'loss')::int AS loss,
      COUNT(*) FILTER (WHERE goal = 'mass')::int AS mass,
      COUNT(*) FILTER (WHERE goal = 'health')::int AS health
    FROM trainer_profiles
  `);
  const programs = await pool.query('SELECT COUNT(*)::int AS total, COUNT(DISTINCT telegram_user_id)::int AS users FROM training_programs');
  return { ...(rows[0] ?? { total: 0, loss: 0, mass: 0, health: 0 }), programs: programs.rows[0] };
}

async function getRecentProfiles() {
  const { rows } = await pool.query(`
    SELECT
      c.id AS client_id,
      p.telegram_user_id,
      c.telegram_username,
      c.first_name,
      p.goal,
      p.experience,
      p.location,
      p.workouts_per_week,
      p.workout_duration,
      p.payment_amount,
      p.training_sessions_total,
      p.training_sessions_remaining,
      p.updated_at
    FROM clients c
    JOIN trainer_profiles p ON p.telegram_user_id = -c.id
    ORDER BY p.updated_at DESC
    LIMIT 20
  `);
  return rows;
}

async function searchClients(query: string) {
  const q = query.trim().replace(/^@/, '');
  if (!q) return [];
  const { rows } = await pool.query(
    `SELECT
       c.id AS client_id,
       p.telegram_user_id,
       c.telegram_username,
       c.first_name,
       p.goal,
       p.experience,
       p.location,
       p.workouts_per_week,
       p.workout_duration,
       p.payment_amount,
       p.training_sessions_total,
       p.training_sessions_remaining,
       p.updated_at
     FROM clients c
     JOIN trainer_profiles p ON p.telegram_user_id = -c.id
     WHERE LOWER(COALESCE(c.telegram_username, '')) LIKE LOWER($1)
        OR LOWER(COALESCE(c.first_name, '')) LIKE LOWER($1)
        OR CAST(c.id AS TEXT) = $2
     ORDER BY p.updated_at DESC
     LIMIT 20`,
    [`%${q}%`, q]
  );
  return rows;
}

function clientSummary(p: any, index?: number) {
  const prefix = index === undefined ? '' : `${index}. `;
  return `${prefix}<b>${displayUsername(p)}</b>
🆔 <code>${p.telegram_user_id}</code>
🎯 ${ruGoal(p.goal)} · 📚 ${ruExperience(p.experience)} · 📍 ${ruLocation(p.location)}
🏋️ ${Number(p.training_sessions_total)} всего · ⏳ ${Number(p.training_sessions_remaining)} осталось
💳 ${formatMoney(Number(p.payment_amount))}`;
}

async function getProgramHistory(userId: number) {
  const { rows } = await pool.query(
    'SELECT id, version, status, correction_request, created_at FROM training_programs WHERE telegram_user_id = $1 ORDER BY version DESC LIMIT 10',
    [userId]
  );
  return rows;
}

bot.command('start', async (ctx) => {
  if (!(await claimAdmin(ctx))) return ctx.reply('Доступ закрыт.');
  await ctx.reply('Pavel Fitness Support Bot\n\nЛичный блокнот тренера. Клиенты → анкета → замеры → программа → оплата → история.', {
    reply_markup: await startKeyboard()
  });
});

bot.command('admin', async (ctx) => { await sendAdminPanel(ctx); });

bot.command('help', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply('Доступ закрыт.');
  await ctx.reply('/start — главное меню\n/admin — админ-панель\n/profile — профиль\n/program — программа\n/reset — анкета заново');
});

bot.command('profile', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.reply('Доступ закрыт.');
  const targetId = selectedClient.get(ctx.from.id);
  if (!targetId) return ctx.reply('Сначала выбери клиента в разделе «Клиенты».');
  const profile = await getProfile(targetId);
  if (!profile) return ctx.reply('У выбранного клиента пока нет анкеты.');
  const payment = await getPaymentInfo(targetId);
  await ctx.reply(
    `${identityBlock(profile)}

Профиль
Цель: ${ruGoal(profile.goal)}
Опыт: ${ruExperience(profile.experience)}
Место: ${ruLocation(profile.location)}
Тренировок в неделю: ${profile.workouts_per_week}
Длительность: ${profile.workout_duration} мин
Ограничения: ${profile.limitations || 'Нет'}

💳 Оплата
Оплачено: ${formatMoney(Number(payment.payment_amount))}
Всего тренировок: ${Number(payment.training_sessions_total)}
Осталось: ${Number(payment.training_sessions_remaining)}
Проведено: ${Math.max(0, Number(payment.training_sessions_total) - Number(payment.training_sessions_remaining))}

Обновлён: ${new Date(profile.updated_at).toLocaleString('ru-RU')}`,
    { reply_markup: new InlineKeyboard().text('🏋️ Составить/открыть программу', 'program:current') }
  );
});

bot.command('program', async (ctx) => { await sendCurrentProgram(ctx); });
bot.command('reset', startQuiz);

bot.callbackQuery('profile', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  await ctx.answerCallbackQuery();
  const targetId = selectedClient.get(ctx.from.id);
  if (!targetId) return ctx.reply('Сначала выбери клиента в разделе «Клиенты».');
  const profile = await getProfile(targetId);
  if (!profile) return ctx.reply('У выбранного клиента пока нет анкеты.');
  const payment = await getPaymentInfo(targetId);
  await ctx.reply(
    `👤 <b>Мой профиль</b>

🎯 Цель: <b>${ruGoal(profile.goal)}</b>
📚 Опыт: <b>${ruExperience(profile.experience)}</b>
📍 Место: <b>${ruLocation(profile.location)}</b>
📅 Тренировок: <b>${profile.workouts_per_week}/нед.</b>
⏱ Длительность: <b>${profile.workout_duration} мин</b>
⚠️ Ограничения: <b>${profile.limitations || 'Нет'}</b>

💳 <b>Оплата и тренировки</b>
Оплачено: <b>${formatMoney(Number(payment.payment_amount))}</b>
Всего: <b>${Number(payment.training_sessions_total)}</b>
Осталось: <b>${Number(payment.training_sessions_remaining)}</b>
Проведено: <b>${Math.max(0, Number(payment.training_sessions_total) - Number(payment.training_sessions_remaining))}</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('🏋️ Моя программа', 'program:current')
        .row()
        .text('💳 Оплата и тренировки', 'payment:open')
        .text('⬅️ Админ-панель', 'admin:open')
    }
  );
});

bot.callbackQuery('program:current', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  await ctx.answerCallbackQuery();
  await sendCurrentProgram(ctx);
});

bot.callbackQuery('admin:open', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  await ctx.answerCallbackQuery();
  await sendAdminPanel(ctx);
});

bot.callbackQuery('admin:stats', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  await ctx.answerCallbackQuery();
  const stats = await getAdminStats();
  await ctx.reply(`📊 Статистика\n\nАнкет: ${stats.total}\nПохудение: ${stats.loss}\nНабор массы: ${stats.mass}\nЗдоровье и форма: ${stats.health}\n\nПрограмм: ${stats.programs.total}\nПрофилей с программами: ${stats.programs.users}`);
});

bot.callbackQuery('admin:profiles', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  clientSearchSessions.set(ctx.from.id, {});
  await ctx.answerCallbackQuery();
  const profiles = await getRecentProfiles();
  const text = profiles.length
    ? profiles.map((p: any, i: number) => clientSummary(p, i + 1)).join('\n\n')
    : 'Клиентов пока нет.';
  await ctx.reply(`👥 <b>Клиенты</b>

🔎 Чтобы найти клиента, напиши его <b>username</b>, имя или внутренний ID.

Последние клиенты:

${text}`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('🔎 Новый поиск', 'admin:search').row().text('⬅️ Админ-панель', 'admin:open')
  });
});

bot.callbackQuery('admin:search', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  clientSearchSessions.set(ctx.from.id, { query: '' });
  await ctx.answerCallbackQuery();
  await ctx.reply('🔎 Введи username (например @ivan), имя или внутренний ID клиента.');
});

bot.callbackQuery(/^client:select:(\d+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const clientId = Number(ctx.match[1]);
  const profileId = -clientId;
  const profile = await getProfile(profileId);
  if (!profile) return ctx.answerCallbackQuery({ text: 'Клиент не найден.' });
  selectedClient.set(ctx.from.id, profileId);
  clientSearchSessions.delete(ctx.from.id);
  await ctx.answerCallbackQuery({ text: 'Клиент выбран.' });
  const payment = await getPaymentInfo(profileId);
  const current = await getCurrentProgram(profileId);
  await ctx.reply(`${identityBlock(profile)}

🎯 <b>${ruGoal(profile.goal)}</b>
📚 ${ruExperience(profile.experience)} · 📍 ${ruLocation(profile.location)}
📅 ${profile.workouts_per_week}/нед. · ⏱ ${profile.workout_duration} мин

💳 <b>Оплата</b>: ${formatMoney(Number(payment.payment_amount))}
🏋️ Всего: <b>${Number(payment.training_sessions_total)}</b>
⏳ Осталось: <b>${Number(payment.training_sessions_remaining)}</b>
${current ? '🏋️ Программа: <b>есть</b>' : '🏋️ Программа: <b>нет</b>'}`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text('🏋️ Программа', 'client:program')
      .row()
      .text('🔄 Коррекция', 'client:correct')
      .row()
      .text('💳 Оплата', 'client:payment')
      .text('➖ Провести', 'client:training')
      .row()
      .text('📝 Анкета', 'client:quiz')
      .row()
      .text('📐 Замеры', 'client:measurements')
      .row()
      .text('🗑 Удалить клиента', 'client:delete:confirm')
      .row()
      .text('⬅️ Клиенты', 'admin:profiles')
  });
});

bot.callbackQuery('admin:client:add', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  clientAddSessions.set(ctx.from.id, { step: 'username' });
  await ctx.answerCallbackQuery();
  await ctx.reply('➕ <b>Добавление клиента</b>\n\nВведи username клиента, например <code>@ivan_fit</code>.\n\nПосле добавления анкета заполняется отдельно для этого клиента.', { parse_mode: 'HTML' });
});

bot.callbackQuery('client:program', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const id = selectedClient.get(ctx.from.id);
  if (!id) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  await ctx.answerCallbackQuery();
  await sendCurrentProgram(ctx, id);
});

bot.callbackQuery('client:payment', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const targetId = selectedClient.get(ctx.from.id);
  if (!targetId) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  await ctx.answerCallbackQuery();
  return sendPaymentPanel(ctx, targetId);
});

bot.callbackQuery('client:training', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const id = selectedClient.get(ctx.from.id);
  if (!id) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  await ctx.answerCallbackQuery();
  await useTrainingForClient(ctx, id);
});

bot.callbackQuery('client:quiz', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const id = selectedClient.get(ctx.from.id);
  if (!id) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  quizTargets.set(ctx.from.id, id);
  await ctx.answerCallbackQuery();
  await startQuiz(ctx);
});

bot.callbackQuery('client:delete:confirm', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const id = selectedClient.get(ctx.from.id);
  if (!id) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  const profile = await getProfile(id);
  if (!profile) return ctx.answerCallbackQuery({ text: 'Клиент не найден.' });
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `⚠️ <b>Удаление клиента</b>\n\n${identityBlock(profile)}\n\nБудут удалены анкета, программа, оплата, история тренировок и замеры.\n\n<b>Действие необратимо.</b>`,
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard()
      .text('🗑 Да, удалить', 'client:delete')
      .text('↩️ Отмена', 'admin:profiles') }
  );
});

bot.callbackQuery('client:delete', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const id = selectedClient.get(ctx.from.id);
  if (!id) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  await ctx.answerCallbackQuery({ text: 'Удаление...' });
  const clientId = id < 0 ? -id : null;
  await pool.query('BEGIN');
  try {
    await pool.query('DELETE FROM trainer_profiles WHERE telegram_user_id = $1', [id]);
    if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('client delete error', error);
    return ctx.reply('Не удалось удалить клиента. Данные не изменены.');
  }
  selectedClient.delete(ctx.from.id);
  clientSearchSessions.delete(ctx.from.id);
  quizTargets.delete(ctx.from.id);
  paymentSessions.delete(ctx.from.id);
  measurementSessions.delete(ctx.from.id);
  correctionSessions.delete(ctx.from.id);
  await ctx.reply('🗑 <b>Клиент удалён.</b>', { parse_mode: 'HTML', reply_markup: new InlineKeyboard()
    .text('👥 Клиенты', 'admin:profiles')
    .row()
    .text('🛠 Админ-панель', 'admin:open') });
});

bot.callbackQuery('client:measurements', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const id = selectedClient.get(ctx.from.id);
  if (!id) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  await ctx.answerCallbackQuery();
  const profile = await getProfile(id);
  const { rows } = await pool.query(
    'SELECT weight_kg, chest_cm, waist_cm, hips_cm, arm_cm, thigh_cm, body_fat_pct, note, measured_at FROM measurements WHERE telegram_user_id=$1 ORDER BY measured_at DESC LIMIT 1',
    [id]
  );
  const m = rows[0];
  const text = m
    ? `${identityBlock(profile)}\n\n📐 <b>Последние замеры</b>\n\n⚖️ Вес: ${m.weight_kg ?? '—'} кг\n📏 Грудь: ${m.chest_cm ?? '—'} см\n📏 Талия: ${m.waist_cm ?? '—'} см\n📏 Бёдра: ${m.hips_cm ?? '—'} см\n💪 Рука: ${m.arm_cm ?? '—'} см\n🦵 Бедро: ${m.thigh_cm ?? '—'} см\n📊 % жира: ${m.body_fat_pct ?? '—'}\n📝 ${m.note || 'Без заметки'}\n\nДата: ${new Date(m.measured_at).toLocaleString('ru-RU')}`
    : `${identityBlock(profile)}\n\n📐 <b>Замеры</b>\n\nДля клиента пока нет сохранённых замеров.`;
  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text('➕ Добавить замеры', 'measurements:add')
      .row()
      .text('📜 История замеров', 'measurements:history')
      .row()
      .text('⬅️ Карточка клиента', 'admin:profiles')
  });
});

bot.callbackQuery('measurements:add', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const id = selectedClient.get(ctx.from.id);
  if (!id) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  measurementSessions.set(ctx.from.id, { step: 'data', targetId: id });
  await ctx.answerCallbackQuery();
  await ctx.reply(`📐 <b>Новые замеры</b>

Введи одной строкой через запятую:
<b>вес, грудь, талия, бёдра, рука, бедро, % жира</b>

Пример: <code>82.5, 104, 86, 100, 38, 58, 18</code>

Если сейчас замеры сделать нельзя — нажми «⏭ Пропустить».\nЕсли какой-то показатель не измерялся — поставь <code>-</code>.`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⏭ Пропустить', 'measurements:skip') });
});

bot.callbackQuery('measurements:skip', async (ctx) => { if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' }); measurementSessions.delete(ctx.from.id); await ctx.answerCallbackQuery({ text: 'Замеры пропущены.' }); await ctx.reply('⏭ Замеры пропущены. Их можно добавить позже в карточке клиента.', { reply_markup: new InlineKeyboard().text('📐 Замеры', 'client:measurements').row().text('⬅️ Карточка клиента', 'admin:profiles') }); });

bot.callbackQuery('measurements:history', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const id = selectedClient.get(ctx.from.id);
  if (!id) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  await ctx.answerCallbackQuery();
  const { rows } = await pool.query(
    'SELECT weight_kg, chest_cm, waist_cm, hips_cm, arm_cm, thigh_cm, body_fat_pct, note, measured_at FROM measurements WHERE telegram_user_id=$1 ORDER BY measured_at DESC LIMIT 12', [id]
  );
  if (!rows.length) return ctx.reply('📐 История замеров пока пуста.');
  const text = rows.map((m:any, i:number) =>
    `${i + 1}. <b>${new Date(m.measured_at).toLocaleDateString('ru-RU')}</b> — ⚖️ ${m.weight_kg ?? '—'} кг · грудь ${m.chest_cm ?? '—'} · талия ${m.waist_cm ?? '—'} · бёдра ${m.hips_cm ?? '—'} · рука ${m.arm_cm ?? '—'} · бедро ${m.thigh_cm ?? '—'}${m.body_fat_pct != null ? ` · жир ${m.body_fat_pct}%` : ''}`
  ).join('\n\n');
  await ctx.reply(`📜 <b>История замеров</b>\n\n${text}`, { parse_mode: 'HTML' });
});

bot.callbackQuery('client:correct', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const id = selectedClient.get(ctx.from.id);
  if (!id) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  const current = await getCurrentProgram(id);
  if (!current) return ctx.answerCallbackQuery({ text: 'У клиента ещё нет программы.' });
  correctionSessions.set(ctx.from.id, { programId: Number(current.id) });
  await ctx.answerCallbackQuery();
  await ctx.reply('🔄 Что изменить в программе выбранного клиента? Напиши одним сообщением.');
});

bot.callbackQuery('payment:open', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const targetId = selectedClient.get(ctx.from.id);
  if (!targetId) {
    await ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
    return ctx.reply('👥 Сначала выбери клиента в разделе «Клиенты».', {
      reply_markup: new InlineKeyboard().text('👥 Выбрать клиента', 'admin:profiles')
    });
  }
  await ctx.answerCallbackQuery();
  return sendPaymentPanel(ctx, targetId);
});

bot.callbackQuery('payment:edit', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const targetId = selectedClient.get(ctx.from.id);
  if (!targetId) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  paymentSessions.set(ctx.from.id, { step: 'amount', targetId });
  await ctx.answerCallbackQuery();
  await ctx.reply('💳 Введи сумму оплаты в рублях. Например: 15000');
});

bot.callbackQuery('payment:history', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  await ctx.answerCallbackQuery();
  const userId = selectedClient.get(ctx.from.id);
  if (!userId) return ctx.reply('Сначала выбери клиента.');
  const profile = await getProfile(userId);
  const { rows } = await pool.query(
    'SELECT type, amount, sessions, remaining, note, created_at FROM payment_history WHERE telegram_user_id = $1 ORDER BY created_at DESC LIMIT 20',
    [userId]
  );
  if (!rows.length) return ctx.reply('📜 История оплат пока пуста.');
  const text = rows.map((r: any, i: number) => {
    const label = r.type === 'payment' ? '💳 Оплата' : '🏋️ Тренировка';
    const details = r.type === 'payment'
      ? `${formatMoney(Number(r.amount))} · пакет ${Number(r.sessions)} трен.`
      : '1 тренировка';
    return `${i + 1}. ${label}\n${new Date(r.created_at).toLocaleString('ru-RU')}\n${details}\nОсталось: ${Number(r.remaining)}`;
  }).join('\n\n');
  await ctx.reply(`📜 <b>История оплат и тренировок</b>\n\n${text}`, { parse_mode: 'HTML' });
});

async function useTrainingForClient(ctx: any, userId: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT training_sessions_remaining FROM trainer_profiles WHERE telegram_user_id = $1 FOR UPDATE',
      [userId]
    );
    const remainingBefore = Number(rows[0]?.training_sessions_remaining ?? 0);
    if (remainingBefore <= 0) {
      await client.query('ROLLBACK');
      return ctx.reply('⏳ У выбранного клиента нет доступных тренировок.');
    }
    const remaining = remainingBefore - 1;
    await client.query(
      'UPDATE trainer_profiles SET training_sessions_remaining = $2, updated_at = NOW() WHERE telegram_user_id = $1',
      [userId, remaining]
    );
    await client.query(
      'INSERT INTO payment_history (telegram_user_id, type, sessions, remaining, note) VALUES ($1,\'training\',1,$2,\'Проведена тренировка\')',
      [userId, remaining]
    );
    await client.query('COMMIT');
    const profile = await getProfile(userId);
    return ctx.reply(`${identityBlock(profile)}\n\n✅ Тренировка проведена.\n⏳ Осталось: <b>${remaining}</b>`, { parse_mode: 'HTML' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('client training usage error', error);
    return ctx.reply('Не удалось списать тренировку.');
  } finally {
    client.release();
  }
}

bot.callbackQuery('payment:use', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const targetId = selectedClient.get(ctx.from.id);
  if (!targetId) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  await ctx.answerCallbackQuery();
  await useTrainingForClient(ctx, targetId);
});

bot.callbackQuery('quiz:start', async (ctx) => {
  if (!ctx.from) return;
  await ctx.answerCallbackQuery();
  await startQuiz(ctx);
});

bot.callbackQuery(/^goal:(.+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const value = ctx.match[1];
  sessions.set(ctx.from.id, { step: 'experience', goal: value });
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Шаг 2/6. Опыт тренировок?', {
    reply_markup: new InlineKeyboard().text('Новичок', 'exp:beginner').text('До 1 года', 'exp:under1').row().text('1–3 года', 'exp:1to3').text('3+ года', 'exp:3plus')
  });
});

bot.callbackQuery(/^exp:(.+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const session = sessions.get(ctx.from.id);
  if (!session) return startQuiz(ctx);
  session.experience = ctx.match[1];
  session.step = 'location';
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Шаг 3/6. Где будут проходить тренировки?', {
    reply_markup: new InlineKeyboard().text('Зал', 'loc:gym').text('Дом', 'loc:home').row().text('Улица', 'loc:outdoor').text('Смешанный формат', 'loc:mixed')
  });
});

bot.callbackQuery(/^loc:(.+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const session = sessions.get(ctx.from.id);
  if (!session) return startQuiz(ctx);
  session.location = ctx.match[1];
  session.step = 'workouts';
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Шаг 4/6. Сколько тренировок в неделю?', {
    reply_markup: new InlineKeyboard().text('1', 'wk:1').text('2', 'wk:2').text('3', 'wk:3').row().text('4', 'wk:4').text('5+', 'wk:5')
  });
});

bot.callbackQuery(/^wk:(\d+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const session = sessions.get(ctx.from.id);
  if (!session) return startQuiz(ctx);
  session.workoutsPerWeek = Number(ctx.match[1]);
  session.step = 'duration';
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Шаг 5/6. Сколько минут на одну тренировку?', {
    reply_markup: new InlineKeyboard().text('30', 'dur:30').text('45', 'dur:45').text('60', 'dur:60').row().text('75', 'dur:75').text('90', 'dur:90')
  });
});

bot.callbackQuery(/^dur:(\d+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const session = sessions.get(ctx.from.id);
  if (!session) return startQuiz(ctx);
  session.workoutDuration = Number(ctx.match[1]);
  session.step = 'limitations';
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Шаг 6/6. Есть ограничения или особенности? Напиши их одним сообщением. Если нет — напиши «нет».');
});

bot.on('message:text', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return;
  const addSession = clientAddSessions.get(ctx.from.id);
  if (addSession) {
    const raw = ctx.message.text.trim();
    if (addSession.step === 'username') {
      const username = raw.replace(/^@/, '').trim().toLowerCase();
      if (!/^[a-z0-9_]{5,32}$/.test(username)) return ctx.reply('Введи корректный Telegram username, например @ivan_fit.');
      const existing = await pool.query('SELECT id FROM clients WHERE LOWER(telegram_username)=$1', [username]);
      if (existing.rows[0]) return ctx.reply('Такой клиент уже есть в базе. Открой «Клиенты» и выбери его.');
      addSession.username = username;
      addSession.step = 'name';
      return ctx.reply('👤 Теперь введи имя клиента. Например: Иван');
    }
    if (addSession.step === 'name') {
      addSession.firstName = raw || 'Клиент';
      const name = addSession.firstName;
      const clientRow = await pool.query(
        'INSERT INTO clients (telegram_username, first_name) VALUES ($1,$2) RETURNING id',
        [addSession.username, name]
      );
      const clientId = Number(clientRow.rows[0].id);
      const internalId = -clientId;
    await pool.query(
      "INSERT INTO trainer_profiles (telegram_user_id, telegram_username, first_name, goal, experience, location, workouts_per_week, workout_duration, limitations) VALUES ($1,$2,$3,'health','beginner','gym',1,60,'')",
      [internalId, addSession.username, name]
    );
    clientAddSessions.delete(ctx.from.id);
    clientSearchSessions.delete(ctx.from.id);
    selectedClient.set(ctx.from.id, internalId);
    return ctx.reply(`✅ <b>Клиент добавлен</b>

👤 ${name}
🔗 @${addSession.username}

Теперь клиент выбран. <b>Анкету заполняешь ты</b> — клиенту ничего делать не нужно.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('📝 Заполнить анкету', 'client:quiz')
        .row()
        .text('📐 Замеры', 'client:measurements')
        .row()
        .text('💳 Оплата', 'client:payment')
        .row()
        .text('🏋️ Программа', 'client:program')
        .row()
        .text('⬅️ Клиенты', 'admin:profiles')
    });
    }
  }
  const searchSession = clientSearchSessions.get(ctx.from.id);
  if (searchSession) {
    const query = ctx.message.text.trim();
    clientSearchSessions.delete(ctx.from.id);
    const profiles = await searchClients(query);
    if (!profiles.length) {
      return ctx.reply(`🔎 По запросу «${query}» ничего не найдено.`, {
        reply_markup: new InlineKeyboard().text('🔎 Попробовать снова', 'admin:search').row().text('⬅️ Админ-панель', 'admin:open')
      });
    }
    const text = profiles.map((p: any, i: number) => clientSummary(p, i + 1)).join('\n\n');
    const keyboard = new InlineKeyboard();
    profiles.slice(0, 20).forEach((p: any, i: number) => {
      keyboard.text(`${i + 1}. ${(p.telegram_username ? '@' + p.telegram_username : p.first_name || 'Клиент').slice(0, 28)}`, `client:select:${p.client_id}`).row();
    });
    keyboard.text('🔎 Новый поиск', 'admin:search').row().text('⬅️ Клиенты', 'admin:profiles');
    return ctx.reply(`🔎 <b>Результаты поиска</b>

${text}

Нажми на нужного клиента — все дальнейшие действия будут выполняться для него.`, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  const measurement = measurementSessions.get(ctx.from.id);
  if (measurement) {
    const parts = ctx.message.text.split(',').map((v) => v.trim());
    if (parts.length < 7) return ctx.reply('Нужно 7 значений через запятую: вес, грудь, талия, бёдра, рука, бедро, % жира.');
    const nums = parts.slice(0, 7).map((v) => v === '-' || v === '' ? null : Number(v.replace(',', '.')));
    if (nums.some((v) => v !== null && (!Number.isFinite(v) || v < 0))) return ctx.reply('Проверь значения замеров. Используй числа или «-».');
    const [weight, chest, waist, hips, arm, thigh, bodyFat] = nums;
    await pool.query(
      'INSERT INTO measurements (telegram_user_id, weight_kg, chest_cm, waist_cm, hips_cm, arm_cm, thigh_cm, body_fat_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [measurement.targetId, weight, chest, waist, hips, arm, thigh, bodyFat]
    );
    measurementSessions.delete(ctx.from.id);
    await ctx.reply('✅ Замеры сохранены для выбранного клиента.', {
      reply_markup: new InlineKeyboard().text('📐 Открыть замеры', 'client:measurements').row().text('⬅️ Карточка клиента', 'admin:profiles')
    });
    return;
  }

  const payment = paymentSessions.get(ctx.from.id);
  if (payment) {
    const rawText = ctx.message.text.trim();
    const value = Number(rawText.replace(',', '.'));
    if (payment.step === 'amount') {
      payment.amount = value;
      payment.step = 'total';
      return ctx.reply('🏋️ Сколько тренировок оплачено? Например: 12');
    }
    if (payment.step === 'total') {
      if (!Number.isInteger(value)) return ctx.reply('Количество тренировок должно быть целым числом.');
      payment.total = value;
      payment.step = 'remaining';
      return ctx.reply('⏳ Сколько тренировок осталось? Например: 10');
    }
    if (!Number.isInteger(value) || value > (payment.total ?? 0)) return ctx.reply('Остаток должен быть целым числом и не больше общего количества тренировок.');
    const amount = payment.amount ?? 0;
    const total = payment.total ?? 0;
    const targetId = payment.targetId ?? selectedClient.get(ctx.from.id) ?? ctx.from.id;
    await updatePaymentInfo(targetId, amount, total, value);
    await pool.query(
      'INSERT INTO payment_history (telegram_user_id, type, amount, sessions, remaining, note) VALUES ($1,\'payment\',$2,$3,$4,\'Изменение оплаты и пакета тренировок\')',
      [targetId, amount, total, value]
    );
    paymentSessions.delete(ctx.from.id);
    await ctx.reply('✅ Данные по оплате и тренировкам сохранены.');
    return sendPaymentPanel(ctx, targetId);
  }

  const correction = correctionSessions.get(ctx.from.id);
  if (correction) {
    const request = ctx.message.text.trim();
    correctionSessions.delete(ctx.from.id);

    let scopedRequest = request;
    if (correction.day && correction.exerciseIndex !== undefined) {
      const { rows } = await pool.query('SELECT program FROM training_programs WHERE id=$1', [correction.programId]);
      const program = rows[0]?.program as Program | undefined;
      const exercise = program?.days.find((d) => d.day === correction.day)?.exercises[correction.exerciseIndex];
      if (exercise) {
        scopedRequest = `Точечная коррекция. День ${correction.day}. Группа мышц: ${exerciseMuscleGroup(exercise.name)}. Упражнение: «${exercise.name}». Требование тренера: ${request}`;
      }
    } else if (correction.muscleGroup) {
      scopedRequest = `Корректировать только группу мышц «${correction.muscleGroup}». Требование тренера: ${request}`;
    }

    const targetId = selectedClient.get(ctx.from.id) ?? ctx.from.id;
    const created = await createProgram(targetId, scopedRequest);
    if (!created) return ctx.reply('Сначала заполните профиль.');
    await ctx.reply(`Готово. Создана версия ${created.version} с учётом коррекции:\n«${escapeHtml(request)}»`, { parse_mode: 'HTML' });
    return sendProgramMedia(ctx, created.program, programKeyboard(created.id));
  }

  const session = sessions.get(ctx.from.id);
  if (!session || session.step !== 'limitations') return;
  const limitations = ctx.message.text.trim();
  try {
    const targetId = quizTargets.get(ctx.from.id) ?? ctx.from.id;
    clientSearchSessions.delete(ctx.from.id);
    const existingTarget = await getProfile(targetId);
    await saveProfile({
      id: targetId,
      username: existingTarget?.telegram_username ?? (targetId === ctx.from.id ? ctx.from.username : undefined),
      firstName: existingTarget?.first_name ?? (targetId === ctx.from.id ? ctx.from.first_name : undefined)
    }, { ...session, limitations });
    sessions.delete(ctx.from.id);
    quizTargets.delete(ctx.from.id);
    const created = await createProgram(targetId);
    if (!created) return ctx.reply('Профиль сохранён, но программу создать не удалось.');
    await ctx.reply('Профиль сохранён ✅\n\nПрограмма составлена автоматически. Ниже — первая версия.');
    const targetProfile = await getProfile(targetId);
    await sendProgramMedia(ctx, created.program, programKeyboard(created.id));
  } catch (error) {
    console.error('save profile/program error', error);
    const message = String((error as any)?.message ?? '');
    if (/can't parse entities|Bad Request/i.test(message)) {
      await ctx.reply('⚠️ Программа сохранена, но Telegram не принял формат сообщения. Исправление уже внесено — повтори создание программы.');
    } else {
      await ctx.reply('Не удалось сохранить профиль или программу. Проверь подключение базы данных.');
    }
  }
});

bot.callbackQuery(/^program:correct:(\d+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const programId = Number(ctx.match[1]); correctionSessions.set(ctx.from.id,{programId});
  await ctx.answerCallbackQuery(); await showCorrectionDays(ctx,programId);
});

bot.callbackQuery(/^program:correct:days:(\d+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const programId=Number(ctx.match[1]); correctionSessions.set(ctx.from.id,{programId});
  await ctx.answerCallbackQuery(); await showCorrectionDays(ctx,programId);
});

bot.callbackQuery(/^program:correct:day:(\d+):(\d+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const programId=Number(ctx.match[1]), day=Number(ctx.match[2]);
  correctionSessions.set(ctx.from.id,{programId,day}); await ctx.answerCallbackQuery();
  await showCorrectionGroups(ctx,programId,day);
});
bot.callbackQuery(/^program:correct:back:(\d+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const programId = Number(ctx.match[1]);
  const { rows } = await pool.query('SELECT program FROM training_programs WHERE id=$1', [programId]);
  correctionSessions.delete(ctx.from.id);
  if (!rows[0]) return ctx.answerCallbackQuery({ text: 'Программа не найдена.' });
  await ctx.answerCallbackQuery();
  return sendProgramMedia(ctx, rows[0].program as Program, programKeyboard(programId));
});


function correctionGroupSlug(group: string) {
  return ({'Грудь':'ch','Спина':'back','Плечи':'sh','Руки':'arms','Ноги':'legs','Кор':'core'} as Record<string,string>)[group] ?? 'other';
}

function correctionGroupFromSlug(slug: string) {
  return ({ch:'Грудь',back:'Спина',sh:'Плечи',arms:'Руки',legs:'Ноги',core:'Кор'} as Record<string,string>)[slug] ?? '';
}

bot.callbackQuery(/^program:correct:group:(\d+):(\d+):([^:]+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const programId = Number(ctx.match[1]);
  const day = Number(ctx.match[2]);
  const group = correctionGroupFromSlug(ctx.match[3]);
  if (!group) return ctx.answerCallbackQuery({ text: 'Группа не найдена.' });
  correctionSessions.set(ctx.from.id,{programId,day,muscleGroup:group});
  await ctx.answerCallbackQuery();
  await showCorrectionExercises(ctx,programId,day,group);
});

bot.callbackQuery(/^program:correct:pick:(\d+):(\d+):(\d+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const programId = Number(ctx.match[1]);
  const dayNumber = Number(ctx.match[2]);
  const index = Number(ctx.match[3]);
  const session = correctionSessions.get(ctx.from.id);
  if (!session || session.programId !== programId || session.day !== dayNumber || !session.catalogChoices?.[index]) {
    return ctx.answerCallbackQuery({ text: 'Список упражнений устарел. Открой коррекцию заново.' });
  }

  const exerciseId = session.catalogChoices[index];
  const group = session.muscleGroup ?? '';
  const clientId = selectedClient.get(ctx.from.id) ?? ctx.from.id;
  const programRow = await pool.query('SELECT program FROM training_programs WHERE id=$1', [programId]);
  const current = programRow.rows[0]?.program as Program | undefined;
  if (!current) return ctx.answerCallbackQuery({ text: 'Программа не найдена.' });

  const exRow = await pool.query(
    `SELECT id, name, COALESCE(name_ru,'') AS name_ru, gif_url
     FROM exercise_library WHERE id=$1 AND id LIKE 'anat-%'`,
    [exerciseId]
  );
  const selectedExercise = exRow.rows[0];
  if (!selectedExercise) return ctx.answerCallbackQuery({ text: 'Упражнение не найдено.' });

  const replacement: Exercise = {
    name: String(selectedExercise.name_ru || ruExerciseName(selectedExercise.name)),
    gifUrl: String(selectedExercise.gif_url || ''),
    sets: 3,
    reps: current.goal === 'Набор массы' ? '8–12' : '10–15',
    rest: '60–90 сек',
    progression: 'Постепенно увеличивать нагрузку или повторения при сохранении техники.',
    recommendation: 'Контролировать технику и амплитуду; не работать через боль.'
  };

  const nextProgram: Program = {
    ...current,
    days: current.days.map((d) => ({
      ...d,
      exercises: d.exercises.map((e) => ({ ...e }))
    }))
  };
  const nextDay = nextProgram.days.find((d) => d.day === dayNumber);
  if (!nextDay) return ctx.answerCallbackQuery({ text: 'День не найден.' });

  const targetIndex = session.exerciseIndex ?? nextDay.exercises.findIndex((exercise) => exerciseMuscleGroup(exercise.name, nextDay.focus) === group);
  if (targetIndex >= 0) nextDay.exercises[targetIndex] = replacement;
  else nextDay.exercises.push(replacement);
  nextProgram.notes = [...(nextProgram.notes ?? []), `Коррекция: ${group} — ${replacement.name}.`];

  const { rows: versionRows } = await pool.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM training_programs WHERE telegram_user_id = $1',
    [clientId]
  );
  const version = Number(versionRows[0].next_version);
  nextProgram.version = version;

  const saved = await pool.query(
    `INSERT INTO training_programs (telegram_user_id, version, status, program, correction_request)
     VALUES ($1,$2,'draft',$3::jsonb,$4) RETURNING id, version`,
    [clientId, version, JSON.stringify(nextProgram), `День ${dayNumber}, ${group}: ${replacement.name}`]
  );

  correctionSessions.delete(ctx.from.id);
  await ctx.answerCallbackQuery({ text: 'Упражнение заменено.' });
  await ctx.reply(`✅ День ${dayNumber}: «${escapeHtml(replacement.name)}» установлено вместо выбранного упражнения группы «${escapeHtml(group)}».`, {parse_mode:'HTML'});
  return sendProgramMedia(ctx, nextProgram, programKeyboard(Number(saved.rows[0].id)));
});

bot.callbackQuery(/^program:approve:(\d+)$/, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const id = Number(ctx.match[1]);
  await pool.query('BEGIN');
  try {
    const { rows } = await pool.query('SELECT telegram_user_id FROM training_programs WHERE id=$1', [id]);
    if (!rows[0]) throw new Error('Program not found');
    await pool.query(
      `UPDATE training_programs SET status='archived' WHERE telegram_user_id=$1 AND status='approved' AND id<>$2`,
      [rows[0].telegram_user_id, id]
    );
    await pool.query(`UPDATE training_programs SET status='approved' WHERE id=$1 AND status='draft'`, [id]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
  await ctx.answerCallbackQuery({ text: 'Программа подтверждена.' });
  await ctx.reply('✅ Текущая версия программы подтверждена.');
});

bot.callbackQuery('program:history', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  await ctx.answerCallbackQuery();
  const rows = await getProgramHistory(selectedClient.get(ctx.from.id) ?? ctx.from.id);
  if (!rows.length) return ctx.reply('История программ пока пуста.');
  await ctx.reply('📚 История программ\n\n' + rows.map((r: any) =>
    `Версия ${r.version} — ${r.status === 'approved' ? 'подтверждена' : r.status === 'archived' ? 'архив' : 'черновик'}\nСоздана: ${new Date(r.created_at).toLocaleString('ru-RU')}${r.correction_request ? `\nКоррекция: ${r.correction_request}` : ''}`
  ).join('\n\n'));
});

// Always acknowledge callback queries that are not matched by a handler.
// This prevents Telegram's loading indicator from hanging on stale/invalid buttons.
bot.on('callback_query:data', async (ctx) => {
  console.warn('Unhandled callback query:', ctx.callbackQuery.data);
  await ctx.answerCallbackQuery({ text: 'Кнопка устарела. Открой раздел заново.' });
});

bot.catch((error) => console.error('Telegram bot error', error.error));

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'pavel-fitness-support' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

async function main() {
  await pool.query('SELECT 1');
  await ensureDatabase();
  await seedExerciseLibrary();
  await syncExerciseCatalog(pool);
  await syncAnatomyExerciseCatalog(pool);
  console.log('Using anatomy catalog version:', ANATOMY_CATALOG_VERSION);
  const integrity = await pool.query(`SELECT
    (SELECT COUNT(*) FROM trainer_profiles) AS profiles,
    (SELECT COUNT(*) FROM training_programs) AS programs,
    (SELECT COUNT(*) FROM exercise_library) AS exercises
  `);
  console.log('Database integrity:', integrity.rows[0]);
  server.listen(PORT, () => console.log(`Health server listening on :${PORT}`));
  // Render can briefly run the old and new process during a zero-downtime deploy.
  // Telegram allows only one getUpdates consumer, so serialize polling across instances
  // with a PostgreSQL session advisory lock. The lock is released automatically if the
  // process/connection disappears, allowing the replacement instance to take over.
  telegramPollLock = await pool.connect();
  while (true) {
    const { rows } = await telegramPollLock.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [TELEGRAM_POLL_LOCK_KEY]
    );
    if (rows[0]?.locked) break;
    console.log('Another bot instance owns the Telegram polling lock; waiting...');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  await bot.api.deleteWebhook({ drop_pending_updates: false });
  console.log('Starting Telegram long polling...');
  await bot.start({ onStart: (info) => console.log(`Bot @${info.username} started`) });
}

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down Telegram polling cleanly...`);
  try { await bot.stop(); } catch (error) { console.error('Bot stop error', error); }
  try { server.close(); } catch (error) { console.error('Health server close error', error); }
  if (telegramPollLock) {
    try { await telegramPollLock.query('SELECT pg_advisory_unlock($1)', [TELEGRAM_POLL_LOCK_KEY]); } catch (error) { console.error('Poll lock release error', error); }
    telegramPollLock.release();
    telegramPollLock = null;
  }
  await pool.end();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

main().catch((error) => {
  console.error('Fatal startup error', error);
  process.exit(1);
});