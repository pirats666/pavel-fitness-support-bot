import 'dotenv/config';
import { createServer } from 'node:http';
import { Bot, InlineKeyboard } from 'grammy';
import pg from 'pg';
import { syncExerciseCatalog } from './exercise-catalog.js';
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
  name: string;
  sets: number;
  reps: string;
  rest: string;
  comment?: string;
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
const correctionSessions = new Map<number, { programId: number }>();
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
    [/barbell.*bench press|bench press|chest press/, 'Жим лёжа'],
    [/incline.*bench press|incline.*press/, 'Жим лёжа на наклонной скамье'],
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
  return 'Упражнение на ' + (n.includes('chest') ? 'грудь' : n.includes('back') ? 'спину' : n.includes('shoulder') ? 'плечи' : n.includes('leg') ? 'ноги' : n.includes('abs') || n.includes('waist') ? 'мышцы кора' : 'всё тело');
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

async function getLibraryExercises(profile: ProfileForProgram, version: number): Promise<LibraryExercise[]> {
  const equipmentFilter = profile.location === 'gym' || profile.location === 'mixed'
    ? `equipment <> ''`
    : `equipment = 'body weight'`;

  const { rows } = await pool.query(
    `SELECT id, name, COALESCE(name_ru,'') AS name_ru, category, COALESCE(body_part_ru,'') AS body_part_ru,
            equipment, COALESCE(equipment_ru,'') AS equipment_ru, target, muscle_group,
            COALESCE(muscle_group_ru,'') AS muscle_group_ru, secondary_muscles, instructions_ru,
            source_url, gif_url, image_url, training_types, movement_pattern, level
     FROM exercise_library
     WHERE ${equipmentFilter}
       AND category IN ('upper legs','chest','back','shoulders','waist','lower legs','upper arms','lower arms','cardio')
     LIMIT 800`
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
    level: String(row.level ?? 'beginner')
  }));

  const allowed = candidates.filter((row) => isExerciseAllowed(row, profile.limitations ?? ''));
  const focus = profile.training_focus && profile.training_focus !== 'auto'
    ? profile.training_focus
    : deriveTrainingFocus(profile);

  const categoryPlan = profile.workouts_per_week <= 1
    ? ['upper legs','chest','back','shoulders','waist']
    : profile.workouts_per_week === 2
      ? ['upper legs','back','chest','shoulders','waist']
      : ['upper legs','back','chest','shoulders','waist','lower legs'];

  const selected: LibraryExercise[] = [];
  const used = new Set<string>();

  for (const category of categoryPlan) {
    const ranked = allowed
      .filter((row) => row.category === category)
      .map((row) => ({ ...row, score: scoreExercise(row, profile, category, used) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked.find((row) => !used.has(row.id));
    if (best) {
      selected.push(best);
      used.add(best.id);
    }
  }

  const focusRanked = allowed
    .filter((row) => !used.has(row.id))
    .map((row) => ({ ...row, score: scoreExercise(row, profile, row.category, used) }))
    .sort((a, b) => b.score - a.score);

  for (const row of focusRanked) {
    if (selected.length >= 24) break;
    selected.push(row);
    used.add(row.id);
  }

  console.log('Program exercise pool:', { focus, selected: selected.length });
  return selected.slice(0, 24);
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
    name: ruExerciseName(row.name),
    gifUrl: row.gifUrl,
    sets,
    reps,
    rest: index < 4 ? (isMass ? '90–120 сек' : '60–90 сек') : '45–60 сек',
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
    limitations: String(profile.limitations ?? '')
  };

  const frequency = Math.min(Math.max(normalizedProfile.workouts_per_week, 1), 5);
  const duration = normalizedProfile.workout_duration;
  const daysCount = frequency;
  const libraryExercises = await getLibraryExercises(normalizedProfile, version);
  const fallback = buildExercises(normalizedProfile.location, normalizedProfile.goal, version);

  // If the DB does not have enough suitable exercises, use the safe built-in set only for missing slots.
  const baseRows = libraryExercises.map((row) => exercisePrescription(row, normalizedProfile, libraryExercises.indexOf(row)));
  const exercises = baseRows.length ? baseRows : fallback;

  const focus = ['Ноги + грудь', 'Спина + задняя цепь', 'Плечи + корпус'];
  const days: WorkoutDay[] = Array.from({ length: daysCount }, (_, i) => {
    let dayExercises: Exercise[];

    if (baseRows.length) {
      // Rotate the ranked exercise pool with a larger step so weekly sessions are meaningfully different.
      const rotation = (i * 3) % baseRows.length;
      const rotated = [...baseRows.slice(rotation), ...baseRows.slice(0, rotation)];
      dayExercises = rotated.slice(0, Math.min(6, baseRows.length)).map((e) => ({ ...e }));
    } else {
      dayExercises = exercises.map((e) => ({ ...e }));
    }

    if (duration <= 45) {
      dayExercises = dayExercises.slice(0, 5).map((e, idx) => ({
        ...e,
        sets: idx >= 3 ? Math.max(2, e.sets - 1) : e.sets
      }));
    }

    if (version > 1 && correction.toLowerCase().includes('легче')) {
      dayExercises.forEach((e) => { e.sets = Math.max(2, e.sets - 1); });
    }
    if (version > 1 && (correction.toLowerCase().includes('интенсивнее') || correction.toLowerCase().includes('больше'))) {
      dayExercises.forEach((e) => { e.reps = e.reps.replace('10–15', '12–15').replace('8–12', '10–12'); });
    }
    if (version > 1 && (correction.toLowerCase().includes('меньше') || correction.toLowerCase().includes('объем'))) {
      dayExercises = dayExercises.slice(0, Math.max(4, dayExercises.length - 1));
      dayExercises.forEach((e) => { e.sets = Math.max(2, e.sets - 1); });
    }

    return {
      day: i + 1,
      title: `Тренировка ${i + 1}`,
      focus: focus[i % focus.length],
      warmup: duration <= 45
        ? '5–7 минут: суставная разминка + лёгкая общая активность.'
        : '8–10 минут: суставная разминка + лёгкая общая активность.',
      exercises: dayExercises,
      cooldown: '3–5 минут спокойного восстановления и лёгкой подвижности.'
    };
  });

  return {
    title: `Программа: ${ruGoal(normalizedProfile.goal)}`,
    goal: ruGoal(normalizedProfile.goal),
    frequency,
    duration,
    location: ruLocation(normalizedProfile.location),
    version,
    weeks: 4,
    progression: normalizedProfile.goal === 'mass'
      ? 'При сохранении техники постепенно увеличивать рабочую нагрузку или повторения. Не доводить каждый подход до отказа.'
      : normalizedProfile.goal === 'loss'
        ? 'Основная задача — регулярность и постепенное увеличение объёма работы без резкого повышения нагрузки.'
        : 'Начинать с комфортного объёма и постепенно увеличивать нагрузку по мере адаптации.',
    days,
    notes: [
      'Упражнения подбираются из библиотеки по цели, опыту, месту тренировок, доступному времени и частоте занятий.',
      normalizedProfile.limitations && normalizeText(normalizedProfile.limitations) !== 'нет'
        ? `Ограничения из анкеты: ${normalizedProfile.limitations}. При наличии боли или медицинских ограничений требуется индивидуальная оценка специалиста.`
        : 'Ограничений в анкете не указано.',
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
        name: row.nameRu || ruExerciseName(row.name),
        gifUrl: row.gifUrl,
        sets: item.sets,
        reps: item.reps,
        rest: item.rest,
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

  let program: Program;
  if (aiEnabled()) {
    try {
      const frequency = Math.min(Math.max(Number(profile.workouts_per_week), 1), 5);
      const aiCandidates = await getLibraryExercises({
        goal: String(profile.goal),
        experience: String(profile.experience),
        location: String(profile.location),
        workouts_per_week: frequency,
        workout_duration: Number(profile.workout_duration),
        limitations: String(profile.limitations ?? ''),
        training_focus: String(profile.training_focus ?? 'auto')
      }, version);

      const aiProfile: AIPlannerProfile = {
        goal: String(profile.goal),
        experience: String(profile.experience),
        location: String(profile.location),
        workoutsPerWeek: frequency,
        workoutDuration: Number(profile.workout_duration),
        limitations: String(profile.limitations ?? ''),
        trainingFocus: String(profile.training_focus ?? 'auto')
      };

      const candidates: AIExerciseCandidate[] = aiCandidates.map((e) => ({
        id: e.id,
        nameRu: e.nameRu || ruExerciseName(e.name),
        bodyPartRu: e.bodyPartRu,
        equipmentRu: e.equipmentRu,
        muscleGroupRu: e.muscleGroupRu,
        trainingTypes: e.trainingTypes,
        movementPattern: e.movementPattern,
        level: e.level,
        instructionsRu: e.instructionsRu
      }));

      const aiPlan = await createAIWorkoutPlan(aiProfile, candidates, correction);
      program = convertAIPlanToProgram(aiPlan, profile, version, aiCandidates, correction) ?? await buildProgram(profile, version, correction);
      console.log('AI program created', { userId, version, format: aiPlan?.format ?? 'fallback' });
    } catch (error) {
      console.error('AI program failed; using deterministic planner', error);
      program = await buildProgram(profile, version, correction);
    }
  } else {
    program = await buildProgram(profile, version, correction);
  }

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
  await sendProgramText(ctx, programText(program), replyMarkup);
  const sent = new Set<string>();
  for (const day of program.days) for (const exercise of day.exercises) {
    const url = resolveGifUrl(exercise.gifUrl);
    if (!url || sent.has(url)) continue;
    sent.add(url);
    try {
      await ctx.replyWithAnimation(url, {
        caption: '💪 <b>' + escapeHtml(exercise.name) + '</b>\nПодходы: <b>' + exercise.sets + '</b> · Повторения: <b>' + escapeHtml(exercise.reps) + '</b> · Отдых: <b>' + escapeHtml(exercise.rest) + '</b>',
        parse_mode: 'HTML'
      });
    } catch (error) {
      console.error('exercise gif send failed', { name: exercise.name, url, error });
    }
  }
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
        e.comment ? `   💡 ${escapeHtml(e.comment)}` : '',
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
      .row()
      .text('👥 Клиенты', 'admin:profiles')
      .text('📊 Статистика', 'admin:stats')
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