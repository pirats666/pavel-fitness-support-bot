import { Bot, InlineKeyboard, type Context } from 'grammy';
import pg from 'pg';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

type ActiveLog = {
  clientId: number;
  sessionId: number;
  exerciseSessionId?: number;
  exerciseId?: number;
  step?: 'weight' | 'reps' | 'rir' | 'comment';
  pending?: { weightKg: number; reps: number; rir: number | null };
};

const sessions = new Map<number, ActiveLog>();

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.coach_workout_sessions (
      id BIGSERIAL PRIMARY KEY,
      client_id BIGINT NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
      program_id BIGINT REFERENCES public.coach_training_programs(client_id) ON DELETE SET NULL,
      program_name TEXT NOT NULL,
      day_id BIGINT REFERENCES public.coach_training_program_days(id) ON DELETE SET NULL,
      day_name TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS coach_workout_sessions_client_idx
      ON public.coach_workout_sessions(client_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS public.coach_workout_session_exercises (
      id BIGSERIAL PRIMARY KEY,
      session_id BIGINT NOT NULL REFERENCES public.coach_workout_sessions(id) ON DELETE CASCADE,
      source_exercise_id BIGINT REFERENCES public.coach_training_program_exercises(id) ON DELETE SET NULL,
      exercise_order INTEGER NOT NULL,
      name TEXT NOT NULL,
      planned_sets INTEGER NOT NULL,
      planned_reps TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.coach_workout_sets (
      id BIGSERIAL PRIMARY KEY,
      session_exercise_id BIGINT NOT NULL REFERENCES public.coach_workout_session_exercises(id) ON DELETE CASCADE,
      set_number INTEGER NOT NULL,
      weight_kg NUMERIC(7,2) NOT NULL CHECK(weight_kg >= 0 AND weight_kg <= 1000),
      reps INTEGER NOT NULL CHECK(reps >= 0 AND reps <= 1000),
      rir NUMERIC(3,1) CHECK(rir >= 0 AND rir <= 10),
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(session_exercise_id, set_number)
    );
  `);
}

async function dbClients() {
  const { rows } = await pool.query(`
    SELECT id, telegram_username, name
    FROM public.clients
    ORDER BY created_at DESC
  `);
  return rows;
}

async function dbPrograms(clientId: number) {
  const { rows } = await pool.query(`
    SELECT client_id, name
    FROM public.coach_training_programs
    WHERE client_id = $1
  `, [clientId]);
  return rows;
}

async function dbDays(clientId: number) {
  const { rows } = await pool.query(`
    SELECT id, day_number, name
    FROM public.coach_training_program_days
    WHERE client_id = $1
    ORDER BY day_number
  `, [clientId]);
  return rows;
}

async function dbExercises(dayId: number) {
  const { rows } = await pool.query(`
    SELECT id, exercise_order, name, sets, reps
    FROM public.coach_training_program_exercises
    WHERE day_id = $1
    ORDER BY exercise_order
  `, [dayId]);
  return rows;
}

async function createSession(clientId: number, dayId: number) {
  const client = await pool.query(`
    SELECT c.id, p.client_id AS program_id, p.name AS program_name, d.name AS day_name
    FROM public.clients c
    JOIN public.coach_training_programs p ON p.client_id = c.id
    JOIN public.coach_training_program_days d ON d.client_id = c.id AND d.id = $2
    WHERE c.id = $1
  `, [clientId, dayId]);

  const row = client.rows[0];
  if (!row) throw new Error('Не удалось найти программу или день.');

  const exercises = await dbExercises(dayId);
  if (!exercises.length) throw new Error('В выбранном дне нет упражнений.');

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const session = await c.query(`
      INSERT INTO public.coach_workout_sessions(client_id, program_id, program_name, day_id, day_name)
      VALUES($1,$2,$3,$4,$5)
      RETURNING id, started_at
    `, [clientId, row.program_id, row.program_name, dayId, row.day_name]);

    for (const e of exercises) {
      await c.query(`
        INSERT INTO public.coach_workout_session_exercises
          (session_id, source_exercise_id, exercise_order, name, planned_sets, planned_reps)
        VALUES($1,$2,$3,$4,$5,$6)
      `, [session.rows[0].id, e.id, e.exercise_order, e.name, e.sets, e.reps]);
    }

    await c.query('COMMIT');
    return { id: Number(session.rows[0].id), startedAt: session.rows[0].started_at };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function sessionExercises(sessionId: number) {
  const { rows } = await pool.query(`
    SELECT se.id, se.exercise_order, se.name, se.planned_sets, se.planned_reps,
      COALESCE(json_agg(json_build_object(
        'setNumber', ws.set_number,
        'weightKg', ws.weight_kg,
        'reps', ws.reps,
        'rir', ws.rir,
        'comment', ws.comment
      ) ORDER BY ws.set_number) FILTER (WHERE ws.id IS NOT NULL), '[]') AS sets
    FROM public.coach_workout_session_exercises se
    LEFT JOIN public.coach_workout_sets ws ON ws.session_exercise_id = se.id
    WHERE se.session_id = $1
    GROUP BY se.id
    ORDER BY se.exercise_order
  `, [sessionId]);
  return rows;
}

async function addSet(exerciseSessionId: number, data: { weightKg: number; reps: number; rir: number | null; comment: string | null }) {
  const next = await pool.query(
    'SELECT COALESCE(MAX(set_number),0)+1 AS n FROM public.coach_workout_sets WHERE session_exercise_id=$1',
    [exerciseSessionId]
  );
  const setNumber = Number(next.rows[0].n);
  const { rows } = await pool.query(`
    INSERT INTO public.coach_workout_sets(session_exercise_id,set_number,weight_kg,reps,rir,comment)
    VALUES($1,$2,$3,$4,$5,$6)
    RETURNING id,set_number,weight_kg,reps,rir,comment
  `, [exerciseSessionId, setNumber, data.weightKg, data.reps, data.rir, data.comment]);
  return rows[0];
}

async function finishSession(sessionId: number, note: string | null) {
  const { rows } = await pool.query(`
    UPDATE public.coach_workout_sessions
    SET completed_at = NOW(), note = $2
    WHERE id = $1 AND completed_at IS NULL
    RETURNING *
  `, [sessionId, note]);
  return rows[0];
}

async function history(clientId: number) {
  const { rows } = await pool.query(`
    SELECT s.id, s.program_name, s.day_name, s.started_at, s.completed_at, s.note,
      COUNT(ws.id)::int AS sets_count
    FROM public.coach_workout_sessions s
    LEFT JOIN public.coach_workout_session_exercises se ON se.session_id = s.id
    LEFT JOIN public.coach_workout_sets ws ON ws.session_exercise_id = se.id
    WHERE s.client_id = $1
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT 20
  `, [clientId]);
  return rows;
}

function esc(v: unknown) {
  return String(v ?? '').replace(/[<>&]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c]!));
}

async function render(ctx: Context, text: string, keyboard?: InlineKeyboard) {
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
      return;
    } catch {}
  }
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

function clientLabel(c: any) {
  return c.telegram_username ? '@' + c.telegram_username : c.name || 'Клиент';
}

async function showClients(ctx: Context) {
  const clients = await dbClients();
  const kb = new InlineKeyboard();
  for (const c of clients) kb.text('👤 ' + clientLabel(c), 'wr:client:' + c.id).row();
  kb.text('🏠 Главное меню', 'main');
  await render(ctx, clients.length ? '🏋️ <b>ВЕДЕНИЕ ТРЕНИРОВОК</b>\n\nВыберите клиента:' : '🏋️ <b>ВЕДЕНИЕ ТРЕНИРОВОК</b>\n\nКлиентов пока нет.', kb);
}

async function showPrograms(ctx: Context, clientId: number) {
  const programs = await dbPrograms(clientId);
  const kb = new InlineKeyboard();
  for (const p of programs) kb.text('📋 ' + p.name, 'wr:program:' + clientId).row();
  kb.text('⬅️ К клиентам', 'wr:clients');
  await render(ctx, programs.length ? '📋 <b>ПРОГРАММА</b>\n\nВыберите программу:' : '📋 <b>ПРОГРАММА</b>\n\nУ клиента нет тренировочной программы.', kb);
}

async function showDays(ctx: Context, clientId: number) {
  const days = await dbDays(clientId);
  const kb = new InlineKeyboard();
  for (const d of days) kb.text('🏋️ День ' + d.day_number + ' — ' + d.name.replace(/^День\s*\d+\s*[—-]?\s*/i,''), 'wr:day:' + clientId + ':' + d.id).row();
  kb.text('⬅️ К программам', 'wr:programs:' + clientId);
  await render(ctx, days.length ? '📅 <b>ТРЕНИРОВОЧНЫЕ ДНИ</b>\n\nВыберите день:' : '📅 Дни программы не созданы.', kb);
}

async function showSession(ctx: Context, clientId: number, sessionId: number) {
  const ex = await sessionExercises(sessionId);
  const lines = ['🏋️ <b>ТРЕНИРОВКА</b>', ''];
  for (const e of ex) {
    lines.push('🏋️ <b>' + esc(e.name) + '</b>  · план: ' + e.planned_sets + ' × ' + esc(e.planned_reps));
    const sets = e.sets as any[];
    if (sets.length) {
      for (const s of sets) lines.push('   ' + s.setNumber + '. ' + s.weightKg + ' кг × ' + s.reps + (s.rir !== null ? ' · RIR ' + s.rir : ''));
    } else {
      lines.push('   Пока нет фактических подходов');
    }
    lines.push('');
  }
  const kb = new InlineKeyboard();
  for (const e of ex) kb.text('➕ ' + e.name, 'wr:set:' + clientId + ':' + sessionId + ':' + e.id).row();
  kb.text('📝 Завершить тренировку', 'wr:finish:' + clientId + ':' + sessionId).row();
  kb.text('⬅️ Назад к дням', 'wr:days:' + clientId);
  await render(ctx, lines.join('\n'), kb);
}

export async function registerWorkoutResults(bot: Bot) {
  await ensureSchema();

  bot.command('workouts', async ctx => showClients(ctx));
  bot.callbackQuery('wr:clients', async ctx => { await ctx.answerCallbackQuery(); await showClients(ctx); });
  bot.callbackQuery(/^wr:client:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    await showPrograms(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^wr:programs:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    await showPrograms(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^wr:program:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    await showDays(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^wr:day:(\d+):(\d+)$/, async ctx => {
    const clientId = Number(ctx.match[1]);
    const dayId = Number(ctx.match[2]);
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('▶️ Начать тренировку', 'wr:start:' + clientId + ':' + dayId).row()
      .text('⬅️ К дням', 'wr:days:' + clientId);
    const exercises = await dbExercises(dayId);
    const lines = ['📅 <b>' + esc(exercises.length ? 'Тренировочный день' : 'Пустой день') + '</b>', ''];
    exercises.forEach((e:any, i:number) => lines.push((i+1) + '. ' + esc(e.name) + ' — ' + e.sets + ' × ' + esc(e.reps)));
    await render(ctx, lines.join('\n'), kb);
  });
  bot.callbackQuery(/^wr:start:(\d+):(\d+)$/, async ctx => {
    const clientId = Number(ctx.match[1]);
    const dayId = Number(ctx.match[2]);
    await ctx.answerCallbackQuery();
    try {
      const session = await createSession(clientId, dayId);
      await render(ctx, '▶️ <b>Тренировка начата</b>\n\nФактические результаты можно записывать по каждому упражнению.', new InlineKeyboard().text('🏋️ К тренировке', 'wr:session:' + clientId + ':' + session.id));
    } catch (e) {
      console.error('[WORKOUT START FAILED]', e);
      await render(ctx, '❌ Не удалось начать тренировку: ' + esc(e instanceof Error ? e.message : String(e)), new InlineKeyboard().text('⬅️ Назад', 'wr:days:' + clientId));
    }
  });
  bot.callbackQuery(/^wr:session:(\d+):(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    await showSession(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
  });
  bot.callbackQuery(/^wr:set:(\d+):(\d+):(\d+)$/, async ctx => {
    const clientId = Number(ctx.match[1]);
    const sessionId = Number(ctx.match[2]);
    const exerciseSessionId = Number(ctx.match[3]);
    await ctx.answerCallbackQuery();
    sessions.set(ctx.from!.id, { clientId, sessionId, exerciseSessionId, step: 'weight' });
    await render(ctx, '➕ <b>Новый фактический подход</b>\n\nВведите рабочий вес в кг.\n\nДля упражнения с собственным весом можно ввести 0.', new InlineKeyboard().text('❌ Отмена', 'wr:session:' + clientId + ':' + sessionId));
  });
  bot.callbackQuery(/^wr:finish:(\d+):(\d+)$/, async ctx => {
    const clientId = Number(ctx.match[1]);
    const sessionId = Number(ctx.match[2]);
    await ctx.answerCallbackQuery();
    sessions.set(ctx.from!.id, { clientId, sessionId });
    await render(ctx, '📝 <b>Завершение тренировки</b>\n\nВведите общий комментарий тренера или нажмите «Без комментария».', new InlineKeyboard()
      .text('⏭ Без комментария', 'wr:finish-none:' + clientId + ':' + sessionId).row()
      .text('❌ Отмена', 'wr:session:' + clientId + ':' + sessionId));
  });
  bot.callbackQuery(/^wr:finish-none:(\d+):(\d+)$/, async ctx => {
    const clientId = Number(ctx.match[1]);
    const sessionId = Number(ctx.match[2]);
    await ctx.answerCallbackQuery();
    const done = await finishSession(sessionId, null);
    sessions.delete(ctx.from!.id);
    await render(ctx, '✅ <b>Тренировка сохранена</b>\n\nФактические результаты записаны.', new InlineKeyboard()
      .text('📚 История тренировок', 'wr:history:' + clientId).row()
      .text('🏋️ Новая тренировка', 'wr:client:' + clientId).row()
      .text('🏠 Главное меню', 'main'));
  });
  bot.callbackQuery(/^wr:history:(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const rows = await history(Number(ctx.match[1]));
    const lines = ['📚 <b>ИСТОРИЯ ТРЕНИРОВОК</b>', ''];
    if (!rows.length) lines.push('Тренировок пока нет.');
    for (const r of rows) {
      lines.push('📅 ' + new Date(r.started_at).toLocaleString('ru-RU'), '🏋️ ' + esc(r.program_name), '📋 ' + esc(r.day_name), 'Подходов: ' + r.sets_count, r.completed_at ? '✅ Завершена' : '🟡 Не завершена', '');
    }
    await render(ctx, lines.join('\n'), new InlineKeyboard().text('⬅️ К клиенту', 'wr:client:' + Number(ctx.match[1])).row().text('🏠 Главное меню', 'main'));
  });
  bot.on('message:text', async ctx => {
    const s = sessions.get(ctx.from!.id);
    if (!s?.step || !s.exerciseSessionId) return;
    const t = ctx.message.text.trim();
    if (t.startsWith('/')) return;
    if (s.step === 'weight') {
      const n = Number(t.replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > 1000) return ctx.reply('Введите вес числом от 0 до 1000 кг.');
      s.pending = { weightKg: n, reps: 0, rir: null };
      s.step = 'reps';
      return ctx.reply('Введите фактическое количество повторений:');
    }
    if (s.step === 'reps') {
      const n = Number(t);
      if (!Number.isInteger(n) || n < 0 || n > 1000) return ctx.reply('Введите целое число повторений от 0 до 1000.');
      s.pending!.reps = n;
      s.step = 'rir';
      return ctx.reply('Введите RIR от 0 до 10 или нажмите «Без RIR».');
    }
    if (s.step === 'rir') {
      if (t.toLowerCase() === 'нет') {
        s.pending!.rir = null;
        s.step = 'comment';
        return ctx.reply('Комментарий к подходу или «Нет»:');
      }
      const n = Number(t.replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > 10) return ctx.reply('Введите RIR от 0 до 10 или «Нет».');
      s.pending!.rir = n;
      s.step = 'comment';
      return ctx.reply('Комментарий к подходу или «Нет»:');
    }
    if (s.step === 'comment') {
      const comment = t.toLowerCase() === 'нет' ? null : t;
      await addSet(s.exerciseSessionId, { ...s.pending!, comment });
      const clientId = s.clientId;
      const sessionId = s.sessionId;
      sessions.delete(ctx.from!.id);
      await render(ctx, '✅ Подход сохранён.', new InlineKeyboard().text('🏋️ Вернуться к тренировке', 'wr:session:' + clientId + ':' + sessionId));
    }
  });
}
