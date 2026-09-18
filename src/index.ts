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
if (!ADMIN_TELEGRAM_ID) throw new Error('ADMIN_TELEGRAM_ID is required');
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const adminId = Number(ADMIN_TELEGRAM_ID);
if (!Number.isSafeInteger(adminId)) throw new Error('ADMIN_TELEGRAM_ID must be a Telegram numeric user id');

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

const sessions = new Map<number, QuizState>();

function isAdmin(ctx: { from?: { id: number } }) {
  return ctx.from?.id === adminId;
}

async function saveProfile(user: {
  id: number;
  username?: string;
  firstName: string;
}, state: QuizState) {
  await pool.query(
    `INSERT INTO trainer_profiles
      (telegram_user_id, telegram_username, first_name, goal, experience, location, workouts_per_week, workout_duration, limitations, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       telegram_username=EXCLUDED.telegram_username,
       first_name=EXCLUDED.first_name,
       goal=EXCLUDED.goal,
       experience=EXCLUDED.experience,
       location=EXCLUDED.location,
       workouts_per_week=EXCLUDED.workouts_per_week,
       workout_duration=EXCLUDED.workout_duration,
       limitations=EXCLUDED.limitations,
       updated_at=NOW()`,
    [
      user.id,
      user.username ?? null,
      user.firstName,
      state.goal,
      state.experience,
      state.location,
      state.workoutsPerWeek,
      state.workoutDuration,
      state.limitations ?? ''
    ]
  );
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
    CREATE INDEX IF NOT EXISTS trainer_profiles_updated_at_idx
      ON trainer_profiles (updated_at DESC);
  `);
}

async function getProfile(id: number) {
  const { rows } = await pool.query(
    'SELECT * FROM trainer_profiles WHERE telegram_user_id = $1',
    [id]
  );
  return rows[0] ?? null;
}

function startKeyboard() {
  return new InlineKeyboard().text('Начать заполнение', 'quiz:start').row().text('Мой профиль', 'profile');
}

async function startQuiz(ctx: any) {
  if (!isAdmin(ctx)) return ctx.reply('Доступ закрыт.');
  sessions.set(ctx.from.id, { step: 'goal' });
  await ctx.reply('Шаг 1/6. Какая главная цель клиента?', {
    reply_markup: new InlineKeyboard()
      .text('Похудение', 'goal:loss')
      .text('Набор массы', 'goal:mass')
      .row()
      .text('Здоровье / форма', 'goal:health')
  });
}

bot.command('start', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Доступ закрыт.');
  await ctx.reply(
    'Pavel Fitness Support Bot\n\nВнутренний инструмент тренера. Здесь хранится структурированный профиль для подготовки работы с клиентом.',
    { reply_markup: startKeyboard() }
  );
});

bot.command('help', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Доступ закрыт.');
  await ctx.reply('/start — главное меню\n/profile — сохранённый профиль\n/reset — начать анкету заново');
});

bot.command('profile', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Доступ закрыт.');
  const profile = await getProfile(ctx.from.id);
  if (!profile) return ctx.reply('Профиль пока не заполнен. Нажми /start.');
  await ctx.reply(
    `Профиль тренера/клиента
Цель: ${profile.goal}
Опыт: ${profile.experience}
Место: ${profile.location}
Тренировок в неделю: ${profile.workouts_per_week}
Длительность: ${profile.workout_duration} мин
Ограничения: ${profile.limitations || 'нет'}
Обновлён: ${new Date(profile.updated_at).toLocaleString('ru-RU')}`
  );
});

bot.command('reset', startQuiz);

bot.callbackQuery('profile', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  await ctx.answerCallbackQuery();
  const profile = await getProfile(ctx.from.id);
  if (!profile) return ctx.reply('Профиль пока не заполнен. Нажми /start.');
  await ctx.reply(
    `Профиль
Цель: ${profile.goal}
Опыт: ${profile.experience}
Место: ${profile.location}
Тренировок в неделю: ${profile.workouts_per_week}
Длительность: ${profile.workout_duration} мин
Ограничения: ${profile.limitations || 'нет'}`
  );
});

bot.callbackQuery('quiz:start', async (ctx) => {
  await ctx.answerCallbackQuery();
  await startQuiz(ctx);
});

bot.callbackQuery(/^goal:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const value = ctx.match[1];
  sessions.set(ctx.from.id, { step: 'experience', goal: value });
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Шаг 2/6. Опыт тренировок?', {
    reply_markup: new InlineKeyboard()
      .text('Новичок', 'exp:beginner')
      .text('До 1 года', 'exp:under1')
      .row()
      .text('1–3 года', 'exp:1to3')
      .text('3+ года', 'exp:3plus')
  });
});

bot.callbackQuery(/^exp:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const session = sessions.get(ctx.from.id);
  if (!session) return startQuiz(ctx);
  session.experience = ctx.match[1];
  session.step = 'location';
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Шаг 3/6. Где будут проходить тренировки?', {
    reply_markup: new InlineKeyboard()
      .text('Зал', 'loc:gym')
      .text('Дом', 'loc:home')
      .row()
      .text('Улица', 'loc:outdoor')
      .text('Смешанный формат', 'loc:mixed')
  });
});

bot.callbackQuery(/^loc:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const session = sessions.get(ctx.from.id);
  if (!session) return startQuiz(ctx);
  session.location = ctx.match[1];
  session.step = 'workouts';
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Шаг 4/6. Сколько тренировок в неделю?', {
    reply_markup: new InlineKeyboard()
      .text('1', 'wk:1').text('2', 'wk:2').text('3', 'wk:3')
      .row().text('4', 'wk:4').text('5+', 'wk:5')
  });
});

bot.callbackQuery(/^wk:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const session = sessions.get(ctx.from.id);
  if (!session) return startQuiz(ctx);
  session.workoutsPerWeek = Number(ctx.match[1]);
  session.step = 'duration';
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Шаг 5/6. Сколько минут на одну тренировку?', {
    reply_markup: new InlineKeyboard()
      .text('30', 'dur:30').text('45', 'dur:45').text('60', 'dur:60')
      .row().text('75', 'dur:75').text('90', 'dur:90')
  });
});

bot.callbackQuery(/^dur:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Доступ закрыт.' });
  const session = sessions.get(ctx.from.id);
  if (!session) return startQuiz(ctx);
  session.workoutDuration = Number(ctx.match[1]);
  session.step = 'limitations';
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('Шаг 6/6. Есть ограничения или особенности? Напиши их одним сообщением. Если нет — напиши «нет».');
});

bot.on('message:text', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const session = sessions.get(ctx.from.id);
  if (!session || session.step !== 'limitations') return;
  const limitations = ctx.message.text.trim();
  try {
    await saveProfile(
      {
        id: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name
      },
      { ...session, limitations }
    );
    sessions.delete(ctx.from.id);
    await ctx.reply('Профиль сохранён ✅\n\nТеперь его можно открыть командой /profile.');
  } catch (error) {
    console.error('save profile error', error);
    await ctx.reply('Не удалось сохранить профиль. Проверь подключение базы данных.');
  }
});

bot.catch((error) => {
  console.error('Telegram bot error', error.error);
});

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
  server.listen(PORT, () => console.log(`Health server listening on :${PORT}`));
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  console.log('Starting Telegram long polling...');
  await bot.start({
    onStart: (info) => console.log(`Bot @${info.username} started`)
  });
}

main().catch((error) => {
  console.error('Fatal startup error', error);
  process.exit(1);
});
