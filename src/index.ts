import 'dotenv/config';
import { createServer } from 'node:http';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import { closeDb, createClient, deleteClient, getClient, listClients, updateClientField } from './db.js';
import type { Client, ClientDraft, AddSession } from './types.js';

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
function mainText() { return '👋 Добро пожаловать в рабочий кабинет тренера.\\n\\n<b>Главное меню:</b>'; }

async function render(ctx: Context, text: string, keyboard?: InlineKeyboard) {
  if (ctx.callbackQuery?.message) {
    try { await ctx.editMessageText(text, { parse_mode:'HTML', reply_markup:keyboard }); return; } catch {}
  }
  await ctx.reply(text, { parse_mode:'HTML', reply_markup:keyboard });
}

async function showMain(ctx: Context) { await render(ctx, mainText(), MAIN_MENU); }

function clientDisplayName(c: Client) { return c.telegram_username ? '@' + c.telegram_username : [c.telegram_first_name, c.telegram_last_name].filter(Boolean).join(' '); }
function clientsKeyboard(clients: Client[]) {
  const kb = new InlineKeyboard().text('➕ Добавить клиента','client:add').row();
  for (const c of clients) kb.text('👤 ' + clientDisplayName(c),'client:view:' + c.id).row();
  return kb.text('⬅️ Назад','main');
}
async function showClients(ctx: Context) {
  const clients = await listClients();
  await render(ctx, clients.length ? '👤 <b>КЛИЕНТЫ</b>' : '👤 <b>КЛИЕНТЫ</b>\\n\\nУ вас пока нет клиентов.', clientsKeyboard(clients));
}

function goalLabel(key:string) { return Object.fromEntries(GOALS.map(([l,k])=>[k.slice(5),l]))[key] ?? key; }
function expLabel(key:string) { return Object.fromEntries(EXPERIENCES.map(([l,k])=>[k.slice(4),l]))[key] ?? key; }
function locLabel(key:string) { return Object.fromEntries(LOCATIONS.map(([l,k])=>[k.slice(4),l]))[key] ?? key; }

function clientCard(c:Client) {
  return [
    `👤 <b>${esc(clientDisplayName(c))}</b>`, '',
    `Возраст: ${c.age}`, `Рост: ${c.height_cm} см`, `Вес: ${c.weight_kg} кг`, '',
    `🎯 Цель: ${esc(c.goal)}`, `🏋️ Опыт: ${esc(c.experience)}`,
    `📅 Тренировок в неделю: ${c.workouts_per_week === 5 ? '5+' : c.workouts_per_week}`,
    `📍 Место: ${esc(c.training_location)}`, '',
    `⚠️ Ограничения: ${esc(c.limitations) || 'Нет'}`,
    `📝 Заметка: ${esc(c.note) || 'Нет'}`, '',
    `Дата добавления: ${new Date(c.created_at).toLocaleString('ru-RU')}`
  ].join('\\n');
}
function clientActions(id:number) {
  return new InlineKeyboard().text('✏️ Редактировать','client:edit:'+id).row()
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
    custom_goal:'Напишите цель клиента вручную:', experience:'Выберите тренировочный опыт:',
    frequency:'Сколько тренировок в неделю планируется?', location:'Где клиент будет тренироваться?',
    limitations_choice:'Есть ли ограничения, которые нужно учитывать при составлении программы?',
    limitations_text:'Напишите ограничения текстом:',
    note:'Добавьте дополнительную заметку о клиенте или нажмите «Пропустить».'
  };
  let kb:InlineKeyboard|undefined=cancelKb();
  if(s.step==='goal') kb=choices(GOALS);
  if(s.step==='experience') kb=choices(EXPERIENCES);
  if(s.step==='frequency') kb=choices(FREQUENCIES);
  if(s.step==='location') kb=choices(LOCATIONS);
  if(s.step==='limitations_choice') kb=choices([['Нет','limit:no'],['Да','limit:yes']]);
  if(s.step==='note') kb=new InlineKeyboard().text('⏭ Пропустить','note:skip').row().text('❌ Отмена','client:add-cancel');
  await render(ctx,prompts[s.step],kb);
}
function positiveNumber(t:string) { const x=t.trim().replace(',','.'); if(!/^(?:\\d+|\\d+\\.\\d+)$/.test(x)) return null; const n=Number(x); return Number.isFinite(n)&&n>0?n:null; }
function complete(d:Partial<ClientDraft>): d is ClientDraft {
  return typeof d.telegram_user_id==='number' && typeof d.telegram_first_name==='string' && typeof d.age==='number' && d.age>=1 && d.age<=120
    && typeof d.height_cm==='number' && d.height_cm>0 && d.height_cm<=300
    && typeof d.weight_kg==='number' && d.weight_kg>0 && d.weight_kg<=500
    && typeof d.goal==='string' && typeof d.experience==='string' && typeof d.workouts_per_week==='number'
    && typeof d.training_location==='string' && typeof d.limitations==='string' && typeof d.note==='string';
}
function summary(d:ClientDraft) {
  return ['👤 <b>Новый клиент</b>','',`Telegram: ${esc(d.telegram_username ? '@'+d.telegram_username : [d.telegram_first_name,d.telegram_last_name].filter(Boolean).join(' '))}`,`Возраст: ${d.age}`,`Рост: ${d.height_cm} см`,`Вес: ${d.weight_kg} кг`,'',
    `🎯 Цель: ${esc(d.goal)}`,`🏋️ Опыт: ${esc(d.experience)}`,`📅 Тренировок в неделю: ${d.workouts_per_week===5?'5+':d.workouts_per_week}`,
    `📍 Место: ${esc(d.training_location)}`,`⚠️ Ограничения: ${esc(d.limitations)||'Нет'}`,`📝 Заметка: ${esc(d.note)||'Нет'}`].join('\\n');
}
function confirmKb() { return new InlineKeyboard().text('✅ Сохранить','client:save').row().text('✏️ Изменить','client:change').row().text('❌ Отмена','client:add-cancel'); }

function editMenu(id:number) {
  return new InlineKeyboard()
      .text('Возраст','editfield:'+id+':age').row()
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
bot.callbackQuery('client:add',async ctx=>{await ctx.answerCallbackQuery();addSessions.set(ctx.from.id,{step:'age',draft:{telegram_user_id:ctx.from.id, telegram_username:ctx.from.username ?? null, telegram_first_name:ctx.from.first_name, telegram_last_name:ctx.from.last_name ?? null}});await promptAdd(ctx,addSessions.get(ctx.from.id)!);});
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

bot.callbackQuery('client:save',async ctx=>{await ctx.answerCallbackQuery();const s=addSessions.get(ctx.from.id);if(!s||!complete(s.draft))return;try{const c=await createClient(s.draft);addSessions.delete(ctx.from.id);await render(ctx,'✅ Клиент успешно добавлен.\\n\\n'+clientCard(c),clientActions(c.id));}catch(e){console.error(e);await render(ctx,'Не удалось сохранить клиента. Попробуйте ещё раз.',new InlineKeyboard().text('⬅️ К клиентам','clients'));}});
bot.callbackQuery('client:change',async ctx=>{await ctx.answerCallbackQuery();const s=addSessions.get(ctx.from.id);if(!s||!complete(s.draft))return;await render(ctx,'✏️ <b>Что изменить?</b>',new InlineKeyboard() .text('Возраст','addedit:age').row().text('Рост','addedit:height').text('Вес','addedit:weight').row().text('Цель','addedit:goal').text('Опыт','addedit:experience').row().text('Тренировки','addedit:frequency').text('Место','addedit:location').row().text('Ограничения','addedit:limitations').text('Заметка','addedit:note').row().text('⬅️ К подтверждению','addedit:back'));});

const addFieldSteps:Record<string,AddSession['step']>={age:'age',height:'height',weight:'weight',goal:'goal',experience:'experience',frequency:'frequency',location:'location',limitations:'limitations_text',note:'note'};
bot.callbackQuery(/addedit:(.+)/,async ctx=>{const key=ctx.match[1];const s=addSessions.get(ctx.from.id);if(!s)return;await ctx.answerCallbackQuery();if(key==='back'){if(complete(s.draft))await render(ctx,summary(s.draft),confirmKb());return;}const step=addFieldSteps[key];if(!step)return;s.step=step;await promptAdd(ctx,s);});

bot.callbackQuery(/client:view:(\\d+)/,async ctx=>{await ctx.answerCallbackQuery();await showClient(ctx,Number(ctx.match[1]));});
bot.callbackQuery(/client:edit:(\\d+)/,async ctx=>{await ctx.answerCallbackQuery();await render(ctx,'✏️ <b>Что изменить?</b>',editMenu(Number(ctx.match[1])));});
bot.callbackQuery(/client:delete:(\\d+)/,async ctx=>{await ctx.answerCallbackQuery();const id=Number(ctx.match[1]);await render(ctx,'Вы действительно хотите удалить клиента?\\n\\nЭто действие нельзя отменить.',new InlineKeyboard().text('❌ Нет','client:view:'+id).text('🗑 Да, удалить','client:delete-confirm:'+id));});
bot.callbackQuery(/client:delete-confirm:(\\d+)/,async ctx=>{await ctx.answerCallbackQuery();const ok=await deleteClient(Number(ctx.match[1]));if(ok)await showClients(ctx);else await render(ctx,'Клиент уже удалён.',new InlineKeyboard().text('⬅️ К клиентам','clients'));});

const editPrompts:Record<keyof ClientDraft,string>={
  name:'Введите имя клиента:',age:'Введите возраст клиента:',height_cm:'Введите рост клиента в см:',weight_kg:'Введите текущий вес клиента в кг:',
  goal:'Выберите основную цель клиента:',experience:'Выберите тренировочный опыт:',workouts_per_week:'Сколько тренировок в неделю планируется?',
  training_location:'Где клиент будет тренироваться?',limitations:'Введите ограничения текстом:',note:'Введите дополнительную заметку:'
};
bot.callbackQuery(/editfield:(\\d+):(.+)/,async ctx=>{const id=Number(ctx.match[1]);const field=ctx.match[2] as keyof ClientDraft;const allowed=Object.keys(editPrompts);if(!allowed.includes(field))return;await ctx.answerCallbackQuery();editSessions.set(ctx.from.id,{clientId:id,field});await render(ctx,editPrompts[field],editChoices(field));});
bot.callbackQuery('editcancel',async ctx=>{await ctx.answerCallbackQuery();const s=editSessions.get(ctx.from.id);editSessions.delete(ctx.from.id);if(s)await showClient(ctx,s.clientId);});
for(const [label,data] of GOALS) bot.callbackQuery('edit:'+data,async ctx=>{const s=editSessions.get(ctx.from.id);if(!s||s.field!=='goal')return;await ctx.answerCallbackQuery();const c=await updateClientField(s.clientId,'goal',label);editSessions.delete(ctx.from.id);if(c)await showClient(ctx,c.id);});
for(const [label,data] of EXPERIENCES) bot.callbackQuery('edit:'+data,async ctx=>{const s=editSessions.get(ctx.from.id);if(!s||s.field!=='experience')return;await ctx.answerCallbackQuery();const c=await updateClientField(s.clientId,'experience',label);editSessions.delete(ctx.from.id);if(c)await showClient(ctx,c.id);});
for(const [label,data] of FREQUENCIES) bot.callbackQuery('edit:'+data,async ctx=>{const s=editSessions.get(ctx.from.id);if(!s||s.field!=='workouts_per_week')return;await ctx.answerCallbackQuery();const c=await updateClientField(s.clientId,'workouts_per_week',Number(data.slice(5)));editSessions.delete(ctx.from.id);if(c)await showClient(ctx,c.id);});
for(const [label,data] of LOCATIONS) bot.callbackQuery('edit:'+data,async ctx=>{const s=editSessions.get(ctx.from.id);if(!s||s.field!=='training_location')return;await ctx.answerCallbackQuery();const c=await updateClientField(s.clientId,'training_location',label);editSessions.delete(ctx.from.id);if(c)await showClient(ctx,c.id);});

bot.on('message:text',async ctx=>{
  const uid=ctx.from.id,t=ctx.message.text.trim();
  if(t.startsWith('/'))return;
  const add=addSessions.get(uid);
  if(add){
    if(add.step==='age'){const n=Number(t);if(!/^\\d+$/.test(t)||!Number.isInteger(n)||n<1||n>120)return ctx.reply('Введите возраст числом.');add.draft.age=n;add.step='height';return promptAdd(ctx,add);}
    if(add.step==='height'){const n=positiveNumber(t);if(n===null||n>300)return ctx.reply('Введите рост числом.');add.draft.height_cm=n;add.step='weight';return promptAdd(ctx,add);}
    if(add.step==='weight'){const n=positiveNumber(t);if(n===null||n>500)return ctx.reply('Введите вес числом.');add.draft.weight_kg=n;add.step='goal';return promptAdd(ctx,add);}
    if(add.step==='custom_goal'){if(!t)return ctx.reply('Введите цель текстом.');add.draft.goal=t;add.step='experience';return promptAdd(ctx,add);}
    if(add.step==='limitations_text'){if(!t)return ctx.reply('Введите ограничения текстом.');add.draft.limitations=t;add.step='note';return promptAdd(ctx,add);}
    if(add.step==='note'){add.draft.note=t||'Нет';if(complete(add.draft))return render(ctx,summary(add.draft),confirmKb());}
  }
  const edit=editSessions.get(uid);
  if(edit){
    try{
      let value:string|number=t;
      if(edit.field==='age'){const n=Number(t);if(!/^\\d+$/.test(t)||!Number.isInteger(n)||n<1||n>120)return ctx.reply('Введите возраст числом.');value=n;}
      if(edit.field==='height_cm'){const n=positiveNumber(t);if(n===null||n>300)return ctx.reply('Введите рост числом.');value=n;}
      if(edit.field==='weight_kg'){const n=positiveNumber(t);if(n===null||n>500)return ctx.reply('Введите вес числом.');value=n;}
      if(edit.field==='name') return ctx.reply('Имя клиента берётся из Telegram-профиля и не редактируется.');
      const c=await updateClientField(edit.clientId,edit.field,value);editSessions.delete(uid);if(c)await showClient(ctx,c.id);
    }catch(e){console.error(e);await ctx.reply('Не удалось сохранить изменение.');}
  }
});

bot.catch(e=>console.error('Telegram bot error',e));
const server=createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}));return;}res.writeHead(404);res.end();});
server.listen(PORT,()=>console.log('HTTP health server listening on '+PORT));
async function shutdown(signal:string){console.log('Received '+signal+', shutting down');await bot.stop();await closeDb();server.close();process.exit(0);}
process.once('SIGINT',()=>void shutdown('SIGINT'));process.once('SIGTERM',()=>void shutdown('SIGTERM'));
void bot.start({onStart:info=>console.log('Bot @'+info.username+' started')});
