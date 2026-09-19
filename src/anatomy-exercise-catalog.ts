import { TRAINING_BASE_ROWS_1 } from './training-base-1.js';
import { TRAINING_BASE_ROWS_2 } from './training-base-2.js';
import { TRAINING_BASE_ROWS_3 } from './training-base-3.js';

export type AnatomyExercise = {
  id: string; name: string; muscleGroup: string; muscle: string; subdivision: string; primaryAction: string;
  environment: 'home' | 'gym' | 'outdoor'; environmentRu: string; category: string; equipmentRu: string; notes: string;
  levelRu: string; typeRu: string; progression: string;
};

const CATEGORY: Record<string,string> = {
  'Грудь':'chest','Спина':'back','Плечи':'shoulders','Руки':'upper arms',
  'Ноги':'upper legs','Голень':'lower legs','Кор':'waist','Плечевой пояс':'shoulders'
};
const ENVIRONMENT: Record<string, AnatomyExercise['environment']> = {
  'Дом':'home','Зал':'gym','Площадка':'outdoor'
};
const PROGRESSION = 'Увеличивать сложность через амплитуду, повторения, темп, рычаг или внешнюю нагрузку.';
const NOTES = 'Выбирать вариант по уровню и технике; оборудование/опора должны быть устойчивыми.';

function slug(value: string) {
  return String(value).toLowerCase().replace(/ё/g,'е').replace(/[^a-zа-я0-9]+/gi,'-').replace(/^-|-$/g,'');
}
type BaseRow = readonly [string,string,string,string,string,string,string,string,string];

function toExercise(row: BaseRow): AnatomyExercise {
  const [group,muscle,subdivision,environmentRu,name,primaryAction,equipmentRu,levelRu,typeRu] = row;
  const environment = ENVIRONMENT[environmentRu];
  const category = CATEGORY[group];
  if (!environment || !category) throw new Error('Unknown training-base row: ' + JSON.stringify(row));
  return {
    id:`base-${environment}-${slug(group)}-${slug(muscle)}-${slug(name)}-${slug(subdivision)}-${slug(equipmentRu)}`,
    name,muscleGroup:group,muscle,subdivision,primaryAction,environment,environmentRu,category,equipmentRu,
    notes:NOTES,levelRu,typeRu,progression:PROGRESSION
  };
}

export const ANATOMY_CATALOG_VERSION = 'base-2026-09-19-v7';
export const ANATOMY_EXERCISES: AnatomyExercise[] = [
  ...TRAINING_BASE_ROWS_1,...TRAINING_BASE_ROWS_2,...TRAINING_BASE_ROWS_3
].map((row) => toExercise(row as BaseRow));
