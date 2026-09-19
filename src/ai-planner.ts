export type AIPlannerProfile = {
  goal: string;
  experience: string;
  location: string;
  workoutsPerWeek: number;
  workoutDuration: number;
  limitations: string;
  trainingFocus: string;
};

export type AIExerciseCandidate = {
  id: string;
  nameRu: string;
  bodyPartRu: string;
  equipmentRu: string;
  muscleGroupRu: string;
  trainingTypes: string[];
  movementPattern: string;
  level: string;
  instructionsRu: string;
};

export type AIPlanExercise = {
  exerciseId: string;
  sets: number;
  reps: string;
  rest: string;
  tempo: string;
  comment: string;
};

export type AIPlanDay = {
  day: number;
  title: string;
  focus: string;
  warmup: string;
  exercises: AIPlanExercise[];
  cooldown: string;
};

export type AIWorkoutPlan = {
  title: string;
  format: string;
  rationale: string;
  progression: string;
  notes: string[];
  days: AIPlanDay[];
};

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? 'gpt-5.6-luna';


const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    format: { type: 'string' },
    rationale: { type: 'string' },
    progression: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
    days: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          day: { type: 'integer' },
          title: { type: 'string' },
          focus: { type: 'string' },
          warmup: { type: 'string' },
          exercises: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                exerciseId: { type: 'string' },
                sets: { type: 'integer' },
                reps: { type: 'string' },
                rest: { type: 'string' },
                tempo: { type: 'string' },
                comment: { type: 'string' }
              },
              required: ['exerciseId', 'sets', 'reps', 'rest', 'tempo', 'comment']
            }
          },
          cooldown: { type: 'string' }
        },
        required: ['day', 'title', 'focus', 'warmup', 'exercises', 'cooldown']
      }
    }
  },
  required: ['title', 'format', 'rationale', 'progression', 'notes', 'days']
} as const;

function ruGoal(value: string) {
  return ({ loss: 'похудение', mass: 'набор мышечной массы', health: 'здоровье и общая физическая форма' } as Record<string, string>)[value] ?? value;
}

function ruExperience(value: string) {
  return ({ beginner: 'новичок', under1: 'до 1 года', '1to3': '1–3 года', '3plus': '3+ года' } as Record<string, string>)[value] ?? value;
}

function ruLocation(value: string) {
  return ({ gym: 'тренажёрный зал', home: 'дом', outdoor: 'спортивная площадка/улица', mixed: 'смешанный формат' } as Record<string, string>)[value] ?? value;
}

function catalogText(exercises: AIExerciseCandidate[]) {
  return exercises.map((e) => [
    'ID=' + e.id,
    'название=' + e.nameRu,
    'зона=' + e.bodyPartRu,
    'оборудование=' + e.equipmentRu,
    'мышцы=' + e.muscleGroupRu,
    'типы=' + e.trainingTypes.join(','),
    'паттерн=' + e.movementPattern,
    'уровень=' + e.level,
    'техника=' + e.instructionsRu.slice(0, 500)
  ].join(' | ')).join('\n');
}

function buildInstructions(profile: AIPlannerProfile, exercises: AIExerciseCandidate[], correction: string, allExerciseNames: string[]) {
  const methods = [
    'full body',
    'upper/lower',
    'push/pull/legs',
    'body-part split',
    'circuit training',
    'interval/conditioning',
    'strength-focused',
    'hypertrophy-focused',
    'endurance-focused',
    'functional training',
    'mobility/recovery',
    'concurrent strength + cardio'
  ];

  const modalities = [
    'собственный вес',
    'свободные веса',
    'гантели',
    'штанга',
    'гири',
    'блочные тренажёры',
    'силовые тренажёры',
    'кардио-тренажёры',
    'резиновые ленты',
    'подвесные системы',
    'спортивная площадка/турники/брусья',
    'домашняя тренировка',
    'партнёрская/ассистированная работа',
    'работа со страховкой/споттером'
  ];

  return [
    'Ты — AI-модуль программирования тренировок для профессионального фитнес-тренера.',
    'Твоя задача — составить практичный индивидуальный план, а не просто список упражнений.',
    'Используй только упражнения из переданного каталога. Никогда не придумывай exerciseId.',
    'Выбирай формат, структуру недели, порядок упражнений, объём, повторения, отдых и прогрессию под профиль.',
    'Подбирай упражнения с учётом цели, опыта, места, времени, доступного каталога и ограничений.',
    'Не используй упражнение, если оно явно конфликтует с ограничениями клиента.',
    'Если ограничение похоже на боль, травму или медицинское состояние, не ставь диагноз и не обещай лечебный эффект; выбери консервативную нагрузку и укажи в notes, что нужна оценка квалифицированного специалиста.',
    'Не требуй отказа в каждом подходе. Для обычной программы используй запас повторений и постепенную прогрессию.',
    'Не используй экстремальные, опасные или соревновательные нагрузки без явной необходимости.',
    'Не добавляй оборудование, которого нет в выбранном каталоге.',
    'Партнёр, ассистент или споттер может быть частью методики только если это безопасно и действительно необходимо; по умолчанию программа должна быть выполнима одним человеком.',
    'Если частота 1–2 раза в неделю, предпочитай full body; при 3 днях можно выбрать full body, upper/lower или PPL по контексту; при 4–5 днях допускаются upper/lower, PPL или split, но только если это улучшает распределение объёма.',
    'Для коротких сессий уменьшай количество упражнений, а не пытайся вместить всё.',
    'Разнообразие должно быть осмысленным: сохраняй ключевые движения достаточно долго для прогрессии.',
    'План должен охватывать основные двигательные паттерны и основные мышечные группы в рамках цели и доступного времени.',
    'Формат может быть одним из: ' + methods.join(', ') + '.',
    'Поддерживаемые модальности: ' + modalities.join(', ') + '.',
    'В ответе нужен только JSON по заданной схеме.',
    '',
    'ПРОФИЛЬ:',
    JSON.stringify({
      goal: ruGoal(profile.goal),
      experience: ruExperience(profile.experience),
      location: ruLocation(profile.location),
      workoutsPerWeek: profile.workoutsPerWeek,
      workoutDuration: profile.workoutDuration,
      limitations: profile.limitations || 'нет',
      trainingFocus: profile.trainingFocus || 'автоматический выбор'
    }),
    '',
    'ПОЛНЫЙ СПИСОК НАЗВАНИЙ УПРАЖНЕНИЙ ИЗ БАЗЫ (используй его для выбора терминологии; в план можно ставить только ID из доступного каталога):',
    allExerciseNames.length ? allExerciseNames.map((name, i) => `${i + 1}. ${name}`).join('\\n') : 'список не передан',
    '',
    'ДОСТУПНЫЕ УПРАЖНЕНИЯ С ID:',
    catalogText(exercises),
    '',
    correction ? 'КОРРЕКЦИЯ ПРЕДЫДУЩЕЙ ВЕРСИИ: ' + correction : 'Это первая версия программы.',
    '',
    'Требования к результату:',
    '1) days должно содержать ровно ' + profile.workoutsPerWeek + ' тренировок.',
    '2) В каждой тренировке используй 4–8 упражнений в зависимости от времени.',
    '3) exerciseId должен быть только из каталога.',
    '4) sets — целое число 1–6.',
    '5) reps — конкретный диапазон повторений или время для кардио/интервалов.',
    '6) rest — конкретный отдых.',
    '7) tempo — краткая схема темпа либо "обычный контролируемый темп".',
    '8) comment — короткая практическая подсказка по технике/интенсивности.',
    '9) progression — понятная схема прогрессии на 4 недели.',
    '10) notes — важные правила и ограничения для тренера.',
  ].join('\n');
}

function validatePlan(plan: AIWorkoutPlan, profile: AIPlannerProfile, catalog: AIExerciseCandidate[]) {
  if (!plan || !Array.isArray(plan.days) || plan.days.length !== profile.workoutsPerWeek) {
    throw new Error('AI returned an invalid number of workout days');
  }

  const allowed = new Set(catalog.map((e) => e.id));
  const seen = new Set<string>();

  for (const day of plan.days) {
    if (!Array.isArray(day.exercises) || day.exercises.length < 4 || day.exercises.length > 8) {
      throw new Error('AI returned invalid exercise count');
    }
    for (const ex of day.exercises) {
      if (!allowed.has(ex.exerciseId)) throw new Error('AI selected an unknown exercise');
      if (!Number.isInteger(ex.sets) || ex.sets < 1 || ex.sets > 6) throw new Error('AI returned invalid sets');
      seen.add(ex.exerciseId);
    }
  }

  if (seen.size < 4) throw new Error('AI plan lacks exercise variety');
}

export async function createAIWorkoutPlan(
  profile: AIPlannerProfile,
  exercises: AIExerciseCandidate[],
  correction = '',
  allExerciseNames: string[] = []
): Promise<AIWorkoutPlan | null> {
  if (!apiKey) {
    console.warn('OPENAI_API_KEY is not configured; using deterministic planner.');
    return null;
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model,
      store: false,
      input: [
        {
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: buildInstructions(profile, exercises, correction, allExerciseNames)
            }
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'fitness_workout_plan',
          description: 'Structured individual fitness training plan',
          strict: true,
          schema: PLAN_SCHEMA
        }
      }
    }),
    signal: AbortSignal.timeout(60000)
  });

  const payload = await response.json() as any;
  if (!response.ok) {
    throw new Error('OpenAI API ' + response.status + ': ' + JSON.stringify(payload).slice(0, 1000));
  }

  const raw = typeof payload.output_text === 'string'
    ? payload.output_text
    : payload.output?.flatMap((item: any) => item.content ?? [])
        ?.find((item: any) => item.type === 'output_text')?.text;
  if (!raw) throw new Error('AI returned an empty workout plan');

  const plan = JSON.parse(raw) as AIWorkoutPlan;
  validatePlan(plan, profile, exercises);
  return plan;
}

export function aiEnabled() {
  return Boolean(apiKey);
}
