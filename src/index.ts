const EXPERIENCES = [['🟢 Новичок','exp:beginner'],['🟡 Средний','exp:intermediate'],['🔴 Продвинутый','exp:advanced']] as const;
const FREQUENCIES = [['2','freq:2'],['3','freq:3'],['4','freq:4'],['5+','freq:5']] as const;
const LOCATIONS = [['🏠 Дом','loc:home'],['🏋️ Зал','loc:gym'],['🌳 Спортплощадка','loc:outdoor'],['🔄 Комбинированный вариант','loc:mixed']] as const;

const MAIN_MENU = new InlineKeyboard()
  .text('👤 Клиенты','clients').row()
  .text('📝 Заметки','notes');

function isAdmin(ctx: Context) { return ctx.from?.id === ADMIN_ID; }
function esc(v: unknown) { return String(v ?? '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]!)); }
function mainText() { return '👋 Добро пожаловать в рабочий кабинет тренера.\n\n<b>Главное меню:</b>'; }

async function render(ctx: Context, text: string, keyboard?: InlineKeyboard) {
  if (ctx.callbackQuery?.message) {
    try { await ctx.editMessageText(text, { parse_mode:'HTML', reply_markup:keyboard }); return; }
    catch(e) { console.error('[RENDER EDIT FAILED]', { update_id:ctx.update.update_id, error:e instanceof Error ? e.message : String(e) }); }
  }
  try { await ctx.reply(text, { parse_mode:'HTML', reply_markup:keyboard }); }
  catch(e) { console.error('[RENDER REPLY FAILED]', { update_id:ctx.update.update_id, error:e instanceof Error ? e.message : String(e) }); throw e; }
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
  return new InlineKeyboard()
    .text('🏋️ Выполнить тренировку','wr:program:'+id).row()
    .text('🧩 Первичная оценка','assessment:'+id).row()
    .text('🎯 Стратегия тренировок','strategy:'+id).row()
    .text('🏋️ Тренировочная программа','program:'+id).row()
    .text('✏️ Редактировать','client:edit:'+id).row()
    .text('🗑 Удалить клиента','client:delete:'+id).row()
    .text('⬅️ К клиентам','clients').row()
    .text('🏠 Главное меню','main');
}
async function showClient(ctx:Context,id:number) {
  const c=await getClient(id);
  if(!c) return render(ctx,'Клиент не найден.',new InlineKeyboard().text('⬅️ К клиентам','clients'));
  await render(ctx,clientCard(c),clientActions(id));
}

function cancelKb(data='client:add-cancel') { return new InlineKeyboard().text('❌ Отмена',data); }
function choices(rows:readonly (readonly [string,string])[],cancel='client:add-cancel') {