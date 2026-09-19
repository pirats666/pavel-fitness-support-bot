export type Client = {
  id: number;
  telegram_user_id: number;
  telegram_username: string | null;
  telegram_first_name: string;
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
  | 'age' | 'height' | 'weight' | 'goal' | 'custom_goal'
  | 'experience' | 'frequency' | 'location' | 'limitations_choice'
  | 'limitations_text' | 'note';

export type AddSession = {
  step: AddStep;
  draft: Partial<ClientDraft>;
};
