export type Client = {
  id: number;
  name: string;
  telegram_user_id: number | null;
  telegram_username: string | null;
  telegram_first_name: string | null;
  telegram_last_name: string | null;
  age: number;
  height_cm: number;
  weight_kg: number;
  goal: string;
  experience: string;
  workouts_per_week: number;
  training_location: string;
  limitations: string;
  note: string;
  created_at: string;
  updated_at: string;
};

export type ClientDraft = Omit<Client, 'id' | 'created_at' | 'updated_at'>;

export type AddStep =
  | 'telegram_username' | 'age' | 'height' | 'weight' | 'goal' | 'custom_goal'
  | 'experience' | 'frequency' | 'location' | 'limitations_choice'
  | 'limitations_text' | 'note';

export type AddSession = {
  step: AddStep;
  draft: Partial<ClientDraft>;
};

export type AssessmentLevel = 'Новичок' | 'Начальный' | 'Средний' | 'Продвинутый';
export type AssessmentRating = 'Низкие' | 'Средние' | 'Хорошие' | 'Высокие';
export type MobilityRating = 'Ограниченная' | 'Средняя' | 'Хорошая';
export type CoordinationRating = 'Требует развития' | 'Средняя' | 'Хорошая';
export type MovementRating = 'Хорошо' | 'Удовлетворительно' | 'Требует внимания';
export type PrimaryAssessment = {
  client_id: number;
  fitness_level: AssessmentLevel | null;
  strength: AssessmentRating | null;
  endurance: AssessmentRating | null;
  mobility: MobilityRating | null;
  coordination: CoordinationRating | null;
  squat: MovementRating | null;
  hip_hinge: MovementRating | null;
  horizontal_press: MovementRating | null;
  horizontal_pull: MovementRating | null;
  vertical_press: MovementRating | null;
  vertical_pull: MovementRating | null;
  core: MovementRating | null;
  weaknesses: string | null;
  strengths: string | null;
  attention: string | null;
  trainer_comment: string | null;
  created_at: string;
  updated_at: string;
};
