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
    ? `equipment <> 'body weight'`
    : profile.location === 'home'
      ? `equipment = 'body weight'`
      : profile.location === 'outdoor'
        ? `equipment = 'body weight'`
        : `TRUE`;

  const { rows } = await pool.query(
    `SELECT id, name, COALESCE(name_ru,'') AS name_ru, category, COALESCE(body_part_ru,'') AS body_part_ru,
            equipment, COALESCE(equipment_ru,'') AS equipment_ru, target, muscle_group,
            COALESCE(muscle_group_ru,'') AS muscle_group_ru, secondary_muscles, instructions_ru,
            source_url, gif_url, image_url, training_types, movement_pattern, level, training_contexts
     FROM exercise_library
     WHERE ${equipmentFilter}
       AND id LIKE 'base-%'
       AND catalog_version = $1
       AND category IN ('upper legs','chest','back','shoulders','waist','lower legs','upper arms','lower arms')
     ORDER BY id
     LIMIT 200`,
    [ANATOMY_CATALOG_VERSION]
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

  // The full catalog is returned when fullCatalog=true; the program builder applies the day-specific filters.
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
  const upper = reps.match(/(\d+)\\s*[–-]\\s*(\d+)/);
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
  const normalize = (v: unknown) => normalizeText(String(v ?? ''));
  const uniqueByName = (rows: LibraryExercise[]) => {
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = normalize(row.nameRu || row.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // The full catalog is the source. The day structure is the constraint.
  // AI is not allowed to move an exercise into a different muscle group/day.
  const candidates = uniqueByName(library)
    .filter((row) => !beginner || row.level !== 'advanced')
    .filter((row) => isExerciseAllowed(row, normalizedProfile.limitations ?? ''));

  const used = new Set<string>();
  const usedNames = new Set<string>();

  const resetDaySelection = () => {
    used.clear();
    usedNames.clear();
  };

  const take = (
    count: number,
    filter: (row: LibraryExercise) => boolean,
    preferred?: (row: LibraryExercise) => number
  ) => {
    const pool = candidates
      .filter((row) => !used.has(row.id) && !usedNames.has(normalize(row.nameRu || row.name)))
      .filter(filter)
      .sort((a, b) => (preferred ? preferred(b) - preferred(a) : 0));

    const result: LibraryExercise[] = [];
    for (const row of pool) {
      result.push(row);
      used.add(row.id);
      usedNames.add(normalize(row.nameRu || row.name));
      if (result.length >= count) break;
    }
    return result;
  };

  const priority = (row: LibraryExercise) => {
    let score = 0;
    const text = normalize(row.nameRu || row.name);
    const movement = normalize(row.movementPattern);
    if (/присед|жим|тяга|подтяг|отжим|румын|hip thrust|ягодичный мост|выпад|squat|press|row|pull|deadlift/.test(text)) score += 20;
    if (/присед|жим|тяга|сгибание|разгибание|анти|ротац|стабилиз|squat|press|pull|push|hinge|carry/.test(movement)) score += 8;
    if (row.gifUrl) score += 3;
    if (row.level === 'beginner') score += beginner ? 8 : 2;
    if (normalizedProfile.goal === 'mass' && row.trainingTypes.includes('hypertrophy')) score += 8;
    if (normalizedProfile.goal === 'loss' && row.trainingTypes.includes('endurance')) score += 5;
    return score;
  };

  const targetText = (row: LibraryExercise) =>
    normalize(`${row.target} ${row.muscleGroupRu} ${row.muscleGroup} ${row.bodyPartRu} ${row.nameRu} ${row.name}`);

  const byGroup = (group: string) => (row: LibraryExercise) =>
    normalize(row.muscleGroupRu) === normalize(group) || normalize(row.bodyPartRu) === normalize(group);

  const byTarget = (group: string, target: RegExp) => (row: LibraryExercise) =>
    (normalize(row.muscleGroupRu) === normalize(group) || normalize(row.bodyPartRu) === normalize(group)) &&
    target.test(targetText(row));

  const toExercise = (row: LibraryExercise, index: number): Exercise => exercisePrescription(row, normalizedProfile, index);

  const makeDay = (day: number, title: string, focus: string, rows: LibraryExercise[]) => ({
    day,
    title,
    focus,
    warmup: duration <= 45
      ? '5–7 минут: общая активизация + динамическая разминка движений дня.'
      : '8–10 минут: общая активизация + динамическая разминка движений дня.',
    exercises: rows.map((row, i) => toExercise(row, i)),
    cooldown: '5–7 минут: спокойное восстановление и лёгкая мобильность.'
  });

  const days: WorkoutDay[] = [];

  if (frequency <= 2) {
    const patterns = [
      ['Грудь','Спина','Ноги','Плечи','Руки','Кор'],
      ['Ноги','Спина','Грудь','Плечи','Руки','Кор']
    ];
    for (let d = 0; d < frequency; d++) {
      resetDaySelection();
      const rows: LibraryExercise[] = [];
      for (const group of patterns[d]) rows.push(...take(1, byGroup(group), priority));
      days.push(makeDay(
        d + 1,
        `День ${d + 1} — Full Body${frequency === 2 ? (d === 0 ? ' A' : ' B') : ''}`,
        'Full Body',
        rows.slice(0, duration <= 45 ? 6 : 7)
      ));
    }
  } else if (frequency === 3) {
    // 3 days: Chest + Arms / Back + Shoulders / Legs.
    resetDaySelection();
    const day1 = [
      ...take(2, byGroup('Грудь'), priority),
      ...take(1, byTarget('Руки', /бицепс|biceps/), priority),
      ...take(1, byTarget('Руки', /трицепс|triceps/), priority)
    ];
    days.push(makeDay(1, 'День 1 — Грудь + руки', 'Грудь + руки', day1));

    resetDaySelection();
    const day2 = [
      ...take(3, byGroup('Спина'), priority),
      ...take(2, byGroup('Плечи'), priority)
    ];
    days.push(makeDay(2, 'День 2 — Спина + плечи', 'Спина + плечи', day2.slice(0, 5)));

    resetDaySelection();
    const day3 = [
      ...take(2, byTarget('Ноги', /квадрицепс|quadriceps|quad/), priority),
      ...take(1, byTarget('Ноги', /ягодич|glute/), priority),
      ...take(1, byTarget('Ноги', /задняя поверхность бедра|hamstring/), priority),
      ...take(1, byGroup('Голень'), priority),
      ...take(1, byGroup('Кор'), priority)
    ];
    days.push(makeDay(3, 'День 3 — Ноги', 'Ноги', day3.slice(0, 6)));
  } else if (frequency === 4) {
    // 4 days: Chest / Back / Legs / Arms + Shoulders.
    resetDaySelection();
    const chest = [
      ...take(3, byGroup('Грудь'), priority),
      ...take(3, byGroup('Грудь'), priority)
    ];
    days.push(makeDay(1, 'День 1 — Грудь', 'Грудь', chest.slice(0, 6)));

    resetDaySelection();
    const back = take(6, byGroup('Спина'), priority);
    days.push(makeDay(2, 'День 2 — Спина', 'Спина', back.slice(0, 6)));

    resetDaySelection();
    const legs = [
      ...take(2, byTarget('Ноги', /квадрицепс|quadriceps|quad/), priority),
      ...take(1, byTarget('Ноги', /ягодич|glute/), priority),
      ...take(1, byTarget('Ноги', /задняя поверхность бедра|hamstring/), priority),
      ...take(1, byGroup('Голень'), priority),
      ...take(1, byGroup('Кор'), priority)
    ];
    days.push(makeDay(3, 'День 3 — Ноги', 'Ноги', legs.slice(0, 6)));

    resetDaySelection();
    const armsShoulders = [
      ...take(2, byTarget('Руки', /бицепс|biceps/), priority),
      ...take(2, byTarget('Руки', /трицепс|triceps/), priority),
      ...take(1, byGroup('Плечи'), priority),
      ...take(1, byGroup('Плечи'), priority)
    ];
    days.push(makeDay(4, 'День 4 — Руки + плечи', 'Руки + плечи', armsShoulders.slice(0, 6)));
  } else {
    // 5 days: Chest / Back / Legs / Arms / Shoulders.
    resetDaySelection();
    days.push(makeDay(1, 'День 1 — Грудь', 'Грудь', take(6, byGroup('Грудь'), priority).slice(0, 6)));

    resetDaySelection();
    days.push(makeDay(2, 'День 2 — Спина', 'Спина', take(6, byGroup('Спина'), priority).slice(0, 6)));

    resetDaySelection();
    const legs = [
      ...take(2, byTarget('Ноги', /квадрицепс|quadriceps|quad/), priority),
      ...take(1, byTarget('Ноги', /ягодич|glute/), priority),
      ...take(1, byTarget('Ноги', /задняя поверхность бедра|hamstring/), priority),
      ...take(1, byGroup('Голень'), priority),
      ...take(1, byGroup('Кор'), priority)
    ];
    days.push(makeDay(3, 'День 3 — Ноги', 'Ноги', legs.slice(0, 6)));

    resetDaySelection();
    days.push(makeDay(4, 'День 4 — Руки', 'Руки', [
      ...take(3, byTarget('Руки', /бицепс|biceps/), priority),
      ...take(3, byTarget('Руки', /трицепс|triceps/), priority)
    ].slice(0, 6)));

    resetDaySelection();
    days.push(makeDay(5, 'День 5 — Плечи', 'Плечи', take(6, byGroup('Плечи'), priority).slice(0, 6)));
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
      'Источник упражнений: полный каталог exercise_library; подбор ограничен структурой дня, мышечной группой, локацией и доступным оборудованием.',
      `Формат: ${format}. Логика сплита: 1–2 дня — Full Body; 3 дня — грудь + руки / спина + плечи / ноги; 4 дня — грудь / спина / ноги / руки + плечи; 5 дней — грудь / спина / ноги / руки / плечи.`,
      'Разминка и заминка отделены от основной тренировки.',
      'Повторение одного упражнения между разными днями допускается, если оно логично; внутри одного дня дублей нет.',
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