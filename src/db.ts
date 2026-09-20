import pg from 'pg';
import type { Client, ClientDraft, PrimaryAssessment, TrainingStrategy, TrainingProgram, TrainingProgramDay, TrainingProgramExercise, TrainingProgramTemplate, TrainingProgramTemplateDay, TrainingProgramTemplateExercise } from './types.js';

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
export async function seedBaseFullBodyProgram(clientId:number):Promise<void>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await c.query(`INSERT INTO public.coach_training_programs(client_id,name,goal,duration_weeks,comment)
      VALUES($1,$2,$3,NULL,$4)
      ON CONFLICT(client_id) DO UPDATE SET name=EXCLUDED.name,goal=EXCLUDED.goal,duration_weeks=NULL,comment=EXCLUDED.comment,updated_at=NOW()`,
      [clientId,'Full Body — 3 дня в неделю','Базовая сила, гипертрофия, силовая выносливость и полный двигательный баланс','График: Пн — Ср — Пт или Вт — Чт — Сб. Между тренировками — минимум 1 день восстановления.']);
    await c.query('DELETE FROM public.coach_training_program_days WHERE client_id=$1',[clientId]);
    const days=[
      ['День 1 — базовая сила','Базовые многосуставные движения.'],
      ['День 2 — гипертрофия и односторонняя работа','Гипертрофия, односторонняя работа и контроль движения.'],
      ['День 3 — силовая выносливость и полный двигательный баланс','Полный двигательный баланс и силовая выносливость.']
    ];
    const exercises=[
      [['Присед со штангой / гоблет-присед','Квадрицепс, ягодичные',3,'6–8',120,'Отдых: 2–3 мин'],['Жим лёжа','Грудь, трицепс',3,'6–8',120,'Отдых: 2–3 мин'],['Тяга горизонтального блока','Спина, задняя дельта, бицепс',3,'8–10',90,'Отдых: 90–120 сек'],['Румынская тяга','Задняя поверхность бедра, ягодичные',3,'8–10',120,'Отдых: 2 мин'],['Жим гантелей вверх','Плечи, трицепс',2,'8–10',90,'Отдых: 90 сек'],['Сгибание рук с гантелями','Бицепс',2,'10–12',60,'Отдых: 60–90 сек'],['Планка','Мышцы кора',2,'30–45 сек',60,'Отдых: 60 сек']],
      [['Жим ногами','Квадрицепс, ягодичные',3,'8–12',120,'Отдых: 2 мин'],['Жим гантелей на наклонной скамье','Верх груди, трицепс, передняя дельта',3,'8–12',90,'Отдых: 90–120 сек'],['Тяга верхнего блока','Широчайшие, бицепс',3,'8–12',90,'Отдых: 90–120 сек'],['Болгарский сплит-присед','Квадрицепс, ягодичные',2,'8–10 на ногу',90,'Отдых: 90 сек'],['Разведения гантелей в стороны','Средняя дельта',2,'12–15',60,'Отдых: 60–90 сек'],['Сгибание ног в тренажёре','Задняя поверхность бедра',2,'10–15',60,'Отдых: 60–90 сек'],['Dead Bug','Мышцы кора',2,'8–12 на сторону',60,'Отдых: 60 сек']],
      [['Трап-бар / классическая тяга','Ягодичные, задняя поверхность бедра, спина',3,'5–6',120,'Отдых: 2–3 мин'],['Жим в тренажёре / отжимания','Грудь, трицепс, передняя дельта',3,'8–12',90,'Отдых: 90–120 сек'],['Тяга гантели одной рукой','Широчайшие, ромбовидные, бицепс',3,'8–12',90,'Отдых: 90 сек'],['Выпады / шаги на платформу','Квадрицепс, ягодичные',2,'10–12 на ногу',90,'Отдых: 90 сек'],['Ягодичный мост','Ягодичные',2,'10–12',90,'Отдых: 90 сек'],['Face Pull','Задняя дельта, верх спины',2,'12–15',60,'Отдых: 60–90 сек'],['Pallof Press','Мышцы кора',2,'10–12 на сторону',60,'Отдых: 60 сек']]
    ];
    for(let i=0;i<days.length;i++){
      const d=await c.query('INSERT INTO public.coach_training_program_days(client_id,day_number,name,comment) VALUES($1,$2,$3,$4) RETURNING id',[clientId,i+1,days[i][0],days[i][1]]);
      for(let j=0;j<exercises[i].length;j++){
        const e=exercises[i][j];
        await c.query('INSERT INTO public.coach_training_program_exercises(day_id,exercise_order,name,muscle_group,sets,reps,rest_seconds,rir,comment) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8)',[d.rows[0].id,j+1,...e]);
      }
    }
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
export async function migrateStage4TemplateSchema(): Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS public.coach_training_program_templates (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, goal TEXT, duration_weeks INTEGER, comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS public.coach_training_program_template_days (
    id BIGSERIAL PRIMARY KEY, template_id BIGINT NOT NULL REFERENCES public.coach_training_program_templates(id) ON DELETE CASCADE,
    day_number INTEGER NOT NULL, name TEXT NOT NULL, comment TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(template_id,day_number)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS public.coach_training_program_template_exercises (
    id BIGSERIAL PRIMARY KEY, day_id BIGINT NOT NULL REFERENCES public.coach_training_program_template_days(id) ON DELETE CASCADE,
    exercise_order INTEGER NOT NULL, name TEXT NOT NULL, muscle_group TEXT, sets INTEGER NOT NULL, reps TEXT NOT NULL,
    rest_seconds INTEGER, rir NUMERIC, comment TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(day_id,exercise_order)
  )`);
  const {rows}=await pool.query(`INSERT INTO public.coach_training_program_templates(name,goal,duration_weeks,comment)
    VALUES($1,$2,NULL,$3) ON CONFLICT(name) DO UPDATE SET goal=EXCLUDED.goal,comment=EXCLUDED.comment,updated_at=NOW() RETURNING id`,
    ['Full Body — 3 дня в неделю','Базовая сила, гипертрофия, силовая выносливость и полный двигательный баланс','График: Пн — Ср — Пт или Вт — Чт — Сб. Между тренировками — минимум 1 день восстановления.']);
  const templateId=rows[0].id;
  const existing=await pool.query('SELECT COUNT(*)::int AS count FROM public.coach_training_program_template_days WHERE template_id=$1',[templateId]);
  if(existing.rows[0].count===0){
    const days=[
      ['День 1 — базовая сила','Базовые многосуставные движения.'],
      ['День 2 — гипертрофия и односторонняя работа','Гипертрофия, односторонняя работа и контроль движения.'],
      ['День 3 — силовая выносливость и полный двигательный баланс','Полный двигательный баланс и силовая выносливость.']
    ];
    const ex=[
      [['Присед со штангой / гоблет-присед','Квадрицепс, ягодичные',3,'6–8',150],['Жим лёжа','Грудь, трицепс',3,'6–8',150],['Тяга горизонтального блока','Спина, задняя дельта, бицепс',3,'8–10',105],['Румынская тяга','Задняя поверхность бедра, ягодичные',3,'8–10',120],['Жим гантелей вверх','Плечи, трицепс',2,'8–10',90],['Сгибание рук с гантелями','Бицепс',2,'10–12',75],['Планка','Мышцы кора',2,'30–45 сек',60]],
      [['Жим ногами','Квадрицепс, ягодичные',3,'8–12',120],['Жим гантелей на наклонной скамье','Верх груди, трицепс, передняя дельта',3,'8–12',105],['Тяга верхнего блока','Широчайшие, бицепс',3,'8–12',105],['Болгарский сплит-присед','Квадрицепс, ягодичные',2,'8–10 на ногу',90],['Разведения гантелей в стороны','Средняя дельта',2,'12–15',75],['Сгибание ног в тренажёре','Задняя поверхность бедра',2,'10–15',75],['Dead Bug','Мышцы кора',2,'8–12 на сторону',60]],
      [['Трап-бар / классическая тяга','Ягодичные, задняя поверхность бедра, спина',3,'5–6',150],['Жим в тренажёре / отжимания','Грудь, трицепс, передняя дельта',3,'8–12',105],['Тяга гантели одной рукой','Широчайшие, ромбовидные, бицепс',3,'8–12',90],['Выпады / шаги на платформу','Квадрицепс, ягодичные',2,'10–12 на ногу',90],['Ягодичный мост','Ягодичные',2,'10–12',90],['Face Pull','Задняя дельта, верх спины',2,'12–15',75],['Pallof Press','Мышцы кора',2,'10–12 на сторону',60]]
    ];
    for(let i=0;i<days.length;i++){
      const d=await pool.query('INSERT INTO public.coach_training_program_template_days(template_id,day_number,name,comment) VALUES($1,$2,$3,$4) RETURNING id',[templateId,i+1,days[i][0],days[i][1]]);
      for(let j=0;j<ex[i].length;j++){
        const e=ex[i][j];
        await pool.query('INSERT INTO public.coach_training_program_template_exercises(day_id,exercise_order,name,muscle_group,sets,reps,rest_seconds,rir,comment) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,NULL)',[d.rows[0].id,j+1,...e]);
      }
    }
  }
}

  const splitComment=`График:
Пн — Грудь + руки
Ср — Спина + плечи
Пт — Ноги + кор

Интенсивность:
• Базовые упражнения — 3 рабочих подхода
• Изоляция — 2–3 рабочих подхода
• RIR 1–3

Отдых между подходами:
• Базовые упражнения — 2–3 мин
• Изоляция — 60–90 сек

Прогрессия:
Если во всех рабочих подходах достигнут верхний предел повторений при сохранении техники и RIR 1–2:
1. Увеличить рабочий вес на следующей тренировке.
2. Вернуться к нижней границе повторений.
3. Постепенно снова увеличивать количество повторений.

Пример:
Жим 60 кг — 3 × 10
Следующая тренировка — 62,5 кг — 3 × 7–8

Основной принцип:
Постепенно увеличивать рабочие веса и/или количество повторений, не жертвуя техникой выполнения.`;
  const split=await pool.query(`INSERT INTO public.coach_training_program_templates(name,goal,duration_weeks,comment)
    VALUES($1,$2,NULL,$3) ON CONFLICT(name) DO UPDATE SET goal=EXCLUDED.goal,comment=EXCLUDED.comment,updated_at=NOW() RETURNING id`,
    ['Базовый сплит — 3 дня в неделю','Гипертрофия, развитие силы и сбалансированная работа по мышечным группам',splitComment]);
  const splitId=split.rows[0].id;
  const splitCount=await pool.query('SELECT COUNT(*)::int AS count FROM public.coach_training_program_template_days WHERE template_id=$1',[splitId]);
  if(splitCount.rows[0].count===0){
    const splitDays=[
      ['День 1 — Грудь + руки','Грудь, бицепс и трицепс.'],
      ['День 2 — Спина + плечи','Спина, плечевой пояс и разгибатели позвоночника.'],
      ['День 3 — Ноги + кор','Ноги, икроножные и мышцы кора.']
    ];
    const splitEx=[
      [['Жим штанги лёжа','Грудь, трицепс, передняя дельта',3,'6–10',150,2],['Жим гантелей на наклонной скамье','Верх груди, трицепс, передняя дельта',3,'8–12',150,2],['Сведение рук в кроссовере','Грудь',2,'12–15',75,2],['Подъём штанги на бицепс','Бицепс',3,'8–12',75,2],['Разгибание рук на верхнем блоке','Трицепс',3,'10–15',75,2],['Молотковые сгибания с гантелями','Бицепс, плечелучевая мышца',2,'10–12',75,2],['Разгибание руки с гантелью из-за головы','Трицепс',2,'10–15',75,2]],
      [['Подтягивания / вертикальная тяга верхнего блока','Широчайшие, бицепс',3,'6–10',150,2],['Тяга горизонтального блока','Широчайшие, ромбовидные, задняя дельта, бицепс',3,'8–12',150,2],['Тяга гантели одной рукой','Широчайшие, ромбовидные, бицепс',3,'8–12',150,2],['Жим гантелей сидя','Плечи, трицепс',3,'8–12',150,2],['Разведения гантелей в стороны','Средняя дельта',3,'12–15',75,2],['Обратные разведения / тяга каната к лицу','Задняя дельта, верх спины',2,'12–15',75,2],['Гиперэкстензия','Разгибатели позвоночника, ягодичные, задняя поверхность бедра',2,'10–15',75,2]],
      [['Присед со штангой','Квадрицепс, ягодичные, мышцы кора',3,'6–10',150,2],['Румынская тяга','Задняя поверхность бедра, ягодичные',3,'8–12',150,2],['Жим ногами','Квадрицепс, ягодичные',3,'10–12',150,2],['Сгибание ног в тренажёре','Задняя поверхность бедра',2,'10–15',75,2],['Разгибание ног в тренажёре','Квадрицепс',2,'10–15',75,2],['Подъёмы на носки','Икроножные',3,'12–15',75,2],['Скручивания','Мышцы кора',3,'12–20',75,2],['Планка','Мышцы кора',3,'30–60 сек',75,2]]
    ];
    for(let i=0;i<splitDays.length;i++){
      const d=await pool.query('INSERT INTO public.coach_training_program_template_days(template_id,day_number,name,comment) VALUES($1,$2,$3,$4) RETURNING id',[splitId,i+1,splitDays[i][0],splitDays[i][1]]);
      for(let j=0;j<splitEx[i].length;j++){
        const e=splitEx[i][j];
        await pool.query('INSERT INTO public.coach_training_program_template_exercises(day_id,exercise_order,name,muscle_group,sets,reps,rest_seconds,rir,comment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)',[d.rows[0].id,j+1,...e]);
      }
    }
  }


  const split4Comment='График:\nПн — Грудь\nВт — Спина\nЧт — Ноги\nСб — Плечи + руки\n\nИнтенсивность:\n• Базовые упражнения — 3 рабочих подхода\n• Изоляция — 2–3 рабочих подхода\n• RIR 1–3\n• База: отдых 2–3 мин\n• Изоляция: отдых 60–90 сек\n\nПрогрессия:\nРаботаем в заданном диапазоне повторений. Например: жим штанги 60 кг — 3 × 8 → 3 × 9 → 3 × 10. После достижения 3 × 10 увеличить вес и вернуться примерно к 3 × 7–8. Основной принцип: увеличить вес или количество повторений при сохранении техники и RIR 1–2.'; 
  const split4=await pool.query(`INSERT INTO public.coach_training_program_templates(name,goal,duration_weeks,comment)
    VALUES($1,$2,NULL,$3) ON CONFLICT(name) DO UPDATE SET goal=EXCLUDED.goal,comment=EXCLUDED.comment,updated_at=NOW() RETURNING id`,
    ['Базовый сплит — 4 дня в неделю','Гипертрофия, развитие силы и сбалансированная работа по основным мышечным группам',split4Comment]);
  const split4Id=split4.rows[0].id;
  const split4Count=await pool.query('SELECT COUNT(*)::int AS count FROM public.coach_training_program_template_days WHERE template_id=$1',[split4Id]);
  if(split4Count.rows[0].count===0){
    const split4Days=[
      ['День 1 — Грудь','Грудь и трицепс.'],
      ['День 2 — Спина','Широчайшие, верх спины, бицепс и разгибатели позвоночника.'],
      ['День 3 — Ноги','Квадрицепс, задняя поверхность бедра, ягодичные и икроножные.'],
      ['День 4 — Плечи + руки','Плечевой пояс, бицепс и трицепс.']
    ];
    const split4Ex=[
      [['Жим штанги лёжа','Грудь, трицепс, передняя дельта',3,'6–10',150,2],['Жим гантелей на наклонной скамье','Верх груди, трицепс, передняя дельта',3,'8–12',150,2],['Жим в тренажёре','Грудь, трицепс, передняя дельта',3,'8–12',150,2],['Сведение рук в кроссовере','Грудь',3,'12–15',75,2],['Отжимания на брусьях','Грудь, трицепс',2,'8–12',120,2]],
      [['Подтягивания / тяга верхнего блока','Широчайшие, бицепс',3,'6–10',150,2],['Тяга штанги в наклоне','Широчайшие, ромбовидные, задняя дельта, бицепс',3,'6–10',150,2],['Тяга горизонтального блока','Широчайшие, ромбовидные, задняя дельта, бицепс',3,'8–12',150,2],['Тяга гантели одной рукой','Широчайшие, ромбовидные, бицепс',3,'8–12',150,2],['Пуловер в верхнем блоке','Широчайшие',2,'12–15',75,2],['Гиперэкстензия','Разгибатели позвоночника, ягодичные, задняя поверхность бедра',2,'10–15',75,2]],
      [['Присед со штангой','Квадрицепс, ягодичные, мышцы кора',3,'6–10',150,2],['Румынская тяга','Задняя поверхность бедра, ягодичные',3,'8–12',150,2],['Жим ногами','Квадрицепс, ягодичные',3,'10–12',150,2],['Болгарские выпады','Квадрицепс, ягодичные',2,'8–12 на каждую ногу',120,2],['Сгибание ног в тренажёре','Задняя поверхность бедра',3,'10–15',75,2],['Разгибание ног в тренажёре','Квадрицепс',2,'10–15',75,2],['Подъёмы на носки','Икроножные',3,'12–15',75,2]],
      [['Жим гантелей сидя','Плечи, трицепс',3,'8–12',150,2],['Разведения гантелей в стороны','Средняя дельта',3,'12–15',75,2],['Обратные разведения / обратная бабочка','Задняя дельта, верх спины',3,'12–15',75,2],['Подъём штанги на бицепс','Бицепс',3,'8–12',75,2],['Молотковые сгибания','Бицепс, плечелучевая мышца',2,'10–12',75,2],['Разгибание рук на верхнем блоке','Трицепс',3,'10–15',75,2],['Разгибание руки из-за головы с канатом','Трицепс',2,'10–15',75,2]]
    ];
    for(let i=0;i<split4Days.length;i++){
      const d=await pool.query('INSERT INTO public.coach_training_program_template_days(template_id,day_number,name,comment) VALUES($1,$2,$3,$4) RETURNING id',[split4Id,i+1,split4Days[i][0],split4Days[i][1]]);
      for(let j=0;j<split4Ex[i].length;j++){
        const e=split4Ex[i][j];
        await pool.query('INSERT INTO public.coach_training_program_template_exercises(day_id,exercise_order,name,muscle_group,sets,reps,rest_seconds,rir,comment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)',[d.rows[0].id,j+1,...e]);
      }
    }
  }


  const fullBody2Comment=`График:
Пн — Тренировка А
Чт/Пт — Тренировка B

Между тренировками — минимум 2 дня восстановления.

Интенсивность:
• Основные упражнения — RIR 2–3
• Изоляция — RIR 1–2
• База — отдых 2–3 мин
• Изоляция — отдых 60–90 сек

Прогрессия:
Использовать двойную прогрессию.

Пример:
Жим 60 кг — 3 × 8
→ 3 × 9
→ 3 × 10

После достижения верхней границы:
увеличить вес и снова начать с нижней границы повторений.

Главный критерий:
прогрессировать в весе или повторениях, сохраняя технику и заданный RIR.`;
  const fullBody2=await pool.query(`INSERT INTO public.coach_training_program_templates(name,goal,duration_weeks,comment)
    VALUES($1,$2,NULL,$3) ON CONFLICT(name) DO UPDATE SET goal=EXCLUDED.goal,comment=EXCLUDED.comment,updated_at=NOW() RETURNING id`,
    ['Full Body — 2 дня в неделю','Развитие силы и мышечной массы при двух тренировках в неделю',fullBody2Comment]);
  const fullBody2Id=fullBody2.rows[0].id;
  const fullBody2Count=await pool.query('SELECT COUNT(*)::int AS count FROM public.coach_training_program_template_days WHERE template_id=$1',[fullBody2Id]);
  if(fullBody2Count.rows[0].count===0){
    const fullBody2Days=[
      ['Тренировка А — Full Body','Полноценная тренировка всего тела.'],
      ['Тренировка B — Full Body','Полноценная тренировка всего тела.']
    ];
    const fullBody2Ex=[
      [['Присед со штангой','Квадрицепс, ягодичные, мышцы кора',3,'6–10',150,2],['Жим штанги лёжа','Грудь, трицепс, передняя дельта',3,'6–10',150,2],['Тяга горизонтального блока','Широчайшие, ромбовидные, задняя дельта, бицепс',3,'8–12',150,2],['Румынская тяга','Задняя поверхность бедра, ягодичные',2,'8–12',150,2],['Жим гантелей сидя','Плечи, трицепс',2,'8–12',120,2],['Сгибание рук с гантелями','Бицепс',2,'10–15',75,1],['Скручивания','Мышцы кора',2,'12–20',60,1]],
      [['Жим ногами','Квадрицепс, ягодичные',3,'8–12',150,2],['Жим гантелей на наклонной скамье','Верх груди, трицепс, передняя дельта',3,'8–12',150,2],['Тяга верхнего блока','Широчайшие, бицепс',3,'8–12',150,2],['Ягодичный мост / хип-траст','Ягодичные, задняя поверхность бедра',2,'8–12',150,2],['Разведения гантелей в стороны','Средняя дельта',2,'12–15',75,1],['Разгибание рук на верхнем блоке','Трицепс',2,'10–15',75,1],['Планка','Мышцы кора',3,'30–60 сек',60,1]]
    ];
    for(let i=0;i<fullBody2Days.length;i++){
      const d=await pool.query('INSERT INTO public.coach_training_program_template_days(template_id,day_number,name,comment) VALUES($1,$2,$3,$4) RETURNING id',[fullBody2Id,i+1,fullBody2Days[i][0],fullBody2Days[i][1]]);
      for(let j=0;j<fullBody2Ex[i].length;j++){
        const e=fullBody2Ex[i][j];
        await pool.query('INSERT INTO public.coach_training_program_template_exercises(day_id,exercise_order,name,muscle_group,sets,reps,rest_seconds,rir,comment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)',[d.rows[0].id,j+1,...e]);
      }
    }
  }

  const upperLower2Comment=`График:
Пн — Верх тела
Чт — Низ тела

Между тренировками — минимум 2 дня восстановления.

Интенсивность:
• Базовые упражнения — RIR 2–3
• Изоляция — RIR 1–2
• Базовые упражнения — отдых 2–3 мин
• Изоляция — отдых 60–90 сек

Прогрессия:
Работать в заданном диапазоне повторений.

Пример:
Жим штанги — 60 кг
3 × 8 → 3 × 9 → 3 × 10

После достижения верхней границы:
увеличить вес и вернуться к нижней границе повторений.

Главный принцип:
↑ вес или ↑ повторения
при сохранении техники и заданного RIR.`;
  const upperLower2=await pool.query(`INSERT INTO public.coach_training_program_templates(name,goal,duration_weeks,comment)
    VALUES($1,$2,NULL,$3) ON CONFLICT(name) DO UPDATE SET goal=EXCLUDED.goal,comment=EXCLUDED.comment,updated_at=NOW() RETURNING id`,
    ['Базовая программа Upper / Lower — 2 дня в неделю','Развитие силы и мышечной массы при двух тренировках в неделю',upperLower2Comment]);
  const upperLower2Id=upperLower2.rows[0].id;
  const upperLower2Count=await pool.query('SELECT COUNT(*)::int AS count FROM public.coach_training_program_template_days WHERE template_id=$1',[upperLower2Id]);
  if(upperLower2Count.rows[0].count===0){
    const upperLower2Days=[
      ['День 1 — Верх тела','Грудь, спина, плечи, бицепс и трицепс.'],
      ['День 2 — Низ тела','Квадрицепс, задняя поверхность бедра, ягодичные, икроножные и мышцы кора.']
    ];
    const upperLower2Ex=[
      [
        ['Жим штанги лёжа','Грудь, трицепс, передняя дельта',3,'6–10',150,2],
        ['Тяга верхнего блока / подтягивания','Широчайшие, бицепс',3,'8–12',150,2],
        ['Жим гантелей на наклонной скамье','Верх груди, трицепс, передняя дельта',2,'8–12',150,2],
        ['Тяга горизонтального блока','Широчайшие, ромбовидные, задняя дельта, бицепс',3,'8–12',150,2],
        ['Жим гантелей сидя','Плечи, трицепс',2,'8–12',120,2],
        ['Разведения гантелей в стороны','Средняя дельта',2,'12–15',75,1],
        ['Сгибание рук с гантелями','Бицепс',2,'10–15',75,1],
        ['Разгибание рук на верхнем блоке','Трицепс',2,'10–15',75,1]
      ],
      [
        ['Присед со штангой','Квадрицепс, ягодичные, мышцы кора',3,'6–10',150,2],
        ['Румынская тяга','Задняя поверхность бедра, ягодичные',3,'8–12',150,2],
        ['Жим ногами','Квадрицепс, ягодичные',3,'10–12',150,2],
        ['Болгарские выпады','Квадрицепс, ягодичные',2,'8–12 на каждую ногу',120,2],
        ['Сгибание ног в тренажёре','Задняя поверхность бедра',2,'10–15',75,1],
        ['Разгибание ног в тренажёре','Квадрицепс',2,'10–15',75,1],
        ['Подъёмы на носки','Икроножные',3,'12–15',75,1],
        ['Скручивания','Мышцы кора',3,'12–20',60,1]
      ]
    ];
    for(let i=0;i<upperLower2Days.length;i++){
      const d=await pool.query('INSERT INTO public.coach_training_program_template_days(template_id,day_number,name,comment) VALUES($1,$2,$3,$4) RETURNING id',[upperLower2Id,i+1,upperLower2Days[i][0],upperLower2Days[i][1]]);
      for(let j=0;j<upperLower2Ex[i].length;j++){
        const e=upperLower2Ex[i][j];
        await pool.query('INSERT INTO public.coach_training_program_template_exercises(day_id,exercise_order,name,muscle_group,sets,reps,rest_seconds,rir,comment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)',[d.rows[0].id,j+1,...e]);
      }
    }
  }

export async function listTrainingProgramTemplates():Promise<TrainingProgramTemplate[]>{const {rows}=await pool.query<TrainingProgramTemplate>('SELECT * FROM public.coach_training_program_templates ORDER BY name');return rows;}
export async function getTrainingProgramTemplate(id:number):Promise<TrainingProgramTemplate|null>{const {rows}=await pool.query<TrainingProgramTemplate>('SELECT * FROM public.coach_training_program_templates WHERE id=$1',[id]);return rows[0]??null;}
export async function listTrainingProgramTemplateDays(templateId:number):Promise<TrainingProgramTemplateDay[]>{const {rows}=await pool.query<TrainingProgramTemplateDay[]>('SELECT * FROM public.coach_training_program_template_days WHERE template_id=$1 ORDER BY day_number',[templateId]);return rows as any;}
export async function listTrainingProgramTemplateExercises(dayId:number):Promise<TrainingProgramTemplateExercise[]>{const {rows}=await pool.query<TrainingProgramTemplateExercise[]>('SELECT * FROM public.coach_training_program_template_exercises WHERE day_id=$1 ORDER BY exercise_order');return rows as any;}
export async function applyTrainingProgramTemplate(clientId:number,templateId:number):Promise<TrainingProgram>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const t=await c.query<TrainingProgramTemplate>('SELECT * FROM public.coach_training_program_templates WHERE id=$1',[templateId]);
    if(!t.rows[0])throw new Error('Template not found');
    const x=t.rows[0];
    const p=await c.query<TrainingProgram>(`INSERT INTO public.coach_training_programs(client_id,name,goal,duration_weeks,comment) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(client_id) DO UPDATE SET name=EXCLUDED.name,goal=EXCLUDED.goal,duration_weeks=EXCLUDED.duration_weeks,comment=EXCLUDED.comment,updated_at=NOW() RETURNING *`,
      [clientId,x.name,x.goal,x.duration_weeks,x.comment]);
    await c.query('DELETE FROM public.coach_training_program_days WHERE client_id=$1',[clientId]);
    const days=await c.query('SELECT * FROM public.coach_training_program_template_days WHERE template_id=$1 ORDER BY day_number',[templateId]);
    for(const d of days.rows){
      const nd=await c.query('INSERT INTO public.coach_training_program_days(client_id,day_number,name,comment) VALUES($1,$2,$3,$4) RETURNING id',[clientId,d.day_number,d.name,d.comment]);
      const ex=await c.query('SELECT * FROM public.coach_training_program_template_exercises WHERE day_id=$1 ORDER BY exercise_order',[d.id]);
      for(const e of ex.rows)await c.query('INSERT INTO public.coach_training_program_exercises(day_id,exercise_order,name,muscle_group,sets,reps,rest_seconds,rir,comment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[nd.rows[0].id,e.exercise_order,e.name,e.muscle_group,e.sets,e.reps,e.rest_seconds,e.rir,e.comment]);
    }
    await c.query('COMMIT');return p.rows[0];
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
export async function updateTrainingProgramExercise(e:{id:number;name:string;muscle_group:string|null;sets:number;reps:string;rest_seconds:number|null;rir:number|null;comment:string|null}):Promise<TrainingProgramExercise|null>{const {rows}=await pool.query<TrainingProgramExercise>(`UPDATE public.coach_training_program_exercises SET name=$2,muscle_group=$3,sets=$4,reps=$5,rest_seconds=$6,rir=$7,comment=$8 WHERE id=$1 RETURNING *`,[e.id,e.name,e.muscle_group,e.sets,e.reps,e.rest_seconds,e.rir,e.comment]);return rows[0]??null;}
export async function updateTrainingProgramName(clientId:number,name:string):Promise<TrainingProgram|null>{const {rows}=await pool.query<TrainingProgram>('UPDATE public.coach_training_programs SET name=$2,updated_at=NOW() WHERE client_id=$1 RETURNING *',[clientId,name]);return rows[0]??null;}
export async function listProgramCatalogMuscles():Promise<string[]>{const {rows}=await pool.query<{muscle_group:string}>('SELECT DISTINCT muscle_group FROM public.coach_training_program_template_exercises WHERE muscle_group IS NOT NULL AND TRIM(muscle_group)<>\'\' ORDER BY muscle_group');return rows.map(r=>r.muscle_group);}
export async function listProgramCatalogExercises(muscleGroup:string):Promise<{id:number;name:string;muscle_group:string}[]>{const {rows}=await pool.query<{id:number;name:string;muscle_group:string}>(`SELECT MIN(id)::int AS id,name,muscle_group FROM public.coach_training_program_template_exercises WHERE muscle_group=$1 GROUP BY name,muscle_group ORDER BY name`,[muscleGroup]);return rows;}
export async function replaceTrainingProgramExercise(id:number,name:string,muscleGroup:string):Promise<TrainingProgramExercise|null>{const {rows}=await pool.query<TrainingProgramExercise>('UPDATE public.coach_training_program_exercises SET name=$2,muscle_group=$3 WHERE id=$1 RETURNING *',[id,name,muscleGroup]);return rows[0]??null;}
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

