import 'dotenv/config';
import { createServer } from 'node:http';
import { Bot, InlineKeyboard } from 'grammy';
import pg from 'pg';

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
};

type Exercise = {
  name: string;
  sets: number;
  reps: string;
  rest: string;
  comment?: string;
};

type LibraryExercise = {
  id: string;
  name: string;
  category: string;
  equipment: string;
  target: string;
  muscleGroup: string;
  secondaryMuscles: string[];
  instructionsRu: string;
  sourceUrl: string;
  gifUrl?: string;
  imageUrl?: string;
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
const clientAddSessions = new Map<number, { step: 'id' | 'username'; id?: number }>();
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
  return `👤 <b>${displayUsername(profile)}</b>\n🆔 Telegram ID: <code>${profile?.telegram_user_id ?? '—'}</code>`;
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
    CREATE INDEX IF NOT EXISTS payment_history_user_created_idx ON payment_history (telegram_user_id, created_at DESC);
    ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS payment_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS training_sessions_total INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS training_sessions_remaining INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS gif_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';

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
  const n = name.toLowerCase();
  const map: Array<[string,string]> = [
    ['barbell bench press','Жим лёжа со штангой'],
    ['bench press','Жим лёжа'],
    ['barbell full squat','Приседание со штангой'],
    ['barbell squat','Приседание со штангой'],
    ['goblet squat','Гоблет-присед'],
    ['pull-up','Подтягивания'],
    ['pull up','Подтягивания'],
    ['push-up','Отжимания'],
    ['push up','Отжимания'],
    ['dumbbell biceps curl','Сгибание рук с гантелями'],
    ['dumbbell lateral raise','Разведения гантелей в стороны'],
    ['dumbbell shoulder press','Жим гантелей сидя'],
    ['romanian deadlift','Румынская тяга'],
    ['deadlift','Становая тяга'],
    ['lat pulldown','Тяга верхнего блока'],
    ['good morning','Good Morning'],
    ['reverse lunge','Выпады назад'],
    ['walking lunge','Выпады'],
    ['dead bug','Dead Bug'],
    ['plank','Планка'],
    ['calf raise','Подъём на носки']
  ];
  const hit = map.find(([key]) => n.includes(key));
  return hit?.[1] ?? name;
}

type ProfileForProgram = {
  goal: string;
  experience: string;
  location: string;
  workouts_per_week: number;
  workout_duration: number;
  limitations?: string;
};

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
  const text = normalizeText(`${row.name} ${row.target} ${row.muscleGroup} ${row.equipment}`);
  const difficulty = exerciseDifficulty(row);

  // 1) The exercise must match the requested movement/muscle category.
  if (row.category === desiredCategory) score += 30;

  // 2) Goal changes the priority of exercise types and volume later.
  if (profile.goal === 'mass') {
    if (/(chest|pector|back|lat|dorsi|quadr|hamstring|glute|deltoid|shoulder)/.test(text)) score += 8;
    if (/(isolation|curl|extension|raise|fly)/.test(text)) score += 2;
  } else if (profile.goal === 'loss') {
    if (/(squat|lunge|row|push|press|pull|deadlift|carry)/.test(text)) score += 6;
    if (/(body weight|bodyweight)/.test(text)) score += 3;
  } else {
    if (/(squat|lunge|row|push|press|pull|hinge|deadlift|core|abs)/.test(text)) score += 7;
  }

  // 3) Experience controls complexity: beginners get simpler patterns first.
  if (profile.experience === 'beginner' || profile.experience === 'under1') {
    score += difficulty === 1 ? 8 : difficulty === 2 ? 2 : -10;
  } else if (profile.experience === '1to3') {
    score += difficulty <= 2 ? 5 : 1;
  } else {
    score += difficulty >= 2 ? 5 : 2;
  }

  // 4) Match available training environment.
  const gym = profile.location === 'gym' || (profile.location === 'mixed');
  if (gym && !/(body weight|bodyweight)/.test(text)) score += 4;
  if (!gym && /(body weight|bodyweight)/.test(text)) score += 8;

  // 5) Avoid repeating the same exercise across the program where alternatives exist.
  if (usedIds.has(row.id)) score -= 18;

  // 6) Very short sessions favor simpler choices; longer sessions can tolerate more variety.
  if (profile.workout_duration <= 45 && difficulty === 3) score -= 5;
  if (profile.workout_duration >= 75 && difficulty >= 2) score += 2;

  return score;
}

async function getLibraryExercises(profile: ProfileForProgram, version: number): Promise<LibraryExercise[]> {
  const gym = profile.location === 'gym' || (profile.location === 'mixed' && version % 2 === 1);
  const equipmentFilter = gym
    ? `equipment NOT IN ('body weight','band','resistance band')`
    : `equipment = 'body weight'`;

  const { rows } = await pool.query(
    `SELECT id, name, category, equipment, target, muscle_group, secondary_muscles, instructions_ru, source_url, gif_url, image_url
     FROM exercise_library
     WHERE ${equipmentFilter}
       AND category IN ('upper legs','chest','back','shoulders','waist','lower legs')
     LIMIT 200`
  );

  const candidates: LibraryExercise[] = rows.map((row: any) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    category: String(row.category ?? ''),
    equipment: String(row.equipment ?? ''),
    target: String(row.target ?? ''),
    muscleGroup: String(row.muscle_group ?? ''),
    secondaryMuscles: Array.isArray(row.secondary_muscles) ? row.secondary_muscles : [],
    instructionsRu: String(row.instructions_ru ?? ''),
    sourceUrl: String(row.source_url ?? ''),
    gifUrl: String(row.gif_url ?? ''),
    imageUrl: String(row.image_url ?? '')
  }));

  const allowedCandidates = candidates.filter((row) => isExerciseAllowed(row, profile.limitations ?? ''));

  // A program is built from movement/muscle categories, not from the first DB rows.
  // Each category is ranked against the questionnaire, then different exercises are rotated by day.
  const categories = ['upper legs', 'chest', 'back', 'shoulders', 'waist'];
  if (profile.goal !== 'mass' && profile.workout_duration >= 45) categories.push('lower legs');

  const selected: LibraryExercise[] = [];
  const used = new Set<string>();

  for (let i = 0; i < Math.min(categories.length, 6); i++) {
    const category = categories[(i + (version - 1)) % categories.length];
    const ranked = allowedCandidates
      .filter((row) => row.category === category)
      .map((row) => ({ ...row, score: scoreExercise(row, profile, category, used) }))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];
    if (best) {
      selected.push(best);
      used.add(best.id);
    }
  }

  // If the dataset has sparse categories, fill from the highest scoring unused exercises.
  if (selected.length < 10) {
    const ranked = allowedCandidates
      .filter((row) => !used.has(row.id))
      .map((row) => ({
        ...row,
        score: scoreExercise(row, profile, row.category, used)
      }))
      .sort((a, b) => b.score - a.score);

    for (const row of ranked) {
      if (selected.length >= 10) break;
      selected.push(row);
      used.add(row.id);
    }
  }

  return selected.slice(0, 10);
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
       limitations=EXCLUDED.limitations, updated_at=NOW()`,
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
  const userId = targetId ?? selectedClient.get(ctx.from.id) ?? ctx.from.id;
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


async function createProgram(userId: number, correction = '') {
  const profile = await getProfile(userId);
  if (!profile) return null;
  const { rows: versionRows } = await pool.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM training_programs WHERE telegram_user_id = $1',
    [userId]
  );
  const version = Number(versionRows[0].next_version);
  const program = await buildProgram(profile, version, correction);
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

async function sendProgramText(ctx: any, text: string, replyMarkup?: InlineKeyboard) {
  const limit = 3500;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
  for (let i = 0; i < chunks.length; i++) {
    const options = {
      parse_mode: 'HTML' as const,
      ...(i === chunks.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {})
    };
    await ctx.reply(chunks[i], options);
  }
}

function programText(program: Program) {
  const parts = [
    `🏋️ <b>${program.title}</b>`,
    '',
    '📌 <b>Параметры программы</b>',
    `🎯 Цель: <b>${program.goal}</b>`,
    `📍 Формат: <b>${program.location}</b>`,
    `📅 График: <b>${program.frequency} тренировки/неделю</b>`,
    `⏱ Длительность: <b>${program.duration} мин</b>`,
    '',
    '━━━━━━━━━━━━━━',
    '',
    '📈 <b>Прогрессия</b>',
    program.progression,
    ''
  ];

  for (const day of program.days) {
    parts.push(
      '',
      '━━━━━━━━━━━━━━',
      '',
      `🏋️ <b>${day.title}</b>`,
      `🎯 Фокус: <b>${day.focus}</b>`,
      '',
      '🔥 <b>Разминка</b>',
      day.warmup,
      '',
      '💪 <b>Упражнения</b>',
      ''
    );

    day.exercises.forEach((e, i) => {
      parts.push(
        `<b>${i + 1}. ${e.name}</b>`,
        `   Подходы: <b>${e.sets}</b>   Повторения: <b>${e.reps}</b>`,
        `   Отдых: <b>${e.rest}</b>`,
        e.comment ? `   💡 ${e.comment}` : '',
        ''
      );
    });

    parts.push(
      `🧘 <b>Заминка</b>`,
      day.cooldown,
      ''
    );
  }

  parts.push(
    '',
    '━━━━━━━━━━━━━━',
    '',
    '📝 <b>Важные примечания</b>',
    '',
    ...program.notes.map((note) => `• ${note}`)
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
    return sendProgramText(ctx, `${identityBlock(profile)}\n\n${programText(created.program)}`, programKeyboard(created.id));
  }
  await sendProgramText(ctx, `${identityBlock(profile)}\n\n${programText(current.program)}`, programKeyboard(Number(current.id), current.status));
}

async function startQuiz(ctx: any) {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.reply('Доступ закрыт.');
  const targetId = selectedClient.get(ctx.from.id) ?? ctx.from.id;
  quizTargets.set(ctx.from.id, targetId);
  if (!(await isAdmin(ctx))) return ctx.reply('Доступ закрыт.');
  if (!ctx.from) return ctx.reply('Доступ закрыт.');
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
  const keyboard = new InlineKeyboard()
    .text('📝 Заполнить анкету', 'quiz:start')
    .row()
    .text('👤 Мой профиль', 'profile')
    .row()
    .text('🏋️ Моя программа', 'program:current');
  if (adminId !== null) keyboard.row().text('🛠 Админ-панель', 'admin:open');
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
      .text('🏋️ Текущая программа', 'program:current')
      .row()
      .text('📚 История программ', 'program:history')
      .row()
      .text('📝 Заполнить анкету', 'quiz:start')
      .text('👤 Мой профиль', 'profile')
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
    SELECT telegram_user_id, telegram_username, first_name, goal, experience, location, workouts_per_week, workout_duration,
           payment_amount, training_sessions_total, training_sessions_remaining, updated_at
    FROM trainer_profiles ORDER BY updated_at DESC LIMIT 20
  `);
  return rows;
}

async function searchClients(query: string) {
  const q = query.trim().replace(/^@/, '');
  if (!q) return [];
  const { rows } = await pool.query(
    `SELECT telegram_user_id, telegram_username, first_name, goal, experience, location,
            workouts_per_week, workout_duration, payment_amount, training_sessions_total,
            training_sessions_remaining, updated_at
     FROM trainer_profiles
     WHERE LOWER(COALESCE(telegram_username, '')) LIKE LOWER($1)
        OR LOWER(COALESCE(first_name, '')) LIKE LOWER($1)
        OR CAST(telegram_user_id AS TEXT) = $2
     ORDER BY updated_at DESC
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
  await ctx.reply('Pavel Fitness Support Bot\n\nВнутренний инструмент тренера. Профиль → программа → коррекция → история версий.', {
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
  const profile = await getProfile(ctx.from.id);
  if (!profile) return ctx.reply('Профиль пока не заполнен. Нажми /start.');
  const payment = await getPaymentInfo(selectedClient.get(ctx.from.id) ?? ctx.from.id);
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
  const profile = await getProfile(ctx.from.id);
  if (!profile) return ctx.reply('Профиль пока не заполнен. Нажми «Заполнить анкету».');
  const payment = await getPaymentInfo(ctx.from.id);
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

🔎 Чтобы найти клиента, напиши его <b>username</b>, имя или Telegram ID.

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
  await ctx.reply('🔎 Введи username (например @ivan), имя или Telegram ID клиента.');
});

bot.callbackQuery(/^client:select:(\d+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const clientId = Number(ctx.match[1]);
  const profile = await getProfile(clientId);
  if (!profile) return ctx.answerCallbackQuery({ text: 'Клиент не найден.' });
  selectedClient.set(ctx.from.id, clientId);
  await ctx.answerCallbackQuery({ text: 'Клиент выбран.' });
  const payment = await getPaymentInfo(clientId);
  const current = await getCurrentProgram(clientId);
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
      .text('⬅️ Клиенты', 'admin:profiles')
  });
});

bot.callbackQuery('admin:client:add', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  clientAddSessions.set(ctx.from.id, { step: 'id' });
  await ctx.answerCallbackQuery();
  await ctx.reply('➕ <b>Добавление клиента</b>\n\nВведи Telegram ID клиента. Его можно получить из Telegram-профиля/бота клиента.', { parse_mode: 'HTML' });
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
  const id = selectedClient.get(ctx.from.id);
  if (!id) return ctx.answerCallbackQuery({ text: 'Сначала выбери клиента.' });
  await ctx.answerCallbackQuery();
  await sendPaymentPanel(ctx, id);
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
  if (!(await isAdmin(ctx))) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  await ctx.answerCallbackQuery();
  await sendPaymentPanel(ctx);
});

bot.callbackQuery('payment:edit', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  paymentSessions.set(ctx.from.id, { step: 'amount', targetId: selectedClient.get(ctx.from.id) ?? ctx.from.id });
  await ctx.answerCallbackQuery();
  await ctx.reply('💳 Введи сумму оплаты в рублях. Например: 15000');
});

bot.callbackQuery('payment:history', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  await ctx.answerCallbackQuery();
  const userId = selectedClient.get(ctx.from.id) ?? ctx.from.id;
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
  const targetId = selectedClient.get(ctx.from.id) ?? ctx.from.id;
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
    if (addSession.step === 'id') {
      const id = Number(raw);
      if (!Number.isSafeInteger(id) || id <= 0) return ctx.reply('Введи корректный числовой Telegram ID.');
      addSession.id = id;
      addSession.step = 'username';
      return ctx.reply('👤 Введи username клиента (например @ivan). Если username нет — напиши «нет».');
    }
    const username = raw.toLowerCase() === 'нет' ? null : raw.replace(/^@/, '').trim();
    const id = addSession.id!;
    await pool.query(
      `INSERT INTO trainer_profiles (telegram_user_id, telegram_username, first_name, goal, experience, location, workouts_per_week, workout_duration, limitations)
       VALUES ($1,$2,'Клиент','health','beginner','gym',1,60,'')
       ON CONFLICT (telegram_user_id) DO UPDATE SET telegram_username=COALESCE(EXCLUDED.telegram_username, trainer_profiles.telegram_username), updated_at=NOW()`,
      [id, username]
    );
    clientAddSessions.delete(ctx.from.id);
    selectedClient.set(ctx.from.id, id);
    return ctx.reply('✅ Клиент добавлен и выбран. Теперь заполни его анкету.', {
      reply_markup: new InlineKeyboard().text('📝 Заполнить анкету', 'client:quiz').row().text('👤 Профиль', 'client:program').row().text('⬅️ Клиенты', 'admin:profiles')
    });
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
      keyboard.text(`${i + 1}. ${(p.telegram_username ? '@' + p.telegram_username : p.first_name || 'Клиент').slice(0, 28)}`, `client:select:${p.telegram_user_id}`).row();
    });
    keyboard.text('🔎 Новый поиск', 'admin:search').row().text('⬅️ Клиенты', 'admin:profiles');
    return ctx.reply(`🔎 <b>Результаты поиска</b>

${text}

Нажми на нужного клиента — все дальнейшие действия будут выполняться для него.`, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  const payment = paymentSessions.get(ctx.from.id);
  if (payment) {
    const raw = ctx.message.text.trim().replace(',', '.');
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return ctx.reply('Введи корректное число.');
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
    return sendPaymentPanel(ctx);
  }

  const correction = correctionSessions.get(ctx.from.id);
  if (correction) {
    const request = ctx.message.text.trim();
    correctionSessions.delete(ctx.from.id);
    const created = await createProgram(selectedClient.get(ctx.from.id) ?? ctx.from.id, request);
    if (!created) return ctx.reply('Сначала заполните профиль.');
    await ctx.reply(`Готово. Создана версия ${created.version} с учётом коррекции:\n«${request}»`);
    return sendProgramText(ctx, programText(created.program), programKeyboard(created.id));
  }

  const session = sessions.get(ctx.from.id);
  if (!session || session.step !== 'limitations') return;
  const limitations = ctx.message.text.trim();
  try {
    const targetId = quizTargets.get(ctx.from.id) ?? ctx.from.id;
    const existingTarget = await getProfile(targetId);
    await saveProfile({
      id: targetId,
      username: existingTarget?.telegram_username ?? (targetId === ctx.from.id ? ctx.from.username : undefined),
      firstName: existingTarget?.first_name ?? (targetId === ctx.from.id ? ctx.from.first_name : undefined)
    }, { ...session, limitations });
    sessions.delete(ctx.from.id);
    quizTargets.delete(ctx.from.id);
    const created = await createProgram(userId);
    if (!created) return ctx.reply('Профиль сохранён, но программу создать не удалось.');
    await ctx.reply('Профиль сохранён ✅\n\nПрограмма составлена автоматически. Ниже — первая версия.');
    const targetProfile = await getProfile(targetId);
    await sendProgramText(ctx, `${identityBlock(targetProfile)}\n\n${programText(created.program)}`, programKeyboard(created.id));
  } catch (error) {
    console.error('save profile/program error', error);
    await ctx.reply('Не удалось сохранить профиль или программу. Проверь подключение базы данных.');
  }
});

bot.callbackQuery(/^program:correct:(\d+)$/, async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const programId = Number(ctx.match[1]);
  correctionSessions.set(ctx.from.id, { programId });
  await ctx.answerCallbackQuery();
  await ctx.reply('🔄 Что изменить в программе? Напиши одним сообщением. Например: «сделать легче», «сделать интенсивнее», «заменить упражнения на домашние», «уменьшить объём».');
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
  const integrity = await pool.query(`SELECT
    (SELECT COUNT(*) FROM trainer_profiles) AS profiles,
    (SELECT COUNT(*) FROM training_programs) AS programs,
    (SELECT COUNT(*) FROM exercise_library) AS exercises
  `);
  console.log('Database integrity:', integrity.rows[0]);
  server.listen(PORT, () => console.log(`Health server listening on :${PORT}`));
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  console.log('Starting Telegram long polling...');
  await bot.start({ onStart: (info) => console.log(`Bot @${info.username} started`) });
}

main().catch((error) => {
  console.error('Fatal startup error', error);
  process.exit(1);
});
