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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS trainer_profiles_updated_at_idx ON trainer_profiles (updated_at DESC);

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
        const base = j * 9;
        values.push(
          String(ex.id),
          String(ex.name ?? ''),
          String(ex.category ?? ''),
          String(ex.equipment ?? ''),
          String(ex.target ?? ''),
          String(ex.muscle_group ?? ''),
          JSON.stringify(Array.isArray(ex.secondary_muscles) ? ex.secondary_muscles : []),
          String(ex.instructions?.ru ?? ex.instructions?.en ?? ''),
          sourceUrl
        );
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7}::jsonb,$${base + 8},$${base + 9})`;
      }).join(',');
      await pool.query(
        `INSERT INTO exercise_library
          (id,name,category,equipment,target,muscle_group,secondary_muscles,instructions_ru,source_url)
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
      ['fallback-plank','Боковая планка','waist','body weight','obliques','obliques',[]],
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

async function getLibraryExercises(location: string, goal: string, version: number): Promise<Exercise[]> {
  const gym = location === 'gym' || (location === 'mixed' && version % 2 === 1);
  const equipmentFilter = gym
    ? `equipment NOT IN ('body weight','band','resistance band')`
    : `equipment = 'body weight'`;

  const { rows } = await pool.query(
    `SELECT id, name, category, equipment, target, muscle_group, secondary_muscles, instructions_ru
     FROM exercise_library
     WHERE ${equipmentFilter}
       AND category IN ('upper legs','chest','back','shoulders','waist','lower legs')
     ORDER BY id
     LIMIT 80`
  );

  const selected: any[] = [];
  const categories = ['upper legs','chest','back','shoulders','waist','lower legs'];
  for (const category of categories) {
    const found = rows.find((r: any) =>
      r.category === category &&
      !selected.some((x) => x.id === r.id)
    );
    if (found) selected.push(found);
  }

  if (selected.length < 6) {
    for (const row of rows) {
      if (!selected.some((x) => x.id === row.id)) selected.push(row);
      if (selected.length >= 6) break;
    }
  }

  return selected.slice(0, 6).map((row: any, index: number) => ({
    name: ruExerciseName(row.name),
    sets: goal === 'mass' ? (index < 4 ? 3 : 2) : (index < 4 ? 3 : 2),
    reps: goal === 'mass' ? '8–12' : '10–15',
    rest: index < 4 ? '60–120 сек' : '45–60 сек',
    comment: goal === 'mass'
      ? 'Оставлять 1–3 повторения в запасе; при выполнении верхней границы повторений постепенно повышать нагрузку.'
      : undefined
  }));
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

async function getProfile(id: number) {
  const { rows } = await pool.query('SELECT * FROM trainer_profiles WHERE telegram_user_id = $1', [id]);
  return rows[0] ?? null;
}

function buildExercises(location: string, goal: string, version: number): Exercise[] {
  const home = [
    { name: 'Приседание с собственным весом', sets: 3, reps: '10–15', rest: '60–90 сек' },
    { name: 'Отжимания', sets: 3, reps: '8–15', rest: '60–90 сек' },
    { name: 'Ягодичный мост', sets: 3, reps: '12–15', rest: '60 сек' },
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

async function buildProgram(profile: any, version: number, correction = ''): Promise<Program> {
  const frequency = Math.min(Math.max(Number(profile.workouts_per_week), 1), 5);
  const duration = Number(profile.workout_duration);
  const daysCount = frequency;
  const libraryExercises = await getLibraryExercises(profile.location, profile.goal, version);
  const exercises = libraryExercises.length ? libraryExercises : buildExercises(profile.location, profile.goal, version);
  const focus = ['Ноги и жимовые движения', 'Спина и задняя цепь', 'Полное тело'];
  const days: WorkoutDay[] = Array.from({ length: daysCount }, (_, i) => {
    const dayExercises = exercises.map((e, idx) => ({
      ...e,
      sets: Math.max(2, e.sets - (duration <= 45 && idx > 3 ? 1 : 0))
    }));
    if (version > 1 && i === 0 && correction.includes('легче')) {
      dayExercises.forEach((e) => { e.sets = Math.max(2, e.sets - 1); });
    }
    if (version > 1 && i === 0 && correction.includes('интенсивнее')) {
      dayExercises.forEach((e) => { e.reps = e.reps.replace('8–12', '10–15'); });
    }
    return {
      day: i + 1,
      title: `Тренировка ${i + 1}`,
      focus: focus[i % focus.length],
      warmup: duration <= 45 ? '5–7 минут: суставная разминка + лёгкая общая активность.' : '8–10 минут: суставная разминка + лёгкая общая активность.',
      exercises: dayExercises,
      cooldown: '3–5 минут спокойного восстановления и лёгкой подвижности.'
    };
  });
  return {
    title: `Программа: ${ruGoal(profile.goal)}`,
    goal: ruGoal(profile.goal),
    frequency,
    duration,
    location: ruLocation(profile.location),
    version,
    weeks: 4,
    progression: 'Работать с контролируемой техникой. Если все подходы выполнены в верхней границе повторений без ухудшения техники, постепенно увеличить нагрузку на следующей тренировке.',
    days,
    notes: [
      'Перед началом учитывать ограничения, указанные в анкете.',
      'Не выполнять упражнение через боль; при необходимости заменить его тренером.',
      profile.limitations && profile.limitations.toLowerCase() !== 'нет' ? `Ограничения: ${profile.limitations}` : 'Ограничений в анкете не указано.',
      correction ? `Учтена коррекция: ${correction}` : 'Программа сформирована по исходной анкете.'
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
    await ctx.reply(chunks[i], i === chunks.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : undefined);
  }
}

function programText(program: Program) {
  const parts = [
    `🏋️ ${program.title}`,
    `Версия: ${program.version}`,
    `Цель: ${program.goal}`,
    `Формат: ${program.location}`,
    `График: ${program.frequency} тренировки/неделю`,
    `Длительность: ${program.duration} мин`,
    '',
    '📈 Прогрессия:',
    program.progression,
    ''
  ];
  for (const day of program.days) {
    parts.push(`📅 ${day.title} — ${day.focus}`);
    parts.push(`Разминка: ${day.warmup}`);
    day.exercises.forEach((e, i) => {
      parts.push(`${i + 1}. ${e.name} — ${e.sets}×${e.reps}, отдых ${e.rest}${e.comment ? ` — ${e.comment}` : ''}`);
    });
    parts.push(`Заминка: ${day.cooldown}`, '');
  }
  parts.push('📝 Примечания:', ...program.notes);
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

async function sendCurrentProgram(ctx: any) {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.reply('Доступ закрыт.');
  const current = await getCurrentProgram(ctx.from.id);
  if (!current) {
    const created = await createProgram(ctx.from.id);
    if (!created) return ctx.reply('Сначала заполните профиль.');
    return sendProgramText(ctx, programText(created.program), programKeyboard(created.id));
  }
  await sendProgramText(ctx, programText(current.program), programKeyboard(Number(current.id), current.status));
}

async function startQuiz(ctx: any) {
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
      .text('👥 Последние анкеты', 'admin:profiles')
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
    SELECT telegram_username, first_name, goal, experience, location, workouts_per_week, workout_duration, updated_at
    FROM trainer_profiles ORDER BY updated_at DESC LIMIT 10
  `);
  return rows;
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
  await ctx.reply(
    `Профиль
Цель: ${ruGoal(profile.goal)}
Опыт: ${ruExperience(profile.experience)}
Место: ${ruLocation(profile.location)}
Тренировок в неделю: ${profile.workouts_per_week}
Длительность: ${profile.workout_duration} мин
Ограничения: ${profile.limitations || 'Нет'}
Обновлён: ${new Date(profile.updated_at).toLocaleString('ru-RU')}`,
    { reply_markup: new InlineKeyboard().text('🏋️ Составить/открыть программу', 'program:current') }
  );
});

bot.command('program', async (ctx) => { await sendCurrentProgram(ctx); });
bot.command('reset', startQuiz);

bot.callbackQuery('profile', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  await ctx.answerCallbackQuery();
  await ctx.reply('Открываю профиль...');
  await bot.api.sendMessage(ctx.chat!.id, 'Используйте /profile для полного профиля.');
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
  if (!(await isAdmin(ctx))) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  await ctx.answerCallbackQuery();
  const profiles = await getRecentProfiles();
  if (!profiles.length) return ctx.reply('Анкет пока нет.');
  const text = profiles.map((p: any, i: number) => {
    const name = p.telegram_username ? `@${p.telegram_username}` : p.first_name;
    return `${i + 1}. ${name}\nЦель: ${ruGoal(p.goal)}\nОпыт: ${ruExperience(p.experience)}\nМесто: ${ruLocation(p.location)}\n${p.workouts_per_week} трен./нед. × ${p.workout_duration} мин.`;
  }).join('\n\n');
  await ctx.reply(`👥 Последние анкеты\n\n${text}`);
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
  const correction = correctionSessions.get(ctx.from.id);
  if (correction) {
    const request = ctx.message.text.trim();
    correctionSessions.delete(ctx.from.id);
    const created = await createProgram(ctx.from.id, request);
    if (!created) return ctx.reply('Сначала заполните профиль.');
    await ctx.reply(`Готово. Создана версия ${created.version} с учётом коррекции:\n«${request}»`);
    return sendProgramText(ctx, programText(created.program), programKeyboard(created.id));
  }

  const session = sessions.get(ctx.from.id);
  if (!session || session.step !== 'limitations') return;
  const limitations = ctx.message.text.trim();
  try {
    await saveProfile({ id: ctx.from.id, username: ctx.from.username, firstName: ctx.from.first_name }, { ...session, limitations });
    sessions.delete(ctx.from.id);
    const created = await createProgram(ctx.from.id);
    if (!created) return ctx.reply('Профиль сохранён, но программу создать не удалось.');
    await ctx.reply('Профиль сохранён ✅\n\nПрограмма составлена автоматически. Ниже — первая версия.');
    await sendProgramText(ctx, programText(created.program), programKeyboard(created.id));
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
  await pool.query(`UPDATE training_programs SET status='approved' WHERE id=$1 AND status='draft'`, [id]);
  await ctx.answerCallbackQuery({ text: 'Программа подтверждена.' });
  await ctx.reply('✅ Текущая версия программы подтверждена.');
});

bot.callbackQuery('program:history', async (ctx) => {
  if (!(await isAdmin(ctx)) || !ctx.from) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  await ctx.answerCallbackQuery();
  const rows = await getProgramHistory(ctx.from.id);
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
  server.listen(PORT, () => console.log(`Health server listening on :${PORT}`));
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  console.log('Starting Telegram long polling...');
  await bot.start({ onStart: (info) => console.log(`Bot @${info.username} started`) });
}

main().catch((error) => {
  console.error('Fatal startup error', error);
  process.exit(1);
});
