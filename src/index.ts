import 'dotenv/config';
import { createServer } from 'node:http';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import { closeDb, createClient, deleteClient, getClient, listClients, updateClientField, logDatabaseDiagnostics, migrateStage1Schema, migrateStage2AssessmentSchema, migrateStage3StrategySchema, getPrimaryAssessment, upsertPrimaryAssessment, getTrainingStrategy, upsertTrainingStrategy, migrateStage4ProgramSchema, migrateStage4TemplateSchema, migrateTrainingProgramCatalogOrderSchema, getTrainingProgram, deleteTrainingProgram, listTrainingProgramTemplates, getTrainingProgramTemplate, listTrainingProgramTemplateDays, listTrainingProgramTemplateExercises, applyTrainingProgramTemplate, updateTrainingProgramExercise, updateTrainingProgramName, listProgramCatalogMuscles, listProgramCatalogExercises, replaceTrainingProgramExercise, upsertTrainingProgram, listTrainingProgramDays, getTrainingProgramDay, createTrainingProgramDay, listTrainingProgramExercises, createTrainingProgramExercise, getTrainingProgramExercise, deleteTrainingProgramExercise } from './db.js';
import type { Client, ClientDraft, AddSession, PrimaryAssessment, TrainingStrategy, TrainingProgram, TrainingProgramDay, TrainingProgramExercise } from './types.js';
import { migrateNextBaseTemplateSchema, migrateFollowingBaseTemplateSchema, migrateUpperLowerSpecializationTemplateSchema, migrateFullBodyUpperLowerTemplateSchema } from './stage4-next-template.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;
const PORT = Number(process.env.PORT ?? 10000);

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!ADMIN_TELEGRAM_ID || !Number.isSafeInteger(Number(ADMIN_TELEGRAM_ID))) {
  throw new Error('ADMIN_TELEGRAM_ID must be configured with a numeric Telegram user id');
}
const ADMIN_ID = Number(ADMIN_TELEGRAM_ID);

const bot = new Bot(BOT_TOKEN);
const addSessions = new Map<number, AddSession>();
const editSessions = new Map<number, { clientId: number; field: keyof ClientDraft }>();
type AssessmentDraft = Omit<PrimaryAssessment,'created_at'|'updated_at'>;
const assessmentSessions = new Map<number,{clientId:number;draft:AssessmentDraft;awaitingText?:keyof AssessmentDraft}>();
type StrategyDraft = Omit<TrainingStrategy,'created_at'|'updated_at'>;
const strategySessions = new Map<number,{clientId:number;draft:StrategyDraft;awaitingText?:keyof StrategyDraft}>();
type ProgramSession={clientId:number;kind:'program'|'day'|'exercise'|'exercise-edit'|'program-edit';step:string;program?:Omit<TrainingProgram,'created_at'|'updated_at'>;dayId?:number;exerciseId?:number;exercise?:Partial<TrainingProgramExercise>;pendingExerciseName?:string;pendingExerciseMuscle?:string};
const programSessions=new Map<number,ProgramSession>();

const GOALS = [
  ['🎯 Набор мышечной массы','goal:muscle'], ['🔥 Снижение веса','goal:weight'],
  ['💪 Увеличение силы','goal:strength'], ['🏃 Выносливость','goal:endurance'],
  ['⚡ Общая физическая подготовка','goal:fitness'], ['🔄 Возвращение к тренировкам','goal:return'],
  ['🎯 Другая цель','goal:other']
] as const;
const EXPERIENCES = [['🟢 Новичок','exp:beginner'],['🟡 Средний','exp:intermediate'],['🔴 Продвинутый','exp:advanced']] as const;
const FREQUENCIES = [['2','freq:2'],['3','freq:3'],['4','freq:4'],['5+','freq:5']] as const;
const LOCATIONS = [['🏠 Дом','loc:home'],['🏋️ Зал','loc:gym'],['🌳 Спортплощадка','loc:outdoor'],['🔄 Комбинированный вариант','loc:mixed']] as const;

const MAIN_MENU = new InlineKeyboard().text('👤 Клиенты','clients').row().text('📝 Заметки','notes');

function isAdmin(ctx: Context) { return ctx.from?.id === ADMIN_ID; }
function esc(v: unknown) { return String(v ?? '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]!)); }
function mainText() { return '👋 Добро пожаловать в рабочий кабинет тренера.\n\n<b>Главное меню:</b>'; }

async function render(ctx: Context, text: string, keyboard?: InlineKeyboard) {
  if (ctx.callbackQuery?.message) {
    try { await ctx.editMessageText(text, { parse_mode:'HTML', reply_markup:keyboard }); return; } catch {}
  }
  await ctx.reply(text, { parse_mode:'HTML', reply_markup:keyboard });
}

async function showMain(ctx: Context) { await render(ctx, mainText(), MAIN_MENU); }

function clientDisplayName(c: Client) { return c.telegram_username ? '@' + c.telegram_username : 'Клиент'; }
function telegramLabel(username: string | null) { return username ? `<a href="https://t.me/${esc(username)}">@${esc(username)}</a>` : 'Не указан'; }
function clientsKeyboard(clients: Client[]) {
  const kb = new InlineKeyboard().text('➕ Добавить клиента','client:add').row();
  for (const c of clients) kb.text('👤 ' + clientDisplayName(c),'client:view:' + c.id).row();
  return kb.text('⬅️ Назад','main');
}
async function showClients(ctx: Context) {
  const clients = await listClients();
  await render(ctx, clients.length ? '👤 <b>КЛИЕНТЫ</b>' : '👤 <b>КЛИЕНТЫ</b>\n\nУ вас пока нет клиентов.', clientsKeyboard(clients));
}

function goalLabel(key:string) { return Object.fromEntries(GOALS.map(([l,k])=>[k.slice(5),l]))[key] ?? key; }
function expLabel(key:string) { return Object.fromEntries(EXPERIENCES.map(([l,k])=>[k.slice(4),l]))[key] ?? key; }
function locLabel(key:string) { return Object.fromEntries(LOCATIONS.map(([l,k])=>[k.slice(4),l]))[key] ?? key; }

function clientCard(c:Client) {
  return [
    `👤 <b>${esc(clientDisplayName(c))}</b>`, '',
    `📱 Telegram: ${telegramLabel(c.telegram_username)}`,
    `Возраст: ${c.age}`, `Рост: ${c.height_cm} см`, `Вес: ${c.weight_kg} кг`, '',
    `🎯 Цель: ${esc(c.goal)}`, `🏋️ Опыт: ${esc(c.experience)}`,
    `📅 Тренировок в неделю: ${c.workouts_per_week === 5 ? '5+' : c.workouts_per_week}`,
    `📍 Место тренировок: ${esc(c.training_location)}`, '',
    `⚠️ Ограничения: ${esc(c.limitations) || 'Нет'}`,
    `📝 Заметка: ${esc(c.note) || 'Нет'}`, '',
    `Дата добавления: ${new Date(c.created_at).toLocaleString('ru-RU')}`
  ].join('\n');
}
function clientActions(id:number) {
  return new InlineKeyboard().text('🧩 Первичная оценка','assessment:'+id).row().text('🎯 Стратегия тренировок','strategy:'+id).row().text('🏋️ Тренировочная программа','program:'+id).row().text('✏️ Редактировать','client:edit:'+id).row()
    .text('🗑 Удалить клиента','client:delete:'+id).row()
    .text('⬅️ К клиентам','clients').row().text('🏠 Главное меню','main');
}
async function showClient(ctx:Context,id:number) {
  const c=await getClient(id);
  if(!c) return render(ctx,'Клиент не найден.',new InlineKeyboard().text('⬅️ К клиентам','clients'));
  await render(ctx,clientCard(c),clientActions(id));
}

function cancelKb(data='client:add-cancel') { return new InlineKeyboard().text('❌ Отмена',data); }
function choices(rows:readonly (readonly [string,string])[],cancel='client:add-cancel') {
  const kb=new InlineKeyboard(); for(const [l,d] of rows) kb.text(l,d).row(); return kb.text('❌ Отмена',cancel);
}
async function promptAdd(ctx:Context,s:AddSession) {
  const prompts:Record<AddSession['step'],string>={
    age:'Введите возраст клиента:', height:'Введите рост клиента в см:',
    weight:'Введите текущий вес клиента в кг:', goal:'Выберите основную цель клиента:',
    telegram_username:'Введите Telegram username клиента:\n\nНапример:\n@username\n\nЕсли у клиента нет username — нажмите «Пропустить».', custom_goal:'Напишите цель клиента вручную:', experience:'Выберите тренировочный опыт:',
    frequency:'Сколько тренировок в неделю планируется?', location:'Где клиент будет тренироваться?',
    limitations_choice:'Есть ли ограничения, которые нужно учитывать при составлении программы?',
    limitations_text:'Напишите ограничения текстом:',
    note:'Добавьте дополнительную заметку о клиенте или нажмите «Пропустить».'
  };
  let kb:InlineKeyboard|undefined=cancelKb();
  if(s.step==='telegram_username') kb=new InlineKeyboard().text('⏭ Пропустить','telegram:skip').row().text('❌ Отмена','client:add-cancel');
  if(s.step==='goal') kb=choices(GOALS);
  if(s.step==='experience') kb=choices(EXPERIENCES);
  if(s.step==='frequency') kb=choices(FREQUENCIES);
  if(s.step==='location') kb=choices(LOCATIONS);
  if(s.step==='limitations_choice') kb=choices([['Нет','limit:no'],['Да','limit:yes']]);
  if(s.step==='note') kb=new InlineKeyboard().text('⏭ Пропустить','note:skip').row().text('❌ Отмена','client:add-cancel');
  await render(ctx,prompts[s.step],kb);
}
function positiveNumber(t:string) { const x=t.trim().replace(',','.'); if(!/^(?:\d+|\d+\.\d+)$/.test(x)) return null; const n=Number(x); return Number.isFinite(n)&&n>0?n:null; }
function complete(d:Partial<ClientDraft>): d is ClientDraft {
  return typeof d.name==='string' && d.name.length>0 && typeof d.telegram_username !== 'undefined' && typeof d.age==='number' && d.age>=1 && d.age<=120
    && typeof d.height_cm==='number' && d.height_cm>0 && d.height_cm<=300
    && typeof d.weight_kg==='number' && d.weight_kg>0 && d.weight_kg<=500
    && typeof d.goal==='string' && typeof d.experience==='string' && typeof d.workouts_per_week==='number'
    && typeof d.training_location==='string' && typeof d.limitations==='string' && typeof d.note==='string';
}
function summary(d:ClientDraft) {
  return ['👤 <b>Новый клиент</b>','',`📱 Telegram: ${telegramLabel(d.telegram_username ?? null)}`,`Возраст: ${d.age}`,`Рост: ${d.height_cm} см`,`Вес: ${d.weight_kg} кг`,'',
    `🎯 Цель: ${esc(d.goal)}`,`🏋️ Опыт: ${esc(d.experience)}`,`📅 Тренировок в неделю: ${d.workouts_per_week===5?'5+':d.workouts_per_week}`,
    `📍 Место: ${esc(d.training_location)}`,`⚠️ Ограничения: ${esc(d.limitations)||'Нет'}`,`📝 Заметка: ${esc(d.note)||'Нет'}`].join('\n');
}
function confirmKb() { return new InlineKeyboard().text('✅ Сохранить','client:save').row().text('✏️ Изменить','client:change').row().text('❌ Отмена','client:add-cancel'); }

function editMenu(id:number) {
  return new InlineKeyboard()
      .text('👤 Telegram','editfield:'+id+':telegram_username').row().text('🎂 Возраст','editfield:'+id+':age').row()
     .text('Рост','editfield:'+id+':height_cm').text('Вес','editfield:'+id+':weight_kg').row()
    .text('Цель','editfield:'+id+':goal').text('Опыт','editfield:'+id+':experience').row()
    .text('Тренировки в неделю','editfield:'+id+':workouts_per_week').row()
    .text('Место','editfield:'+id+':training_location').row()
    .text('Ограничения','editfield:'+id+':limitations').text('Заметка','editfield:'+id+':note').row()
    .text('⬅️ К карточке','client:view:'+id);
}
function editChoices(field:keyof ClientDraft) {
  if(field==='goal') return choices(GOALS,'editcancel');
  if(field==='experience') return choices(EXPERIENCES,'editcancel');
  if(field==='workouts_per_week') return choices(FREQUENCIES,'editcancel');
  if(field==='training_location') return choices(LOCATIONS,'editcancel');
  return cancelKb('editcancel');
}

bot.use(async(ctx,next)=>{
  if(!isAdmin(ctx)){ if(ctx.callbackQuery) await ctx.answerCallbackQuery({text:'Доступ запрещён.'}).catch(()=>{}); else if(ctx.message) await ctx.reply('Доступ запрещён.'); return; }
  await next();
});

bot.command('start',async ctx=>{ addSessions.delete(ctx.from!.id); editSessions.delete(ctx.from!.id); await showMain(ctx); });
bot.callbackQuery('main',async ctx=>{await ctx.answerCallbackQuery();addSessions.delete(ctx.from!.id);editSessions.delete(ctx.from!.id);await showMain(ctx);});
bot.callbackQuery('notes',async ctx=>{await ctx.answerCallbackQuery();await render(ctx,'Этот раздел будет доступен на следующем этапе.',new InlineKeyboard().text('🏠 Главное меню','main'));});
bot.callbackQuery('clients',async ctx=>{await ctx.answerCallbackQuery();await showClients(ctx);});
bot.callbackQuery('client:add',async ctx=>{await ctx.answerCallbackQuery();addSessions.set(ctx.from.id,{step:'telegram_username',draft:{telegram_user_id:null, telegram_username:null, telegram_first_name:null, telegram_last_name:null, name:'Клиент'}});await promptAdd(ctx,addSessions.get(ctx.from.id)!);});
bot.callbackQuery('telegram:skip',async ctx=>{const s=addSessions.get(ctx.from.id);if(!s||s.step!=='telegram_username')return;await ctx.answerCallbackQuery();s.draft.telegram_username=null;s.step='age';await promptAdd(ctx,s);});
bot.callbackQuery('client:add-cancel',async ctx=>{await ctx.answerCallbackQuery();addSessions.delete(ctx.from.id);await showClients(ctx);});

for(const [label,data] of GOALS) bot.callbackQuery(data,async ctx=>{
  const s=addSessions.get(ctx.from.id); if(!s||s.step!=='goal') return;
  await ctx.answerCallbackQuery(); s.draft.goal=data==='goal:other'?'':label; s.step=data==='goal:other'?'custom_goal':'experience'; await promptAdd(ctx,s);
});
for(const [label,data] of EXPERIENCES) bot.callbackQuery(data,async ctx=>{const s=addSessions.get(ctx.from.id);if(!s||s.step!=='experience')return;await ctx.answerCallbackQuery();s.draft.experience=label;s.step='frequency';await promptAdd(ctx,s);});
for(const [,data] of FREQUENCIES) bot.callbackQuery(data,async ctx=>{const s=addSessions.get(ctx.from.id);if(!s||s.step!=='frequency')return;await ctx.answerCallbackQuery();s.draft.workouts_per_week=Number(data.slice(5));s.step='location';await promptAdd(ctx,s);});
for(const [label,data] of LOCATIONS) bot.callbackQuery(data,async ctx=>{const s=addSessions.get(ctx.from.id);if(!s||s.step!=='location')return;await ctx.answerCallbackQuery();s.draft.training_location=label;s.step='limitations_choice';await promptAdd(ctx,s);});
bot.callbackQuery('limit:no',async ctx=>{const s=addSessions.get(ctx.from.id);if(!s||s.step!=='limitations_choice')return;await ctx.answerCallbackQuery();s.draft.limitations='Нет';s.step='note';await promptAdd(ctx,s);});
bot.callbackQuery('limit:yes',async ctx=>{const s=addSessions.get(ctx.from.id);if(!s||s.step!=='limitations_choice')return;await ctx.answerCallbackQuery();s.step='limitations_text';await promptAdd(ctx,s);});
bot.callbackQuery('note:skip',async ctx=>{const s=addSessions.get(ctx.from.id);if(!s||s.step!=='note')return;await ctx.answerCallbackQuery();s.draft.note='Нет';if(complete(s.draft))await render(ctx,summary(s.draft),confirmKb());});

bot.callbackQuery('client:save',async ctx=>{await ctx.answerCallbackQuery();const s=addSessions.get(ctx.from.id);if(!s||!complete(s.draft))return;try{const c=await createClient(s.draft);addSessions.delete(ctx.from.id);await render(ctx,'✅ Клиент успешно добавлен.\n\n'+clientCard(c),clientActions(c.id));}catch(e){console.error('[DB INSERT] CLIENT INSERT FAILED', { exception_type: e instanceof Error ? e.constructor.name : typeof e, message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined, table: 'public.clients', operation: 'INSERT', fields: { name: s.draft.name, telegram_username: s.draft.telegram_username, telegram_user_id: s.draft.telegram_user_id, telegram_first_name: s.draft.telegram_first_name, telegram_last_name: s.draft.telegram_last_name, age: s.draft.age, height_cm: s.draft.height_cm, weight_kg: s.draft.weight_kg, goal: s.draft.goal, experience: s.draft.experience, workouts_per_week: s.draft.workouts_per_week, training_location: s.draft.training_location, limitations: s.draft.limitations, note: s.draft.note } });await render(ctx,'❌ Не удалось сохранить клиента. Попробуйте ещё раз.',new InlineKeyboard().text('⬅️ К клиентам','clients'));}});
bot.callbackQuery('client:change',async ctx=>{await ctx.answerCallbackQuery();const s=addSessions.get(ctx.from.id);if(!s||!complete(s.draft))return;await render(ctx,'✏️ <b>Что изменить?</b>',new InlineKeyboard() .text('Возраст','addedit:age').row().text('Рост','addedit:height').text('Вес','addedit:weight').row().text('Цель','addedit:goal').text('Опыт','addedit:experience').row().text('Тренировки','addedit:frequency').text('Место','addedit:location').row().text('Ограничения','addedit:limitations').text('Заметка','addedit:note').row().text('⬅️ К подтверждению','addedit:back'));});

const addFieldSteps:Record<string,AddSession['step']>={age:'age',height:'height',weight:'weight',goal:'goal',experience:'experience',frequency:'frequency',location:'location',limitations:'limitations_text',note:'note'};
bot.callbackQuery(/addedit:(.+)/,async ctx=>{const key=ctx.match[1];const s=addSessions.get(ctx.from.id);if(!s)return;await ctx.answerCallbackQuery();if(key==='back'){if(complete(s.draft))await render(ctx,summary(s.draft),confirmKb());return;}const step=addFieldSteps[key];if(!step)return;s.step=step;await promptAdd(ctx,s);});


const ASSESSMENT_LEVELS=[['Новичок','Новичок'],['Начальный','Начальный'],['Средний','Средний'],['Продвинутый','Продвинутый']] as const;
const ASSESSMENT_STRENGTH=[['Низкие','Низкие'],['Средние','Средние'],['Хорошие','Хорошие'],['Высокие','Высокие']] as const;
const ASSESSMENT_ENDURANCE=[['Низкая','Низкая'],['Средняя','Средняя'],['Хорошая','Хорошая'],['Высокая','Высокая']] as const;
const ASSESSMENT_MOBILITY=[['Ограниченная','Ограниченная'],['Средняя','Средняя'],['Хорошая','Хорошая']] as const;
const ASSESSMENT_COORDINATION=[['Требует развития','Требует развития'],['Средняя','Средняя'],['Хорошая','Хорошая']] as const;
const MOVEMENT_FIELDS=[['Присед','squat'],['Наклон / движение в тазобедренном суставе','hip_hinge'],['Горизонтальный жим','horizontal_press'],['Горизонтальная тяга','horizontal_pull'],['Вертикальный жим','vertical_press'],['Вертикальная тяга','vertical_pull'],['Работа корпуса','core']] as const;
function blankAssessment(clientId:number):AssessmentDraft{return {client_id:clientId,fitness_level:null,strength:null,endurance:null,mobility:null,coordination:null,squat:null,hip_hinge:null,horizontal_press:null,horizontal_pull:null,vertical_press:null,vertical_pull:null,core:null,weaknesses:null,strengths:null,attention:null,trainer_comment:null};}
function assessmentText(a:AssessmentDraft|PrimaryAssessment){const mv=(v:string|null)=>v===null?'⏭ Не оценивалось':v;return ['🧩 <b>ПЕРВИЧНАЯ ОЦЕНКА</b>','', 'Уровень: '+(esc(a.fitness_level)||'Не заполнено'),'Силовые возможности: '+(esc(a.strength)||'Не заполнено'),'Выносливость: '+(esc(a.endurance)||'Не заполнено'),'Мобильность: '+(esc(a.mobility)||'Не заполнено'),'Координация: '+(esc(a.coordination)||'Не заполнено'),'','<b>Базовые движения:</b>','Присед: '+mv(a.squat),'Наклон / движение в тазобедренном суставе: '+mv(a.hip_hinge),'Горизонтальный жим: '+mv(a.horizontal_press),'Горизонтальная тяга: '+mv(a.horizontal_pull),'Вертикальный жим: '+mv(a.vertical_press),'Вертикальная тяга: '+mv(a.vertical_pull),'Работа корпуса: '+mv(a.core),'','💪 <b>Сильные стороны:</b> '+(esc(a.strengths)||'Не заполнено'),'⚠️ <b>Слабые стороны:</b> '+(esc(a.weaknesses)||'Не заполнено'),'⚠️ <b>Требует внимания:</b> '+(esc(a.attention)||'Не заполнено'),'📝 <b>Комментарий:</b> '+(esc(a.trainer_comment)||'Не заполнено')].join('\n');}
function assessmentMenu(id:number){return new InlineKeyboard().text('Уровень физической подготовки','assessment:field:'+id+':fitness_level').row().text('Силовые возможности','assessment:field:'+id+':strength').row().text('Выносливость','assessment:field:'+id+':endurance').row().text('Мобильность','assessment:field:'+id+':mobility').row().text('Координация','assessment:field:'+id+':coordination').row().text('Базовые движения','assessment:movements:'+id).row().text('⚠️ Слабые стороны','assessment:text:'+id+':weaknesses').row().text('💪 Сильные стороны','assessment:text:'+id+':strengths').row().text('⚠️ Требует внимания','assessment:text:'+id+':attention').row().text('📝 Комментарий тренера','assessment:text:'+id+':trainer_comment').row().text('💾 Сохранить','assessment:save:'+id).row().text('✏️ Изменить','assessment:edit:'+id).row().text('⬅️ Назад к клиенту','client:view:'+id);}
function movementMenu(id:number){const kb=new InlineKeyboard();for(const [label,field] of MOVEMENT_FIELDS)kb.text(label,'assessment:movement:'+id+':'+field).row();return kb.text('⬅️ Назад к оценке','assessment:menu:'+id);}
const ASSESSMENT_VALUE_CODES:Record<string,string>={'Новичок':'N','Начальный':'B','Средний':'M','Продвинутый':'A','Низкие':'L','Средние':'M','Хорошие':'G','Высокие':'H','Низкая':'L','Хорошая':'G','Высокая':'H','Ограниченная':'L','Требует развития':'D'};
const ASSESSMENT_VALUE_LABELS:Record<string,string>={N:'Новичок',B:'Начальный',M:'Средний',A:'Продвинутый',L:'Низкие',G:'Хорошие',H:'Высокие',D:'Требует развития'};
function assessmentChoices(rows:readonly (readonly [string,string])[],id:number,field:string){const kb=new InlineKeyboard();for(const [label,value] of rows)kb.text(label,'assessment:set:'+id+':'+field+':'+(ASSESSMENT_VALUE_CODES[value]??value)).row();return kb.text('⬅️ Назад к оценке','assessment:menu:'+id);}
function movementChoices(id:number,field:string){return new InlineKeyboard().text('Хорошо','assessment:movement-set:'+id+':'+field+':G').row().text('Удовлетворительно','assessment:movement-set:'+id+':'+field+':S').row().text('Требует внимания','assessment:movement-set:'+id+':'+field+':A').row().text('⏭ Не оценивалось','assessment:movement-set:'+id+':'+field+':N').row().text('⬅️ К движениям','assessment:movements:'+id);}
async function loadAssessmentSession(ctx:Context,id:number){const c=await getClient(id);if(!c)throw new Error('Client not found');let s=assessmentSessions.get(ctx.from!.id);if(!s||s.clientId!==id){const existing=await getPrimaryAssessment(id);s={clientId:id,draft:existing?{...existing}:blankAssessment(id)};assessmentSessions.set(ctx.from!.id,s);}return s;}
async function showAssessment(ctx:Context,id:number){const c=await getClient(id);if(!c)return render(ctx,'❌ Клиент не найден.',new InlineKeyboard().text('⬅️ К клиентам','clients'));const a=await getPrimaryAssessment(id);if(!a)return render(ctx,'🧩 <b>ПЕРВИЧНАЯ ОЦЕНКА</b>\n\nПервичная оценка ещё не заполнена.',new InlineKeyboard().text('➕ Заполнить оценку','assessment:new:'+id).row().text('⬅️ Назад к клиенту','client:view:'+id));return render(ctx,assessmentText(a),new InlineKeyboard().text('✏️ Изменить оценку','assessment:edit:'+id).row().text('⬅️ Назад к клиенту','client:view:'+id));}

bot.callbackQuery(/^assessment:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();await showAssessment(ctx,id);});
bot.callbackQuery(/^assessment:(?:new|edit):(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();try{await loadAssessmentSession(ctx,id);await render(ctx,'🧩 <b>Первичная оценка</b>\n\nВыберите раздел для заполнения или изменения.',assessmentMenu(id));}catch(e){console.error('[ASSESSMENT OPEN FAILED]',e);await render(ctx,'❌ Клиент не найден.',new InlineKeyboard().text('⬅️ К клиентам','clients'));}});
bot.callbackQuery(/^assessment:menu:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();const s=await loadAssessmentSession(ctx,id);await render(ctx,assessmentText(s.draft),assessmentMenu(id));});
bot.callbackQuery(/^assessment:field:(\d+):(fitness_level|strength|endurance|mobility|coordination)$/,async ctx=>{const id=Number(ctx.match[1]);const field=ctx.match[2];await ctx.answerCallbackQuery();const rows=field==='fitness_level'?ASSESSMENT_LEVELS:field==='strength'?ASSESSMENT_STRENGTH:field==='endurance'?ASSESSMENT_ENDURANCE:field==='mobility'?ASSESSMENT_MOBILITY:ASSESSMENT_COORDINATION;await loadAssessmentSession(ctx,id);await render(ctx,'Выберите значение:',assessmentChoices(rows,id,field));});
bot.callbackQuery(/^assessment:set:(\d+):(fitness_level|strength|endurance|mobility|coordination):([A-Z])$/,async ctx=>{const id=Number(ctx.match[1]);const field=ctx.match[2] as keyof AssessmentDraft;const code=ctx.match[3];const value=ASSESSMENT_VALUE_LABELS[code];if(!value)return;await ctx.answerCallbackQuery();const s=await loadAssessmentSession(ctx,id);(s.draft as any)[field]=value;await render(ctx,assessmentText(s.draft),assessmentMenu(id));});
bot.callbackQuery(/^assessment:movements:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();await loadAssessmentSession(ctx,id);await render(ctx,'<b>Оценка базовых движений</b>\n\nВыберите движение:',movementMenu(id));});
bot.callbackQuery(/^assessment:movement:(\d+):(.+)$/,async ctx=>{const id=Number(ctx.match[1]);const field=ctx.match[2];if(!MOVEMENT_FIELDS.some(x=>x[1]===field))return;await ctx.answerCallbackQuery();await loadAssessmentSession(ctx,id);await render(ctx,'Оцените движение:',movementChoices(id,field));});
const MOVEMENT_VALUE_LABELS:Record<string,string|null>={G:'Хорошо',S:'Удовлетворительно',A:'Требует внимания',N:null};
bot.callbackQuery(/^assessment:movement-set:(\d+):([a-z_]+):([GSAN])$/,async ctx=>{const id=Number(ctx.match[1]);const field=ctx.match[2] as keyof AssessmentDraft;const code=ctx.match[3];if(!MOVEMENT_FIELDS.some(x=>x[1]===field))return;await ctx.answerCallbackQuery();const s=await loadAssessmentSession(ctx,id);(s.draft as any)[field]=MOVEMENT_VALUE_LABELS[code];await render(ctx,'<b>Оценка базовых движений</b>\n\nВыберите движение:',movementMenu(id));});
bot.callbackQuery(/^assessment:text:(\d+):(weaknesses|strengths|attention|trainer_comment)$/,async ctx=>{const id=Number(ctx.match[1]);const field=ctx.match[2] as keyof AssessmentDraft;await ctx.answerCallbackQuery();const s=await loadAssessmentSession(ctx,id);s.awaitingText=field;const labels:any={weaknesses:'⚠️ Слабые стороны',strengths:'💪 Сильные стороны',attention:'⚠️ Требует внимания',trainer_comment:'📝 Комментарий тренера'};await render(ctx,labels[field]+'\n\nВведите текст или нажмите «Пропустить».',new InlineKeyboard().text('⏭ Пропустить','assessment:skip:'+id+':'+field).row().text('⬅️ Назад к оценке','assessment:menu:'+id));});
bot.callbackQuery(/^assessment:skip:(\d+):(weaknesses|strengths|attention|trainer_comment)$/,async ctx=>{const id=Number(ctx.match[1]);const field=ctx.match[2] as keyof AssessmentDraft;await ctx.answerCallbackQuery();const s=await loadAssessmentSession(ctx,id);(s.draft as any)[field]=null;s.awaitingText=undefined;await render(ctx,assessmentText(s.draft),assessmentMenu(id));});
bot.callbackQuery(/^assessment:save:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();const s=await loadAssessmentSession(ctx,id);try{const saved=await upsertPrimaryAssessment(s.draft);assessmentSessions.delete(ctx.from!.id);await render(ctx,assessmentText(saved),new InlineKeyboard().text('✏️ Изменить оценку','assessment:edit:'+id).row().text('⬅️ Назад к клиенту','client:view:'+id));}catch(e){console.error('[ASSESSMENT SAVE FAILED]',e);await render(ctx,'❌ Не удалось сохранить первичную оценку.',assessmentMenu(id));}});

type StrategyField = 'main_task'|'priorities'|'what_to_account_for'|'main_focus'|'trainer_decision';
const STRATEGY_FIELDS:readonly (readonly [string,StrategyField])[]=[
  ['🎯 Основная задача','main_task'],['⭐ Приоритеты','priorities'],
  ['⚠️ Что учитывать','what_to_account_for'],['🔎 Основной фокус','main_focus'],
  ['📝 Решение / комментарий тренера','trainer_decision']
];
function blankStrategy(clientId:number):StrategyDraft{return {client_id:clientId,main_task:null,priorities:null,what_to_account_for:null,main_focus:null,trainer_decision:null};}
function strategyText(s:StrategyDraft|TrainingStrategy){
  const value=(v:string|null)=>{
    if(v===null || !v.trim()) return 'Не заполнено';
    return esc(v.replace(/\r\n/g,'\n').trim());
  };
  return ['🎯 <b>СТРАТЕГИЯ ТРЕНИРОВОК</b>','',
    '🎯 <b>Основная задача:</b>\n'+value(s.main_task),'',
    '⭐ <b>Приоритеты:</b>\n'+value(s.priorities),'',
    '⚠️ <b>Что учитывать:</b>\n'+value(s.what_to_account_for),'',
    '🔎 <b>Основной фокус:</b>\n'+value(s.main_focus),'',
    '📝 <b>Решение тренера:</b>\n'+value(s.trainer_decision)].join('\n');
}
function strategyMenu(id:number){
  const kb=new InlineKeyboard();
  for(const [label,field] of STRATEGY_FIELDS) kb.text(label,'strategy:field:'+id+':'+field).row();
  return kb.text('💾 Сохранить','strategy:save:'+id).row().text('✏️ Изменить','strategy:edit:'+id).row().text('⬅️ Назад к клиенту','client:view:'+id);
}
async function loadStrategySession(ctx:Context,id:number){
  const c=await getClient(id); if(!c)throw new Error('Client not found');
  let s=strategySessions.get(ctx.from!.id);
  if(!s||s.clientId!==id){const existing=await getTrainingStrategy(id);s={clientId:id,draft:existing?{...existing}:blankStrategy(id)};strategySessions.set(ctx.from!.id,s);}
  return s;
}
async function showStrategy(ctx:Context,id:number){
  const c=await getClient(id);
  if(!c)return render(ctx,'❌ Клиент не найден.',new InlineKeyboard().text('⬅️ К клиентам','clients'));
  const s=await getTrainingStrategy(id);
  if(!s)return render(ctx,'🎯 <b>СТРАТЕГИЯ ТРЕНИРОВОК</b>\n\nСтратегия ещё не заполнена.',new InlineKeyboard().text('➕ Создать стратегию','strategy:new:'+id).row().text('⬅️ Назад к клиенту','client:view:'+id));
  return render(ctx,strategyText(s),new InlineKeyboard().text('✏️ Изменить','strategy:edit:'+id).row().text('⬅️ Назад к клиенту','client:view:'+id));
}

function normalizeProgramText(value:string){
  return String(value ?? '')
    .replace(/\r\n/g,'\n')
    .replace(/\\n/g,'\n')
    .replace(/\/n/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}
function formatProgramComment(comment:string){
  const normalized=normalizeProgramText(comment);
  return normalized.split('\n').map(line=>{
    const t=line.trim();
    if(!t)return '';
    if(/^График:$/i.test(t))return '📅 <b>ГРАФИК</b>';
    if(/^Интенсивность:$/i.test(t))return '🔥 <b>ИНТЕНСИВНОСТЬ</b>';
    if(/^Отдых между подходами:$/i.test(t))return '⏱ <b>ОТДЫХ МЕЖДУ ПОДХОДАМИ</b>';
    if(/^Прогрессия:$/i.test(t))return '📈 <b>ПРОГРЕССИЯ</b>';
    if(/^Основной принцип:$/i.test(t))return '🎯 <b>ОСНОВНОЙ ПРИНЦИП</b>';
    if(/^RIR:$/i.test(t))return '🎚 <b>RIR</b>';
    if(/^При накоплении выраженной усталости:$/i.test(t))return '🔄 <b>ПРИ НАКОПЛЕНИИ УСТАЛОСТИ</b>';
    return esc(line);
  }).join('\n').replace(/\n{3,}/g,'\n\n');
}
function formatExerciseLine(e:any,index:number){
  const details=[String(e.sets)+' × '+String(e.reps)];
  if(e.rest_seconds!==null && e.rest_seconds!==undefined)details.push('отдых '+e.rest_seconds+' сек.');
  if(e.rir!==null && e.rir!==undefined)details.push('RIR '+e.rir);
  const lines=[(index+1)+'. <b>'+esc(e.name)+'</b>'];
  if(e.muscle_group)lines.push('   💪 '+esc(e.muscle_group));
  lines.push('   '+details.join(' · '));
  if(e.comment && !/^Отдых:/i.test(String(e.comment)))lines.push('   📝 '+esc(normalizeProgramText(String(e.comment))));
  return lines.join('\n');
}
function programText(p:TrainingProgram|Omit<TrainingProgram,'created_at'|'updated_at'>,days:TrainingProgramDay[]){
  const lines=['🏋️ <b>'+esc(p.name)+'</b>'];
  if(p.goal)lines.push('','🎯 <b>ЦЕЛЬ</b>',esc(normalizeProgramText(p.goal)));
  if(days.length){
    lines.push('','📅 <b>ТРЕНИРОВОЧНЫЕ ДНИ</b>');
    for(const d of days){
      const clean=d.name.replace(/^(?:День\s*\d+\s*[—-]?\s*)+/i,'').trim();
      lines.push('','🏋️ <b>ДЕНЬ '+d.day_number+' — '+esc(clean||d.name)+'</b>');
      if(d.comment)lines.push('   📌 '+esc(normalizeProgramText(d.comment)));
    }
  }else lines.push('','📅 <b>ТРЕНИРОВОЧНЫЕ ДНИ</b>','Не добавлены');
  if(p.duration_weeks)lines.push('','⏱ <b>СРОК</b> — '+p.duration_weeks+' нед.');
  if(p.comment){
    const formatted=formatProgramComment(p.comment);
    if(formatted)lines.push('',formatted);
  }
  return lines.join('\n');
}
function dayTitle(d:TrainingProgramDay){const clean=d.name.replace(/^(?:День\s*\d+\s*[—-]?\s*)+/i,'').trim();return '🏋️ <b>ДЕНЬ '+d.day_number+' — '+esc(clean||d.name)+'</b>';}
function templateProgramText(t:any,days:any[],exercisesByDay:Record<number,any[]>){
  const lines=['📚 <b>'+esc(t.name)+'</b>'];
  if(t.goal)lines.push('','🎯 <b>ЦЕЛЬ</b>',esc(normalizeProgramText(t.goal)));
  if(t.comment){
    const formatted=formatProgramComment(t.comment);
    if(formatted)lines.push('',formatted);
  }
  if(days.length){
    lines.push('','🏋️ <b>ТРЕНИРОВОЧНЫЕ ДНИ</b>');
    for(const d of days){
      const clean=d.name.replace(/^(?:День\s*\d+\s*[—-]?\s*)+/i,'').trim();
      lines.push('','━━━━━━━━━━━━','🏋️ <b>ДЕНЬ '+d.day_number+' — '+esc(clean||d.name)+'</b>');
      if(d.comment)lines.push('   📌 <b>ФОКУС:</b> '+esc(normalizeProgramText(d.comment)));
      const ex=exercisesByDay[d.id]||[];
      if(!ex.length){lines.push('   Упражнения не добавлены');continue;}
      lines.push('');
      ex.forEach((e:any,i:number)=>lines.push(formatExerciseLine(e,i)));
    }
    lines.push('','━━━━━━━━━━━━');
  }
  return lines.join('\n').replace(/\n{3,}/g,'\n\n');
}
async function showProgram(ctx:Context,id:number){
  const c=await getClient(id);if(!c)return render(ctx,'❌ Клиент не найден.',new InlineKeyboard().text('⬅️ К клиентам','clients'));
  const p=await getTrainingProgram(id);const days=p?await listTrainingProgramDays(id):[];
  if(!p)return render(ctx,'🏋️ <b>ТРЕНИРОВОЧНАЯ ПРОГРАММА</b>\n\nПрограмма ещё не создана.',new InlineKeyboard().text('📚 Выбрать из базы','program:templates:'+id).row().text('➕ Создать программу','program:new:'+id).row().text('⬅️ Назад к клиенту','client:view:'+id));
  await render(ctx,programText(p,days),new InlineKeyboard().text('📚 База программ','program:templates:'+id).row().text('➕ Добавить день','program:day:new:'+id).row().text('📋 Тренировочные дни','program:days:'+id).row().text('✏️ Скорректировать программу','program:edit:'+id).row().text('🗑 Удалить программу','program:delete:'+id).row().text('⬅️ Назад к клиенту','client:view:'+id));
}
bot.callbackQuery(/^program:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();await showProgram(ctx,id);});
bot.callbackQuery(/^program:templates:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();const ts=await listTrainingProgramTemplates();const kb=new InlineKeyboard();for(const t of ts)kb.text('📋 '+t.name,'program:template:'+t.id+':'+id).row();kb.text('⬅️ К программе','program:'+id);await render(ctx,'📚 <b>БАЗА ТРЕНИРОВОЧНЫХ ПРОГРАММ</b>\n\nВыберите базовую программу:',kb);});
bot.callbackQuery(/^program:template:(\d+):(\d+)$/,async ctx=>{const tid=Number(ctx.match[1]),id=Number(ctx.match[2]);await ctx.answerCallbackQuery();const t=await getTrainingProgramTemplate(tid);if(!t)return;const days=await listTrainingProgramTemplateDays(tid);const exercisesByDay:Record<number,any[]>={};for(const d of days)exercisesByDay[d.id]=await listTrainingProgramTemplateExercises(d.id);const kb=new InlineKeyboard().text('📥 Загрузить клиенту','program:template-apply:'+tid+':'+id).row().text('⬅️ К базе программ','program:templates:'+id);await render(ctx,templateProgramText(t,days,exercisesByDay),kb);});
bot.callbackQuery(/^program:template-apply:(\d+):(\d+)$/,async ctx=>{const tid=Number(ctx.match[1]),id=Number(ctx.match[2]);await ctx.answerCallbackQuery();const saved=await applyTrainingProgramTemplate(id,tid);await render(ctx,'✅ Базовая программа загружена в карточку клиента.\n\n'+programText(saved,await listTrainingProgramDays(id)),new InlineKeyboard().text('✏️ Скорректировать программу','program:edit:'+id).row().text('⬅️ К клиенту','client:view:'+id));});
bot.callbackQuery(/^program:(?:new|edit):(\d+)$/,async ctx=>{
  const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();
  const p=await getTrainingProgram(id);
  if(!p){programSessions.set(ctx.from!.id,{clientId:id,kind:'program',step:'name',program:{client_id:id,name:'',goal:null,duration_weeks:null,comment:null}});return render(ctx,'🏋️ <b>Новая программа</b>\n\nВведите название программы:',new InlineKeyboard().text('❌ Отмена','program:cancel:'+id));}
  programSessions.set(ctx.from!.id,{clientId:id,kind:'program-edit',step:'edit-menu',program:{client_id:id,name:p.name,goal:p.goal,duration_weeks:p.duration_weeks,comment:p.comment}});
  await showProgramEditor(ctx,id);
});
async function showProgramEditor(ctx:Context,id:number){
  const p=await getTrainingProgram(id);if(!p)return showProgram(ctx,id);
  const days=await listTrainingProgramDays(id);
  const kb=new InlineKeyboard()
    .text('✏️ Изменить название','program:edit-name:'+id).row();
  for(const d of days){
    kb.text(`📅 День ${d.day_number} — ${d.name.replace(/^День\s*\d+\s*[—-]?\s*/i,'')}`,'program:edit-day:'+d.id).row();
  }
  kb.text('💾 Сохранить программу','program:edit-save:'+id).row().text('❌ Отмена','program:'+id);
  await render(ctx,'✏️ <b>КОРРЕКТИРОВКА ПРОГРАММЫ</b>\n\n📌 <b>'+esc(p.name)+'</b>\n\nВыберите, что изменить:',kb);
}
bot.callbackQuery(/^program:edit-name:(\d+)$/,async ctx=>{
  const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();
  const s=programSessions.get(ctx.from!.id);if(!s||s.kind!=='program-edit')return;
  s.step='edit-name';await render(ctx,'✏️ <b>Изменение названия</b>\n\nВведите новое название программы:',new InlineKeyboard().text('⬅️ Назад','program:edit:'+id));
});
bot.callbackQuery(/^program:edit-ex:(\d+)$/,async ctx=>{
  const exId=Number(ctx.match[1]);await ctx.answerCallbackQuery();
  const e=await getTrainingProgramExercise(exId);if(!e)return;
  const kb=new InlineKeyboard().text('🗑 Удалить','program:edit-ex-delete:'+exId).text('🔄 Поменять','program:edit-ex-change:'+exId).row().text('⬅️ Назад','program:edit:'+e.client_id);
  await render(ctx,`🏋️ <b>${esc(e.name)}</b>\n\nЧто сделать с упражнением?`,kb);
});
bot.callbackQuery(/^program:edit-ex-delete:(\d+)$/,async ctx=>{
  const exId=Number(ctx.match[1]);await ctx.answerCallbackQuery();
  const e=await getTrainingProgramExercise(exId);if(!e)return;
  await deleteTrainingProgramExercise(exId);
  await render(ctx,'🗑 Упражнение удалено из программы.',new InlineKeyboard().text('⬅️ К корректировке','program:edit:'+e.client_id));
});
bot.callbackQuery(/^program:edit-ex-change:(\d+)$/,async ctx=>{
  const exId=Number(ctx.match[1]);await ctx.answerCallbackQuery();
  const e=await getTrainingProgramExercise(exId);if(!e)return;
  const muscles=await listProgramCatalogMuscles();const kb=new InlineKeyboard();
  for(let i=0;i<muscles.length;i++)kb.text('💪 '+muscles[i],'program:muscle:'+exId+':'+i).row();
  kb.text('⬅️ Назад','program:edit:'+e.client_id);
  await render(ctx,'🔄 <b>Выберите мышечную группу</b>',kb);
});
bot.callbackQuery(/^program:muscle:(\d+):(.+)$/,async ctx=>{
  const exId=Number(ctx.match[1]),muscleIndex=Number(ctx.match[2]);await ctx.answerCallbackQuery();
  const muscles=await listProgramCatalogMuscles();const muscle=muscles[muscleIndex];if(!muscle)return;
  const e=await getTrainingProgramExercise(exId);if(!e)return;
  const exercises=await listProgramCatalogExercises(muscle);const kb=new InlineKeyboard();
  for(const x of exercises)kb.text('🏋️ '+x.name,'program:pick-ex:'+exId+':'+x.id).row();
  kb.text('⬅️ К мышцам','program:edit-ex-change:'+exId);
  await render(ctx,`💪 <b>${esc(muscle)}</b>\n\nВыберите упражнение:`,kb);
});
bot.callbackQuery(/^program:pick-ex:(\d+):(\d+)$/,async ctx=>{
  const exId=Number(ctx.match[1]),catalogId=Number(ctx.match[2]);await ctx.answerCallbackQuery();
  const e=await getTrainingProgramExercise(exId);if(!e)return;
  const all=await listProgramCatalogMuscles();let picked:any=null;
  for(const m of all){const xs=await listProgramCatalogExercises(m);picked=xs.find(x=>x.id===catalogId);if(picked)break;}
  if(!picked)return;
  const s=programSessions.get(ctx.from!.id)||{clientId:e.client_id,kind:'program-edit',step:'edit-menu',program:{client_id:e.client_id,name:'',goal:null,duration_weeks:null,comment:null}};
  s.kind='program-edit';s.step='edit-menu';s.exerciseId=exId;s.pendingExerciseName=picked.name;s.pendingExerciseMuscle=picked.muscle_group;programSessions.set(ctx.from!.id,s);
  await render(ctx,`🔄 <b>Новое упражнение</b>\n\nБыло: ${esc(e.name)}\nСтанет: <b>${esc(picked.name)}</b>\n\nНажмите «Сохранить», чтобы применить замену.`,new InlineKeyboard().text('💾 Сохранить замену','program:replace-save:'+exId).row().text('⬅️ Назад','program:edit-ex:'+exId));
});
bot.callbackQuery(/^program:replace-save:(\d+)$/,async ctx=>{
  const exId=Number(ctx.match[1]);await ctx.answerCallbackQuery();const s=programSessions.get(ctx.from!.id);
  if(!s||s.kind!=='program-edit'||s.exerciseId!==exId||!s.pendingExerciseName||!s.pendingExerciseMuscle)return;
  const e=await replaceTrainingProgramExercise(exId,s.pendingExerciseName,s.pendingExerciseMuscle);s.exerciseId=undefined;s.pendingExerciseName=undefined;s.pendingExerciseMuscle=undefined;
  if(!e)return render(ctx,'❌ Не удалось заменить упражнение.',new InlineKeyboard().text('⬅️ К корректировке','program:edit:'+s.clientId));
  await showProgramEditor(ctx,s.clientId);
});
bot.callbackQuery(/^program:edit-save:(\d+)$/,async ctx=>{
  const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();const s=programSessions.get(ctx.from!.id);
  if(!s||s.kind!=='program-edit'||!s.program)return;
  const p=await updateTrainingProgramName(id,s.program.name);programSessions.delete(ctx.from!.id);
  await render(ctx,'✅ <b>Программа сохранена в базе.</b>\n\n'+(p?programText(p,await listTrainingProgramDays(id)):'Программа сохранена.'),new InlineKeyboard().text('✏️ Скорректировать программу','program:edit:'+id).row().text('⬅️ К клиенту','client:view:'+id));
});
bot.callbackQuery(/^program:delete:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();const p=await getTrainingProgram(id);if(!p)return showProgram(ctx,id);await render(ctx,'⚠️ <b>Удалить тренировочную программу?</b>\\n\\n<b>'+esc(p.name)+'</b>\\n\\nБудут удалены программа, тренировочные дни и упражнения клиента. Это действие нельзя отменить.',new InlineKeyboard().text('🗑 Да, удалить','program:delete-confirm:'+id).row().text('⬅️ Отмена','program:'+id));});
bot.callbackQuery(/^program:delete-confirm:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();const ok=await deleteTrainingProgram(id);if(!ok)return render(ctx,'❌ Программа не найдена или уже удалена.',new InlineKeyboard().text('⬅️ К клиенту','client:view:'+id));await render(ctx,'✅ <b>Тренировочная программа удалена.</b>',new InlineKeyboard().text('🏋️ Создать/загрузить новую','program:'+id).row().text('⬅️ К клиенту','client:view:'+id));});
bot.callbackQuery(/^program:cancel:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();programSessions.delete(ctx.from!.id);await showProgram(ctx,id);});
bot.callbackQuery(/^program:skipgoal:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);const s=programSessions.get(ctx.from!.id);if(!s||s.kind!=='program'||!s.program)return;await ctx.answerCallbackQuery();s.program.goal=null;s.step='duration';await render(ctx,'Введите срок программы в неделях:',new InlineKeyboard().text('⏭ Пропустить','program:skipduration:'+s.clientId).row().text('❌ Отмена','program:cancel:'+s.clientId));});
bot.callbackQuery(/^program:day:new:(\d+)$/,async ctx=>{
  const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();
  const p=await getTrainingProgram(id);if(!p)return;
  programSessions.set(ctx.from!.id,{clientId:id,kind:'day',step:'name',program:{client_id:id,name:p.name,goal:p.goal,duration_weeks:p.duration_weeks,comment:p.comment}});
  const days=await listTrainingProgramDays(id);
  const nextDay=days.length+1;
  await render(ctx,'➕ <b>Добавление тренировочного дня</b>\n\nВведите название для Дня '+nextDay+':',new InlineKeyboard().text('❌ Отмена','program:'+id));
});
bot.callbackQuery(/^program:days:(\d+)$/,async ctx=>{
  const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();
  const days=await listTrainingProgramDays(id);
  const kb=new InlineKeyboard();
  for(const d of days)kb.text('🏋️ День '+d.day_number+' — '+d.name.replace(/^День\s*\d+\s*[—-]?\s*/i,''),'program:day:'+d.id).row();
  kb.text('⬅️ К программе','program:'+id);
  await render(ctx,days.length?'📋 <b>ТРЕНИРОВОЧНЫЕ ДНИ</b>\n\nВыберите день:':'📋 <b>ТРЕНИРОВОЧНЫЕ ДНИ</b>\n\nДни пока не созданы.',kb);
});
bot.callbackQuery(/^program:day:(\d+)$/,async ctx=>{
  const dayId=Number(ctx.match[1]);await ctx.answerCallbackQuery();
  const d=await getTrainingProgramDay(dayId);if(!d)return;
  const ex=await listTrainingProgramExercises(dayId);
  const lines=[dayTitle(d),''];
  ex.forEach((e,i)=>lines.push((i+1)+'. <b>'+esc(e.name)+'</b>'+(e.muscle_group?' — '+esc(e.muscle_group):'')+'\n   '+e.sets+' × '+esc(e.reps)+(e.rest_seconds!==null?' · отдых '+e.rest_seconds+' сек.':'')+(e.rir!==null?' · RIR '+e.rir:'')+(e.comment&&!/^Отдых:/i.test(e.comment)?'\n   📝 '+esc(e.comment):'')));
  const kb=new InlineKeyboard()
    .text('✏️ Скорректировать день','program:edit-day:'+dayId).row()
    .text('⬅️ К тренировочным дням','program:days:'+d.client_id).row()
    .text('⬅️ К программе','program:'+d.client_id);
  await render(ctx,lines.join('\n'),kb);
});
bot.callbackQuery(/^program:edit-day:(\d+)$/,async ctx=>{
  const dayId=Number(ctx.match[1]);await ctx.answerCallbackQuery();
  const d=await getTrainingProgramDay(dayId);if(!d)return;
  const ex=await listTrainingProgramExercises(dayId);
  const kb=new InlineKeyboard();
  for(const e of ex)kb.text('🏋️ '+e.name,'program:edit-ex:'+e.id).row();
  kb.text('➕ Добавить упражнение','program:exercise:new:'+dayId).row();
  kb.text('⬅️ К дню','program:day:'+dayId).row().text('⬅️ К программе','program:'+d.client_id);
  await render(ctx,dayTitle(d)+'\n\n✏️ <b>Корректировка дня</b>\n\nВыберите упражнение:',kb);
});
bot.callbackQuery(/^program:exercise:new:(\d+)$/,async ctx=>{
  const dayId=Number(ctx.match[1]);await ctx.answerCallbackQuery();
  const d=await getTrainingProgramDay(dayId);if(!d)return;
  programSessions.set(ctx.from!.id,{clientId:d.client_id,kind:'exercise',step:'name',dayId,exercise:{day_id:dayId}});
  await render(ctx,'➕ <b>Упражнение</b>\n\nВведите название упражнения:',new InlineKeyboard().text('❌ Отмена','program:day:'+dayId));
});
bot.callbackQuery(/^strategy:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();await showStrategy(ctx,id);});
bot.callbackQuery(/^strategy:(?:new|edit):(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();try{await loadStrategySession(ctx,id);await render(ctx,'🎯 <b>Стратегия тренировок</b>\n\nВыберите раздел для заполнения или изменения.',strategyMenu(id));}catch(e){console.error('[STRATEGY OPEN FAILED]',e);await render(ctx,'❌ Клиент не найден.',new InlineKeyboard().text('⬅️ К клиентам','clients'));}});
bot.callbackQuery(/^strategy:field:(\d+):(main_task|priorities|what_to_account_for|main_focus|trainer_decision)$/,async ctx=>{const id=Number(ctx.match[1]);const field=ctx.match[2] as StrategyField;await ctx.answerCallbackQuery();const s=await loadStrategySession(ctx,id);s.awaitingText=field;const labels:Record<StrategyField,string>={main_task:'🎯 Основная задача',priorities:'⭐ Приоритеты',what_to_account_for:'⚠️ Что учитывать',main_focus:'🔎 Основной фокус',trainer_decision:'📝 Решение / комментарий тренера'};await render(ctx,labels[field]+'\n\nВведите текст или нажмите «Пропустить».',new InlineKeyboard().text('⏭ Пропустить','strategy:skip:'+id+':'+field).row().text('⬅️ Назад к стратегии','strategy:menu:'+id));});
bot.callbackQuery(/^strategy:skip:(\d+):(main_task|priorities|what_to_account_for|main_focus|trainer_decision)$/,async ctx=>{const id=Number(ctx.match[1]);const field=ctx.match[2] as StrategyField;await ctx.answerCallbackQuery();const s=await loadStrategySession(ctx,id);s.draft[field]=null;s.awaitingText=undefined;await render(ctx,strategyText(s.draft),strategyMenu(id));});
bot.callbackQuery(/^strategy:menu:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();const s=await loadStrategySession(ctx,id);s.awaitingText=undefined;await render(ctx,strategyText(s.draft),strategyMenu(id));});
bot.callbackQuery(/^strategy:save:(\d+)$/,async ctx=>{const id=Number(ctx.match[1]);await ctx.answerCallbackQuery();const s=await loadStrategySession(ctx,id);try{const saved=await upsertTrainingStrategy(s.draft);strategySessions.delete(ctx.from!.id);await render(ctx,strategyText(saved),new InlineKeyboard().text('✏️ Изменить','strategy:edit:'+id).row().text('⬅️ Назад к клиенту','client:view:'+id));}catch(e){console.error('[STRATEGY SAVE FAILED]',e);await render(ctx,'❌ Не удалось сохранить стратегию.',strategyMenu(id));}});
bot.callbackQuery(/client:view:(\d+)/,async ctx=>{const callbackData=ctx.callbackQuery.data;const parsedClientId=Number(ctx.match[1]);console.info('[CLIENT BUTTON CLICK] callback_data=%s parsed_client_id=%s',callbackData,parsedClientId);await ctx.answerCallbackQuery();console.info('[CLIENT SELECT] client_id=%s',parsedClientId);const client=await getClient(parsedClientId);if(!client){console.warn('[CLIENT NOT FOUND] client_id=%s',parsedClientId);await render(ctx,'❌ Клиент не найден.',new InlineKeyboard().text('⬅️ К клиентам','clients'));return;}console.info('[CLIENT FOUND] client_id=%s',client.id);await render(ctx,clientCard(client),clientActions(client.id));});
bot.callbackQuery(/client:edit:(\d+)/,async ctx=>{const callbackData=ctx.callbackQuery.data;const id=Number(ctx.match[1]);console.info('[EDIT CLIENT CLICK] callback_data=%s client_id=%s',callbackData,id);await ctx.answerCallbackQuery();const client=await getClient(id);if(!client){console.warn('[EDIT CLIENT NOT FOUND] client_id=%s',id);await render(ctx,'❌ Клиент не найден.',new InlineKeyboard().text('⬅️ К клиентам','clients'));return;}console.info('[EDIT CLIENT FOUND] client_id=%s',client.id);await render(ctx,'✏️ <b>Что изменить?</b>',editMenu(client.id));});
bot.callbackQuery(/client:delete:(\d+)/,async ctx=>{const callbackData=ctx.callbackQuery.data;const id=Number(ctx.match[1]);console.info('[DELETE CLIENT CLICK] callback_data=%s client_id=%s',callbackData,id);await ctx.answerCallbackQuery();const client=await getClient(id);if(!client){console.warn('[DELETE CLIENT NOT FOUND] client_id=%s',id);await render(ctx,'❌ Клиент не найден.',new InlineKeyboard().text('⬅️ К клиентам','clients'));return;}console.info('[DELETE CLIENT FOUND] client_id=%s',client.id);await render(ctx,'⚠️ <b>Удалить клиента?</b>\n\n📱 Telegram: '+telegramLabel(client.telegram_username)+'\n\nЭто действие нельзя отменить.',new InlineKeyboard().text('🗑 Да, удалить','client:delete-confirm:'+client.id).row().text('⬅️ Отмена','client:view:'+client.id));});
bot.callbackQuery(/client:delete-confirm:(\d+)/,async ctx=>{const callbackData=ctx.callbackQuery.data;const id=Number(ctx.match[1]);console.info('[CONFIRM DELETE CLIENT CLICK] callback_data=%s client_id=%s',callbackData,id);await ctx.answerCallbackQuery();const client=await getClient(id);if(!client){console.warn('[DELETE CONFIRM NOT FOUND] client_id=%s',id);await render(ctx,'❌ Клиент не найден.',new InlineKeyboard().text('⬅️ К клиентам','clients'));return;}const ok=await deleteClient(id);console.info('[CLIENT DELETE RESULT] client_id=%s deleted=%s',id,ok);if(ok)await render(ctx,'✅ Клиент удалён.',new InlineKeyboard().text('⬅️ К клиентам','clients'));else await render(ctx,'❌ Не удалось удалить клиента.',new InlineKeyboard().text('⬅️ К клиентам','clients'));});

const editPrompts:Partial<Record<keyof ClientDraft,string>>={
  telegram_username:'Введите Telegram username клиента или нажмите «Пропустить»:',
  age:'Введите возраст клиента:',height_cm:'Введите рост клиента в см:',weight_kg:'Введите текущий вес клиента в кг:',
  goal:'Выберите основную цель клиента:',experience:'Выберите тренировочный опыт:',workouts_per_week:'Сколько тренировок в неделю планируется?',
  training_location:'Где клиент будет тренироваться?',limitations:'Введите ограничения текстом:',note:'Введите дополнительную заметку:'
};
bot.callbackQuery(/editfield:(\d+):(.+)/,async ctx=>{const id=Number(ctx.match[1]);const field=ctx.match[2] as keyof ClientDraft;const allowed=Object.keys(editPrompts);if(!allowed.includes(field) || !editPrompts[field])return;await ctx.answerCallbackQuery();editSessions.set(ctx.from.id,{clientId:id,field});await render(ctx,editPrompts[field]!,editChoices(field));});
bot.callbackQuery('edittelegram:skip',async ctx=>{const s=editSessions.get(ctx.from.id);if(!s||s.field!=='telegram_username')return;await ctx.answerCallbackQuery();const c=await updateClientField(s.clientId,'telegram_username',null);editSessions.delete(ctx.from.id);if(c)await showClient(ctx,c.id);});
bot.callbackQuery('editcancel',async ctx=>{await ctx.answerCallbackQuery();const s=editSessions.get(ctx.from.id);editSessions.delete(ctx.from.id);if(s)await showClient(ctx,s.clientId);});
for(const [label,data] of GOALS) bot.callbackQuery('edit:'+data,async ctx=>{const s=editSessions.get(ctx.from.id);if(!s||s.field!=='goal')return;await ctx.answerCallbackQuery();const c=await updateClientField(s.clientId,'goal',label);editSessions.delete(ctx.from.id);if(c)await showClient(ctx,c.id);});
for(const [label,data] of EXPERIENCES) bot.callbackQuery('edit:'+data,async ctx=>{const s=editSessions.get(ctx.from.id);if(!s||s.field!=='experience')return;await ctx.answerCallbackQuery();const c=await updateClientField(s.clientId,'experience',label);editSessions.delete(ctx.from.id);if(c)await showClient(ctx,c.id);});
for(const [label,data] of FREQUENCIES) bot.callbackQuery('edit:'+data,async ctx=>{const s=editSessions.get(ctx.from.id);if(!s||s.field!=='workouts_per_week')return;await ctx.answerCallbackQuery();const c=await updateClientField(s.clientId,'workouts_per_week',Number(data.slice(5)));editSessions.delete(ctx.from.id);if(c)await showClient(ctx,c.id);});
for(const [label,data] of LOCATIONS) bot.callbackQuery('edit:'+data,async ctx=>{const s=editSessions.get(ctx.from.id);if(!s||s.field!=='training_location')return;await ctx.answerCallbackQuery();const c=await updateClientField(s.clientId,'training_location',label);editSessions.delete(ctx.from.id);if(c)await showClient(ctx,c.id);});

bot.on('message:text',async ctx=>{
  const uid=ctx.from.id,t=ctx.message.text.trim();
  if(t.startsWith('/'))return;
  const add=addSessions.get(uid);
  if(add) console.info('[FSM] incoming state=%s input=%j',add.step,t);
  if(add){
    if(add.step==='telegram_username'){
      if(!t)return ctx.reply('Введите username или нажмите «Пропустить».');
      const username=t.replace(/^@/,'').trim();
      if(!/^[A-Za-z0-9_]{5,32}$/.test(username)) return ctx.reply('Введите корректный Telegram username или нажмите «Пропустить».');
      add.draft.telegram_username=username; add.draft.telegram_user_id=null; add.draft.telegram_first_name=null; add.draft.telegram_last_name=null; add.draft.name='@'+username; add.step='age';
      return promptAdd(ctx,add);
    }
    if(add.step==='age'){
      console.info('[FSM] state=AGE input=%j handler=AGE',t);
      const n=Number(t);
      if(!/^\d+$/.test(t)||!Number.isInteger(n)||n<10||n>100){console.info('[FSM] state=AGE rejected next=AGE');return ctx.reply(n>=1&&n<=120?'Введите корректный возраст.':'Введите возраст числом.');}
      add.draft.age=n; add.step='height';
      console.info('[FSM] state=AGE accepted age=%d next=HEIGHT',n);
      return promptAdd(ctx,add);
    }
    if(add.step==='height'){console.info('[FSM] state=HEIGHT input=%j handler=HEIGHT',t);const n=positiveNumber(t);if(n===null||n>300){console.info('[FSM] state=HEIGHT rejected next=HEIGHT');return ctx.reply('Введите рост числом.');}add.draft.height_cm=n;add.step='weight';console.info('[FSM] state=HEIGHT accepted next=WEIGHT');return promptAdd(ctx,add);}
    if(add.step==='weight'){console.info('[FSM] state=WEIGHT input=%j handler=WEIGHT',t);const n=positiveNumber(t);if(n===null||n>500){console.info('[FSM] state=WEIGHT rejected next=WEIGHT');return ctx.reply('Введите вес числом.');}add.draft.weight_kg=n;add.step='goal';console.info('[FSM] state=WEIGHT accepted next=GOAL');return promptAdd(ctx,add);}
    if(add.step==='custom_goal'){if(!t)return ctx.reply('Введите цель текстом.');add.draft.goal=t;add.step='experience';return promptAdd(ctx,add);}
    if(add.step==='limitations_text'){if(!t)return ctx.reply('Введите ограничения текстом.');add.draft.limitations=t;add.step='note';return promptAdd(ctx,add);}
    if(add.step==='note'){add.draft.note=t||'Нет';if(complete(add.draft))return render(ctx,summary(add.draft),confirmKb());}
  }
  const assessment=assessmentSessions.get(uid);
  if(assessment?.awaitingText){
    if(!t)return ctx.reply('Введите текст или нажмите «Пропустить».');
    (assessment.draft as any)[assessment.awaitingText]=t;
    assessment.awaitingText=undefined;
    return render(ctx,assessmentText(assessment.draft),assessmentMenu(assessment.clientId));
  }

  const programSession=programSessions.get(uid);
  if(programSession?.kind==='program-edit'&&programSession.step==='edit-name'&&programSession.program){
    if(!t)return ctx.reply('Введите название программы.');
    programSession.program.name=t;
    programSession.step='edit-menu';
    return showProgramEditor(ctx,programSession.clientId);
  }
  if(programSession){
    const s=programSession;
    if(!t)return ctx.reply('Введите значение текстом.');
    if(s.kind==='program'&&s.program){
      if(s.step==='name'){s.program.name=t;s.step='goal';return render(ctx,'Введите цель программы:',new InlineKeyboard().text('⏭ Пропустить','program:skipgoal:'+s.clientId).row().text('❌ Отмена','program:cancel:'+s.clientId));}
      if(s.step==='goal'){s.program.goal=t==='Нет'?null:t;s.step='duration';return render(ctx,'Введите срок программы в неделях:',new InlineKeyboard().text('⏭ Пропустить','program:skipduration:'+s.clientId).row().text('❌ Отмена','program:cancel:'+s.clientId));}
      if(s.step==='duration'){const n=Number(t.trim());if(!Number.isInteger(n)||n<1||n>104)return ctx.reply('❌ Введите целое число от 1 до 104.');s.program.duration_weeks=n;s.step='comment';return render(ctx,'Введите комментарий или «Нет».',new InlineKeyboard().text('💾 Сохранить','program:save:'+s.clientId).row().text('❌ Отмена','program:cancel:'+s.clientId));}
      if(s.step==='comment'){s.program.comment=t==='Нет'?null:t;return render(ctx,'🏋️ <b>Проверьте программу</b>\n\n'+programText(s.program,[]),new InlineKeyboard().text('💾 Сохранить','program:save:'+s.clientId).row().text('❌ Отмена','program:cancel:'+s.clientId));}
    }
    if(s.kind==='day'&&s.step==='name'){const d=await createTrainingProgramDay(s.clientId,t);programSessions.delete(uid);return render(ctx,'✅ День добавлен.\n\n🏋️ '+esc(d.name),new InlineKeyboard().text('➕ Добавить упражнение','program:exercise:new:'+d.id).row().text('⬅️ К программе','program:'+s.clientId));}
    if(s.kind==='exercise-edit'&&s.exercise&&s.exerciseId){
      if(s.step==='name'){s.exercise.name=t;s.step='muscle';return ctx.reply('Введите мышечную группу:');}
      if(s.step==='muscle'){s.exercise.muscle_group=t==='Нет'?null:t;s.step='sets';return ctx.reply('Введите количество подходов:');}
      if(s.step==='sets'){const n=Number(t.trim());if(!Number.isInteger(n)||n<1||n>20)return ctx.reply('❌ Введите количество подходов целым числом от 1 до 20.');s.exercise.sets=n;s.step='reps';return ctx.reply('Введите количество повторений (например, 8-10):');}
      if(s.step==='reps'){s.exercise.reps=t;s.step='rest';return ctx.reply('Введите отдых в секундах или «Нет»:');}
      if(s.step==='rest'){if(t==='Нет')s.exercise.rest_seconds=null;else{const n=Number(t.trim());if(!Number.isInteger(n)||n<0||n>900)return ctx.reply('❌ Введите отдых целым числом от 0 до 900 секунд или «Нет».');s.exercise.rest_seconds=n;}s.step='rir';return ctx.reply('Введите RIR от 0 до 5 или «Нет»:');}
      if(s.step==='rir'){if(t==='Нет')s.exercise.rir=null;else{const n=Number(t.trim());if(!Number.isFinite(n)||n<0||n>5)return ctx.reply('❌ Введите RIR от 0 до 5 или «Нет».');s.exercise.rir=n;}s.step='comment';return ctx.reply('Введите комментарий или «Нет»:');}
      if(s.step==='comment'){s.exercise.comment=t==='Нет'?null:t;const ex=await updateTrainingProgramExercise({id:s.exerciseId,name:String(s.exercise.name),muscle_group:s.exercise.muscle_group??null,sets:Number(s.exercise.sets),reps:String(s.exercise.reps),rest_seconds:s.exercise.rest_seconds??null,rir:s.exercise.rir??null,comment:s.exercise.comment??null});programSessions.delete(uid);if(!ex)return ctx.reply('❌ Не удалось сохранить упражнение.');return render(ctx,'✅ Упражнение скорректировано и сохранено.',new InlineKeyboard().text('⬅️ К тренировке','program:day:'+ex.day_id));}
    }
    if(s.kind==='exercise'&&s.exercise){
      if(s.step==='name'){s.exercise.name=t;s.step='muscle';return ctx.reply('Введите мышечную группу:');}
      if(s.step==='muscle'){s.exercise.muscle_group=t==='Нет'?null:t;s.step='sets';return ctx.reply('Введите количество подходов:');}
      if(s.step==='sets'){const n=Number(t.trim());if(!Number.isInteger(n)||n<1||n>20)return ctx.reply('❌ Введите количество подходов целым числом от 1 до 20.');s.exercise.sets=n;s.step='reps';return ctx.reply('Введите количество повторений (например, 8-10):');}
      if(s.step==='reps'){s.exercise.reps=t;s.step='rest';return ctx.reply('Введите отдых в секундах или «Нет»:');}
      if(s.step==='rest'){if(t==='Нет')s.exercise.rest_seconds=null;else{const n=Number(t.trim());if(!Number.isInteger(n)||n<0||n>900)return ctx.reply('❌ Введите отдых целым числом от 0 до 900 секунд или «Нет».');s.exercise.rest_seconds=n;}s.step='rir';return ctx.reply('Введите RIR от 0 до 5 или «Нет»:');}
      if(s.step==='rir'){if(t==='Нет')s.exercise.rir=null;else{const n=Number(t.trim());if(!Number.isFinite(n)||n<0||n>5)return ctx.reply('❌ Введите RIR от 0 до 5 или «Нет».');s.exercise.rir=n;}s.step='comment';return ctx.reply('Введите комментарий или «Нет»:');}
      if(s.step==='comment'){s.exercise.comment=t==='Нет'?null:t;const ex=await createTrainingProgramExercise(s.exercise as Omit<TrainingProgramExercise,'id'|'created_at'|'exercise_order'>);programSessions.delete(uid);return render(ctx,'✅ Упражнение добавлено.\n\n'+esc(ex.name),new InlineKeyboard().text('➕ Добавить ещё','program:exercise:new:'+ex.day_id).row().text('⬅️ К тренировке','program:day:'+ex.day_id));}
    }
  }
  const strategy=strategySessions.get(uid);
  if(strategy?.awaitingText){
    if(!t)return ctx.reply('Введите текст или нажмите «Пропустить».');
    (strategy.draft as any)[strategy.awaitingText]=t;
    strategy.awaitingText=undefined;
    return render(ctx,strategyText(strategy.draft),strategyMenu(strategy.clientId));
  }
  const edit=editSessions.get(uid);
  if(edit){
    try{
      let value:string|number=t;
      if(edit.field==='age'){const n=Number(t);if(!/^\d+$/.test(t)||!Number.isInteger(n)||n<1||n>120)return ctx.reply('Введите возраст числом.');value=n;}
      if(edit.field==='height_cm'){const n=positiveNumber(t);if(n===null||n>300)return ctx.reply('Введите рост числом.');value=n;}
      if(edit.field==='weight_kg'){const n=positiveNumber(t);if(n===null||n>500)return ctx.reply('Введите вес числом.');value=n;}
      if(edit.field==='telegram_username'){if(!/^[A-Za-z0-9_]{5,32}$/.test(t.replace(/^@/,'')))return ctx.reply('Введите корректный Telegram username или нажмите «Пропустить».');value=t.replace(/^@/,'');}
      const c=await updateClientField(edit.clientId,edit.field,value);editSessions.delete(uid);if(c)await showClient(ctx,c.id);
    }catch(e){console.error(e);await ctx.reply('Не удалось сохранить изменение.');}
  }
});

bot.catch(e=>console.error('Telegram bot error',e));
void migrateStage1Schema().then(()=>migrateStage2AssessmentSchema()).then(()=>migrateStage3StrategySchema()).then(()=>migrateStage4ProgramSchema()).then(()=>migrateStage4TemplateSchema()).then(()=>migrateNextBaseTemplateSchema()).then(()=>migrateFollowingBaseTemplateSchema()).then(()=>migrateUpperLowerSpecializationTemplateSchema()).then(()=>migrateFullBodyUpperLowerTemplateSchema()).then(()=>migrateTrainingProgramCatalogOrderSchema()).then(()=>logDatabaseDiagnostics()).catch(e=>{console.error('[DB MIGRATION] Failed:',e);process.exit(1);});
const server=createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}));return;}res.writeHead(404);res.end();});
server.listen(PORT,()=>console.log('HTTP health server listening on '+PORT));
async function shutdown(signal:string){console.log('Received '+signal+', shutting down');await bot.stop();await closeDb();server.close();process.exit(0);}
process.once('SIGINT',()=>void shutdown('SIGINT'));process.once('SIGTERM',()=>void shutdown('SIGTERM'));
void bot.start({onStart:info=>console.log('Bot @'+info.username+' started')});
