import type { Pool } from 'pg';
import { ANATOMY_EXERCISES, ANATOMY_CATALOG_VERSION } from './anatomy-exercise-catalog.js';

const CATALOG_VERSION = '2026-09-r4';
const SOURCE_JSON = 'https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/data/exercises.json';
const MEDIA_BASE = 'https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/';

function norm(value: string) {
  return String(value ?? '').toLowerCase().replace(/ё/g, 'е').trim();
}

function bodyPartRu(value: string) {
  const map: Record<string,string> = {
    'upper legs':'Ноги','back':'Спина','chest':'Грудь','shoulders':'Плечи','waist':'Кор',
    'lower legs':'Голени','upper arms':'Плечи и руки','lower arms':'Предплечья','cardio':'Кардио','neck':'Шея'
  };
  return map[value] ?? value;
}

function equipmentRu(value: string) {
  const map: Record<string,string> = {
    'body weight':'Собственный вес','dumbbell':'Гантели','barbell':'Штанга','cable':'Блок',
    'leverage machine':'Тренажёр','smith machine':'Машина Смита','kettlebell':'Гиря',
    'ez barbell':'EZ-штанга','band':'Резинка','stability ball':'Фитбол','weighted':'Дополнительный вес',
    'assisted':'Тренажёр с противовесом','other':'Другое'
  };
  return map[value] ?? value;
}

function muscleRu(value: string, target: string) {
  const text = norm(value + ' ' + target);
  if (/pector|chest/.test(text)) return 'Грудные мышцы';
  if (/lat|dorsi|back/.test(text)) return 'Мышцы спины';
  if (/deltoid|shoulder/.test(text)) return 'Дельтовидные мышцы';
  if (/biceps/.test(text)) return 'Бицепс';
  if (/triceps/.test(text)) return 'Трицепс';
  if (/forearm/.test(text)) return 'Предплечья';
  if (/quad/.test(text)) return 'Квадрицепс';
  if (/hamstring/.test(text)) return 'Задняя поверхность бедра';
  if (/glute/.test(text)) return 'Ягодичные мышцы';
  if (/calf/.test(text)) return 'Икроножные мышцы';
  if (/abs|oblique|core/.test(text)) return 'Мышцы кора';
  if (/hip flexor/.test(text)) return 'Сгибатели бедра';
  if (/trap|trapezius/.test(text)) return 'Трапеции';
  return bodyPartRu(value || target);
}

function nameRu(name: string) {
  const n = norm(name);
  const map: Array<[RegExp,string]> = [
    [/barbell.*bench press|bench press|chest press/, 'Жим лёжа'],
    [/incline.*bench press|incline.*press/, 'Жим лёжа на наклонной скамье'],
    [/decline.*bench press|decline.*press/, 'Жим лёжа на отрицательном наклоне'],
    [/barbell.*squat|full squat/, 'Приседание со штангой'],
    [/goblet squat/, 'Гоблет-присед'],
    [/bodyweight squat|body weight squat|air squat/, 'Приседание с собственным весом'],
    [/hack squat/, 'Гакк-приседание'],
    [/split squat/, 'Болгарский сплит-присед'],
    [/leg press/, 'Жим ногами'],
    [/leg extension/, 'Разгибание ног в тренажёре'],
    [/leg curl|inverse leg curl/, 'Сгибание ног в тренажёре'],
    [/romanian deadlift|rdl/, 'Румынская тяга'],
    [/stiff leg deadlift/, 'Тяга на прямых ногах'],
    [/deadlift/, 'Становая тяга'],
    [/good morning/, 'Наклон Good Morning'],
    [/hip thrust|glute bridge/, 'Ягодичный мост'],
    [/pull-up|pull up|chin-up|chin up/, 'Подтягивания'],
    [/lat pulldown|pulldown/, 'Тяга верхнего блока'],
    [/seated row|cable row|machine row|bent over row|barbell row|dumbbell row/, 'Тяга к поясу'],
    [/t-bar row/, 'Тяга Т-грифа'],
    [/push-up|push up/, 'Отжимания'],
    [/dip/, 'Отжимания на брусьях'],
    [/dumbbell.*shoulder press|shoulder press|overhead press/, 'Жим гантелей над головой'],
    [/lateral raise/, 'Разведения гантелей в стороны'],
    [/front raise/, 'Подъём гантелей перед собой'],
    [/rear delt|reverse fly|rear fly/, 'Разведения на заднюю дельту'],
    [/biceps curl|hammer curl|preacher curl/, 'Сгибание рук на бицепс'],
    [/triceps extension|triceps pushdown|skull crusher/, 'Разгибание рук на трицепс'],
    [/calf raise|standing calf|seated calf/, 'Подъём на носки'],
    [/reverse lunge/, 'Выпады назад'],
    [/walking lunge|forward lunge/, 'Выпады вперёд'],
    [/step-up/, 'Зашагивания на платформу'],
    [/crunch|sit-up/, 'Скручивания'],
    [/leg raise|knee raise/, 'Подъём ног'],
    [/dead bug/, 'Dead Bug'],
    [/bird dog/, 'Bird Dog'],
    [/back extension|hyperextension/, 'Разгибание спины'],
    [/chest fly|pec deck|fly/, 'Сведение рук для груди'],
    [/shrug/, 'Шраги'],
    [/farmer walk|farmer carry/, 'Прогулка фермера'],
    [/burpee/, 'Берпи'],
    [/mountain climber/, 'Скалолаз'],
    [/jumping jack/, 'Прыжки «джампинг-джек»'],
    [/high knees/, 'Бег с высоким подниманием коленей'],
    [/box jump/, 'Запрыгивания на платформу'],
    [/russian twist/, 'Русские скручивания'],
    [/pallof press/, 'Pallof Press'],
    [/plank/, 'Планка'],
    [/stretch|mobility/, 'Упражнение на мобильность']
  ];
  const hit = map.find(([p]) => p.test(n));
  if (hit) return hit[1];
  if (/biceps|curl/.test(n)) return 'Сгибание рук на бицепс';
  if (/triceps|extension/.test(n)) return 'Разгибание рук на трицепс';
  if (/calf/.test(n)) return 'Подъём на носки';
  if (/glute/.test(n)) return 'Упражнение для ягодичных мышц';
  if (/hamstring/.test(n)) return 'Упражнение для задней поверхности бедра';
  if (/quadriceps|quad/.test(n)) return 'Упражнение для квадрицепса';
  if (/chest|pector/.test(n)) return 'Упражнение для груди';
  if (/back|lat/.test(n)) return 'Упражнение для мышц спины';
  if (/shoulder|deltoid/.test(n)) return 'Упражнение для плеч';
  if (/abs|waist|core/.test(n)) return 'Упражнение для мышц кора';
  return 'Функциональное упражнение';
}

function movementPattern(name: string, category: string, target: string) {
  const text = norm(name + ' ' + category + ' ' + target);
  if (/squat|leg press|lunge|step-up|присед|выпад/.test(text)) return 'приседание';
  if (/deadlift|good morning|hinge|rdl|станов|наклон/.test(text)) return 'тазобедренный шарнир';
  if (/bench press|push-up|push up|chest press|dip|жим|отжим/.test(text)) return 'горизонтальный жим';
  if (/shoulder press|overhead press|lateral raise|front raise|жим над головой/.test(text)) return 'вертикальный жим / плечи';
  if (/pull-up|pull up|lat pulldown|pulldown|подтяг/.test(text)) return 'вертикальная тяга';
  if (/row|тяга|pullover/.test(text)) return 'горизонтальная тяга';
  if (/curl|biceps|сгибан/.test(text)) return 'сгибание локтя';
  if (/triceps|extension|разгибан/.test(text)) return 'разгибание локтя';
  if (/crunch|sit-up|leg raise|dead bug|plank|скручив|пресс/.test(text)) return 'кор';
  if (category === 'cardio') return 'кардио';
  if (/stretch|mobility|растяж|мобил/.test(text)) return 'мобильность';
  return 'прочее';
}

function level(name: string, target: string) {
  const text = norm(name + ' ' + target);
  if (/muscle up|handstand|pistol|snatch|clean and jerk|dragon flag|human flag|one arm/.test(text)) return 'advanced';
  if (/pull-up|pull up|deadlift|barbell squat|подтяг|станов/.test(text)) return 'intermediate';
  return 'beginner';
}

function trainingTypes(name: string, category: string, equipment: string, target: string, muscleGroup: string) {
  const text = norm([name, category, target, muscleGroup].join(' '));
  const types = new Set<string>(['maintenance']);
  if (category === 'cardio' || /run|running|jump|burpee|mountain climber|high knees|cycling|rowing|sprint|бег|прыж/.test(text)) {
    types.add('endurance'); types.add('conditioning');
  }
  if (/bench press|squat|deadlift|row|pull-up|pull up|press|жим|присед|тяга|подтяг/.test(text) || !['body weight','band'].includes(equipment)) {
    types.add('strength'); types.add('hypertrophy');
  }
  if (/curl|extension|raise|fly|kickback|разгиб|сгиб|развед|подъем/.test(text)) types.add('hypertrophy');
  if (/jump|plyometric|sprint|clean|snatch|jerk|прыж|спринт/.test(text)) types.add('power');
  if (/stretch|mobility|rotation|yoga|гибк|мобил|растяж|вращен/.test(text)) {
    types.add('mobility'); types.add('recovery');
  }
  if (equipment === 'body weight' && category !== 'cardio') types.add('endurance');
  if (/dead bug|bird dog|breathing|дых/.test(text)) types.add('recovery');
  return [...types];
}

function trainingContexts(name: string, category: string, equipment: string, target: string, muscleGroup: string, movement: string) {
  const text = norm([name, category, target, muscleGroup, movement].join(' '));
  const bodyweight = equipment === 'body weight';
  const fullBody = bodyweight && (
    /squat|lunge|step-up|push-up|push up|pull-up|pull up|burpee|mountain climber|jumping jack|high knees|bear crawl|crawl|farmer|carry/.test(text) ||
    ['приседание','горизонтальный жим','вертикальная тяга','кардио'].includes(movement)
  );
  const contexts = new Set<string>();
  if (fullBody) contexts.add('full_body');
  if (fullBody || /carry|squat|lunge|hinge|push|pull|press|row|crawl|rotation|координац/.test(text)) contexts.add('functional');
  if (
    bodyweight &&
    /arm circle|shoulder circle|march|walk|step|lunge|squat|mobility|stretch|dynamic|jumping jack|high knees|rotation|dead bug|bird dog|легк|мобил|растяж/.test(text)
  ) contexts.add('warmup');
  if (bodyweight && !/barbell|dumbbell|machine|cable|kettlebell|band/.test(text)) contexts.add('home');
  if (bodyweight && /pull-up|pull up|chin-up|dip|bar|hanging|подтяг|брусь/.test(text)) contexts.add('outdoor');
  if (bodyweight && fullBody) contexts.add('outdoor');
  return [...contexts];
}

export async function syncAnatomyExerciseCatalog(pool: Pool) {
  const mediaForExercise = (_ex: typeof ANATOMY_EXERCISES[number]) => ({ gifUrl: '', imageUrl: '' });

  // The workbook is the source of truth for the program generator.
  // Remove the previous generated anatomy catalog so stale exercises cannot leak
  // into new programs or correction choices.
  await pool.query(`UPDATE exercise_library SET gif_url='', image_url=''`);
  await pool.query(`DELETE FROM exercise_library WHERE id LIKE 'anat-%' OR id LIKE 'base-%'`);

  for (const ex of ANATOMY_EXERCISES) {
    const media = mediaForExercise(ex);
    const trainingTypes = ex.typeRu.includes('Базовое')
      ? ['maintenance','strength','hypertrophy']
      : ['maintenance','hypertrophy'];
    const level = ex.levelRu === 'Средний' ? 'intermediate' : 'beginner';
    const contexts = [
      ex.environment,
      ...(ex.environment === 'outdoor' ? ['functional'] : []),
      ...(/присед|выпад|тяга|жим|подтяг|отжим|шарнир|анти-|ротац|стабилиз|step-up/i.test(ex.primaryAction + ' ' + ex.name) ? ['functional'] : [])
    ];

    await pool.query(
      `INSERT INTO exercise_library
        (id,name,category,equipment,target,muscle_group,secondary_muscles,instructions_ru,source_url,
         gif_url,image_url,name_ru,body_part_ru,equipment_ru,muscle_group_ru,training_types,movement_pattern,level,
         catalog_version,training_contexts,gif_verified)
       VALUES ($1,$2,$3,$4,$5,$6,'[]'::jsonb,$7,$8,$9,$10,$2,$11,$12,$13,$14::jsonb,$15,$16,$17,$18::jsonb,$19)`,
      [
        ex.id,
        ex.name,
        ex.category,
        ex.environment === 'gym' ? 'gym' : 'body weight',
        ex.muscle,
        ex.muscleGroup,
        ex.notes,
        'workbook-anatomo-trenirovochnaya-baza.xlsx',
        media.gifUrl,
        media.imageUrl,
        ex.muscle,
        ex.equipmentRu,
        ex.muscleGroup,
        JSON.stringify(trainingTypes),
        ex.primaryAction,
        level,
        ANATOMY_CATALOG_VERSION,
        JSON.stringify([...new Set(contexts)]),
        Boolean(media.gifUrl)
      ]
    );
  }

  await pool.query(
    `INSERT INTO exercise_catalog_meta(key,value) VALUES('anatomy_version',$1)
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    [ANATOMY_CATALOG_VERSION]
  );

  // Existing programs were generated from the previous mixed catalog.
  // On the first startup with the workbook catalog, invalidate them once so
  // the trainer never reopens a stale program after this migration.
  const programVersion = await pool.query(
    `SELECT value FROM exercise_catalog_meta WHERE key='program_source_version'`
  );
  if (programVersion.rows[0]?.value !== ANATOMY_CATALOG_VERSION) {
    await pool.query('DELETE FROM training_programs');
    await pool.query(
      `INSERT INTO exercise_catalog_meta(key,value) VALUES('program_source_version',$1)
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
      [ANATOMY_CATALOG_VERSION]
    );
    console.log('Old training programs invalidated for workbook catalog migration');
  }

  console.log('Training workbook catalog synchronized:', ANATOMY_EXERCISES.length);
}

export async function syncExerciseCatalog(pool: Pool) {
  const metaTable = 'exercise_catalog_meta';
  await pool.query('CREATE TABLE IF NOT EXISTS exercise_catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await pool.query("ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS training_contexts JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE exercise_library ADD COLUMN IF NOT EXISTS gif_verified BOOLEAN NOT NULL DEFAULT FALSE");
  const meta = await pool.query('SELECT value FROM exercise_catalog_meta WHERE key=$1', ['version']);
  if (meta.rows[0]?.value === CATALOG_VERSION) {
    await pool.query(`UPDATE exercise_library SET gif_url='', image_url='', gif_verified=FALSE`);
    return;
  }

  const response = await fetch(SOURCE_JSON, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`Exercise catalog HTTP ${response.status}`);
  const data = await response.json() as any[];

  for (const ex of data) {
    const id = String(ex.id ?? '');
    if (!id) continue;
    const name = String(ex.name ?? '');
    const category = String(ex.category ?? '');
    const equipment = String(ex.equipment ?? '');
    const target = String(ex.target ?? '');
    const muscleGroup = String(ex.muscle_group ?? '');
    const mediaId = String(ex.media_id ?? '');
    const gifUrl = '';
    const imageUrl = '';
    const movement = movementPattern(name, category, target);

    await pool.query(
      `UPDATE exercise_library SET
        name_ru=$2, body_part_ru=$3, equipment_ru=$4, muscle_group_ru=$5,
        training_types=$6::jsonb, movement_pattern=$7, level=$8, media_id=$9,
        gif_url='', image_url='', gif_verified=FALSE,
        attribution=$10, catalog_version=$11, training_contexts=$12::jsonb
       WHERE id=$1`,
      [
        id, nameRu(name), bodyPartRu(category), equipmentRu(equipment), muscleRu(muscleGroup,target),
        JSON.stringify(trainingTypes(name,category,equipment,target,muscleGroup)),
        movement, level(name,target), mediaId,
        '© Gym visual — https://gymvisual.com/', CATALOG_VERSION,
        JSON.stringify(trainingContexts(name,category,equipment,target,muscleGroup,movement))
      ]
    );
  }

  await pool.query(
    `INSERT INTO exercise_catalog_meta(key,value) VALUES('version',$1)
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    [CATALOG_VERSION]
  );
  await pool.query(`UPDATE exercise_library SET gif_url='', image_url='', gif_verified=FALSE`);
  console.log('Exercise catalog synchronized:', data.length);
}
