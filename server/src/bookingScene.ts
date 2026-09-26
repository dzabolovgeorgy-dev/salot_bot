import { Context, Scenes } from "telegraf";
import { isWorkDay, generateTimeSlots, slotStep, type MasterSchedule } from "./schedule.js";
import { internalHeaders } from "./internalAuth.js";
import { t, type Lang } from "./i18n.js";

interface InlineButton {
  text: string;
  callback_data: string;
}

export const API_BASE = `http://localhost:${process.env.PORT ?? 3000}/api`;

// Текст постоянной кнопки быстрой записи внизу чата (задаётся в bot.ts) —
// экспортируем отсюда, чтобы bot.ts мог её импортировать, не создавая
// круговую зависимость (bot.ts и так уже импортирует эту сцену)
export function bookButtonText(lang: Lang): string {
  return t(lang, "bot.bookButton");
}

// Заголовок для запросов к нашему же API — чтобы имена услуг и описания
// мастеров пришли на языке пользователя (а если перевода нет — по-русски)
function langHeaders(lang: Lang): Record<string, string> {
  return { "X-Lang": lang };
}

// Кнопки "Перенести"/"Отменить" под уведомлением о записи в чате — используются
// и в api.ts (когда шлёт подтверждение записи), и в bot.ts (чтобы вернуть их
// после того как человек передумал отменять — см. cancelbk_no)
export function bookingActionButtons(bookingId: number, lang: Lang): InlineButton[][] {
  return [
    [
      { text: t(lang, "buttons.reschedule"), callback_data: `resched:${bookingId}` },
      { text: t(lang, "buttons.cancelBooking"), callback_data: `cancelbk:${bookingId}` },
    ],
  ];
}

// Те же кнопки плюс "Опаздываю" — только под напоминанием (reminders.ts):
// сообщить, что вот-вот начнётся запись, а предупредить об опоздании раньше
// времени смысла нет — поэтому не добавляем эту кнопку в bookingActionButtons,
// который используется и сразу при создании записи
export function reminderActionButtons(bookingId: number, lang: Lang): InlineButton[][] {
  return [
    [
      { text: t(lang, "buttons.reschedule"), callback_data: `resched:${bookingId}` },
      { text: t(lang, "buttons.cancelBooking"), callback_data: `cancelbk:${bookingId}` },
    ],
    [{ text: t(lang, "buttons.late"), callback_data: `late:${bookingId}` }],
  ];
}

// Кнопки оценки под сообщением "услуга завершена" (api.ts, отметка "Выполнена").
// Цифра + одна звезда, а не N звёзд подряд — в ряду из 5 кнопок повторяющиеся
// эмодзи (⭐⭐⭐⭐⭐) Telegram обрезает до "⭐ ...", из-за чего непонятно, где какая оценка
export function ratingButtons(bookingId: number): InlineButton[][] {
  return [
    [1, 2, 3, 4, 5].map((n) => ({ text: `${n} ⭐`, callback_data: `rate:${bookingId}:${n}` })),
  ];
}

// Кнопки под уведомлением мастеру о записи (api.ts, notifyMaster) — чтобы
// отметить визит выполненным или неявкой прямо в чате, не открывая Mini App
export function masterBookingActionButtons(bookingId: number): InlineButton[][] {
  return [
    [
      { text: "✅ Выполнена", callback_data: `mstatus:${bookingId}:completed` },
      { text: "🚫 Не пришёл", callback_data: `mstatus:${bookingId}:no_show` },
    ],
  ];
}

// Данные записи копятся в сессии сцены по ходу диалога — на каждом шаге
// заполняется одно новое поле, следующий шаг определяем по тому, что уже есть
interface BookingSceneState {
  // Язык диалога — берётся один раз при входе в сцену (из сохранённого языка
  // пользователя) и держится в состоянии диалога до его конца, а не
  // запрашивается заново на каждом шаге
  lang?: Lang;
  serviceId?: number;
  serviceName?: string;
  serviceDuration?: number;
  servicePrice?: number;
  masterId?: number;
  masterName?: string;
  date?: string;
  time?: string;
  // Если задано — сцена вошла в режим переноса существующей записи (кнопка
  // "🔄 Перенести" под уведомлением о записи), а не создания новой: услуга и
  // мастер уже известны и не спрашиваются, при подтверждении вызывается
  // PATCH /bookings/:id вместо создания новой записи
  rescheduleBookingId?: number;
}

// Данные существующей записи, с которыми сцена входит в режим переноса —
// передаются через ctx.scene.enter("booking", { reschedule: {...} })
export interface RescheduleEntryState {
  reschedule?: {
    bookingId: number;
    masterId: number;
    masterName: string;
    serviceId: number;
    serviceName: string;
    serviceDuration: number;
    servicePrice: number;
  };
}

interface BookingSceneSessionData extends Scenes.SceneSessionData {
  booking?: BookingSceneState;
}

export interface BotContext extends Context {
  // Язык пользователя (сохранённый в базе, при первом обращении определяется
  // по языку Telegram) — выставляется в bot.ts до всех остальных обработчиков
  lang: Lang;
  scene: Scenes.SceneContextScene<BotContext, BookingSceneSessionData>;
  session: Scenes.SceneSession<BookingSceneSessionData>;
}

interface Service {
  id: number;
  name: string;
  duration_minutes: number;
  price: number;
}

interface Master extends MasterSchedule {
  id: number;
  name: string;
  work_start_time: string;
  work_end_time: string;
  buffer_minutes: number;
  service_ids: number[];
  avg_rating: number | null;
  ratings_count: number;
}

function masterLabel(m: Master, lang: Lang): string {
  return m.ratings_count > 0 ? t(lang, "book.masterLabel", { name: m.name, rating: m.avg_rating ?? "" }) : m.name;
}

function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDayLabel(d: Date, lang: Lang): string {
  return `${t(lang, `calendar.wd_${(d.getDay() + 6) % 7}`)}, ${d.getDate()} ${t(lang, `calendar.month_${d.getMonth()}`)}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function state(ctx: BotContext): BookingSceneState {
  if (!ctx.scene.session.booking) ctx.scene.session.booking = {};
  return ctx.scene.session.booking;
}

// Язык этого диалога: зафиксированный при входе в сцену, а если состояние
// потерялось (сервер перезапускался) — текущий язык пользователя
function L(ctx: BotContext): Lang {
  return state(ctx).lang ?? ctx.lang;
}

// Если сервер перезапустился (данные диалога хранятся в памяти, не в базе) —
// шаг сессии теряется. Просим начать заново, а не падаем с ошибкой
async function requireField<K extends keyof BookingSceneState>(
  ctx: BotContext,
  field: K
): Promise<BookingSceneState[K] | undefined> {
  const value = state(ctx)[field];
  if (value === undefined) {
    const lang = L(ctx);
    await ctx.answerCbQuery(t(lang, "book.sessionReset"));
    await ctx.reply(t(lang, "book.sessionLost", { button: bookButtonText(lang) }));
    await ctx.scene.leave();
  }
  return value;
}

// Общий шаг "выберите день" — используется и в обычной записи (после выбора
// мастера), и при переносе существующей записи (сразу после входа в сцену,
// услуга и мастер уже известны из старой записи)
async function sendDayPicker(ctx: BotContext, master: Master, send: (text: string, extra: object) => Promise<unknown>) {
  const lang = L(ctx);
  const days: Date[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (let i = 0; days.length < 10 && i < 30; i++) {
    const d = new Date(cursor);
    d.setDate(cursor.getDate() + i);
    if (isWorkDay(dateKey(d), master)) days.push(d);
  }
  if (days.length === 0) {
    await send(t(lang, "book.noWorkDays", { master: master.name, button: bookButtonText(lang) }), {});
    await ctx.scene.leave();
    return;
  }
  const buttons: InlineButton[][] = chunk(
    days.map((d) => ({ text: formatDayLabel(d, lang), callback_data: `day:${dateKey(d)}` })),
    2
  );
  buttons.push([{ text: t(lang, "common.cancel"), callback_data: "cancel" }]);
  await send(t(lang, "book.pickDay", { master: master.name }), { reply_markup: { inline_keyboard: buttons } });
}

export const bookingScene = new Scenes.BaseScene<BotContext>("booking");

bookingScene.enter(async (ctx) => {
  const entryState = ctx.scene.state as RescheduleEntryState;
  const reschedule = entryState.reschedule;
  const lang = ctx.lang;

  if (reschedule) {
    ctx.scene.session.booking = {
      lang,
      rescheduleBookingId: reschedule.bookingId,
      masterId: reschedule.masterId,
      masterName: reschedule.masterName,
      serviceId: reschedule.serviceId,
      serviceName: reschedule.serviceName,
      serviceDuration: reschedule.serviceDuration,
      servicePrice: reschedule.servicePrice,
    };
    const mastersRes = await fetch(`${API_BASE}/masters`, { headers: langHeaders(lang) });
    const masters = (await mastersRes.json()) as Master[];
    const master = masters.find((m) => m.id === reschedule.masterId);
    if (!master) {
      await ctx.reply(t(lang, "book.masterGone"));
      await ctx.scene.leave();
      return;
    }
    await sendDayPicker(ctx, master, (text, extra) => ctx.reply(text, extra));
    return;
  }

  ctx.scene.session.booking = { lang };
  const res = await fetch(`${API_BASE}/services`, { headers: langHeaders(lang) });
  const services = (await res.json()) as Service[];
  if (services.length === 0) {
    await ctx.reply(t(lang, "book.noServices"));
    await ctx.scene.leave();
    return;
  }
  const buttons: InlineButton[][] = services.map((s) => [
    {
      text: t(lang, "book.serviceButton", { name: s.name, price: s.price, minutes: s.duration_minutes }),
      callback_data: `svc:${s.id}`,
    },
  ]);
  buttons.push([{ text: t(lang, "common.cancel"), callback_data: "cancel" }]);
  await ctx.reply(t(lang, "book.pickService"), { reply_markup: { inline_keyboard: buttons } });
});

bookingScene.action("cancel", async (ctx) => {
  await ctx.answerCbQuery();
  const lang = L(ctx);
  await ctx.editMessageText(t(lang, "book.cancelled", { button: bookButtonText(lang) }));
  await ctx.scene.leave();
});

bookingScene.action(/^svc:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const serviceId = Number(ctx.match[1]);
  const lang = L(ctx);
  // Оба запроса не зависят друг от друга — запускаем сразу вместе, а не по
  // очереди, чтобы каждый шаг диалога отвечал быстрее
  const [res, mastersRes] = await Promise.all([
    fetch(`${API_BASE}/services`, { headers: langHeaders(lang) }),
    fetch(`${API_BASE}/masters`, { headers: langHeaders(lang) }),
  ]);
  const services = (await res.json()) as Service[];
  const service = services.find((s) => s.id === serviceId);
  if (!service) {
    await ctx.editMessageText(t(lang, "book.serviceGone", { button: bookButtonText(lang) }));
    await ctx.scene.leave();
    return;
  }
  Object.assign(state(ctx), {
    serviceId: service.id,
    serviceName: service.name,
    serviceDuration: service.duration_minutes,
    servicePrice: service.price,
  });

  const masters = (await mastersRes.json()) as Master[];
  const available = masters.filter((m) => m.service_ids.includes(serviceId));
  if (available.length === 0) {
    await ctx.editMessageText(t(lang, "book.noMastersForService", { button: bookButtonText(lang) }));
    await ctx.scene.leave();
    return;
  }
  const buttons: InlineButton[][] = available.map((m) => [
    { text: masterLabel(m, lang), callback_data: `mst:${m.id}` },
  ]);
  buttons.push([{ text: t(lang, "common.cancel"), callback_data: "cancel" }]);
  await ctx.editMessageText(t(lang, "book.pickMaster", { service: service.name }), {
    reply_markup: { inline_keyboard: buttons },
  });
});

bookingScene.action(/^mst:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if ((await requireField(ctx, "serviceId")) === undefined) return;
  const masterId = Number(ctx.match[1]);
  const lang = L(ctx);
  const mastersRes = await fetch(`${API_BASE}/masters`, { headers: langHeaders(lang) });
  const masters = (await mastersRes.json()) as Master[];
  const master = masters.find((m) => m.id === masterId);
  if (!master) {
    await ctx.editMessageText(t(lang, "book.masterUnavailable", { button: bookButtonText(lang) }));
    await ctx.scene.leave();
    return;
  }
  state(ctx).masterId = master.id;
  state(ctx).masterName = master.name;

  await sendDayPicker(ctx, master, (text, extra) => ctx.editMessageText(text, extra));
});

bookingScene.action(/^day:([\d-]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const masterId = await requireField(ctx, "masterId");
  const duration = await requireField(ctx, "serviceDuration");
  if (masterId === undefined || duration === undefined) return;
  const date = ctx.match[1];
  const lang = L(ctx);
  state(ctx).date = date;

  const [mastersRes, busyRes] = await Promise.all([
    fetch(`${API_BASE}/masters`, { headers: langHeaders(lang) }),
    fetch(`${API_BASE}/masters/${masterId}/bookings?date=${date}`),
  ]);
  const masters = (await mastersRes.json()) as Master[];
  const master = masters.find((m) => m.id === masterId)!;
  const busy = (await busyRes.json()) as { starts_at: string; duration_minutes: number }[];

  const now = Date.now();
  const freeSlots = generateTimeSlots(
    master.work_start_time,
    master.work_end_time,
    slotStep(master.buffer_minutes)
  ).filter((time) => {
    const slotStart = new Date(`${date}T${time}:00`).getTime();
    if (slotStart < now) return false;
    const slotEnd = slotStart + duration * 60000;
    const bufferMs = master.buffer_minutes * 60000;
    return !busy.some((b) => {
      const bStart = new Date(b.starts_at).getTime() - bufferMs;
      const bEnd = bStart + b.duration_minutes * 60000 + 2 * bufferMs;
      return slotStart < bEnd && bStart < slotEnd;
    });
  });

  if (freeSlots.length === 0) {
    await ctx.editMessageText(t(lang, "book.noFreeTime", { button: bookButtonText(lang) }));
    await ctx.scene.leave();
    return;
  }
  const buttons: InlineButton[][] = chunk(
    freeSlots.map((t) => ({ text: t, callback_data: `time:${t}` })),
    4
  );
  buttons.push([{ text: t(lang, "common.cancel"), callback_data: "cancel" }]);
  const dateObj = new Date(`${date}T00:00:00`);
  await ctx.editMessageText(t(lang, "book.pickTime", { day: formatDayLabel(dateObj, lang) }), {
    reply_markup: { inline_keyboard: buttons },
  });
});

// Экран "Проверьте запись" — общий финальный шаг перед подтверждением.
async function sendConfirmScreen(ctx: BotContext) {
  const s = state(ctx);
  const lang = L(ctx);
  const dateObj = new Date(`${s.date}T00:00:00`);
  const heading = t(lang, s.rescheduleBookingId ? "book.confirmHeadingReschedule" : "book.confirmHeading");
  const text = t(lang, "book.confirmBody", {
    heading,
    service: s.serviceName ?? "",
    master: s.masterName ?? "",
    day: formatDayLabel(dateObj, lang),
    time: s.time ?? "",
    price: s.servicePrice ?? "",
  });
  const extra = {
    reply_markup: {
      inline_keyboard: [
        [{ text: t(lang, "book.confirm"), callback_data: "confirm" }],
        [{ text: t(lang, "common.cancel"), callback_data: "cancel" }],
      ],
    },
  };
  await ctx.editMessageText(text, extra);
}

bookingScene.action(/^time:(\d{2}:\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = state(ctx);
  if (
    (await requireField(ctx, "serviceName")) === undefined ||
    (await requireField(ctx, "masterName")) === undefined ||
    (await requireField(ctx, "date")) === undefined
  )
    return;
  s.time = ctx.match[1];

  await sendConfirmScreen(ctx);
});

bookingScene.action("confirm", async (ctx) => {
  await ctx.answerCbQuery();
  const s = state(ctx);
  if (
    (await requireField(ctx, "serviceId")) === undefined ||
    (await requireField(ctx, "masterId")) === undefined ||
    (await requireField(ctx, "date")) === undefined ||
    (await requireField(ctx, "time")) === undefined
  )
    return;

  const from = ctx.from!;
  const lang = L(ctx);
  const clientName = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || t(lang, "common.client");
  const startsAt = `${s.date}T${s.time}:00`;

  if (s.rescheduleBookingId) {
    await ctx.editMessageText(t(lang, "book.moving"));
    const res = await fetch(`${API_BASE}/bookings/${s.rescheduleBookingId}`, {
      method: "PATCH",
      headers: internalHeaders({ "Content-Type": "application/json", ...langHeaders(lang) }),
      body: JSON.stringify({ client_telegram_id: from.id, starts_at: startsAt }),
    });
    const data = await res.json();
    if (!res.ok) {
      await ctx.editMessageText(
        t(lang, "book.moveFailed", {
          error: data.error ?? t(lang, "common.unknownError"),
          button: bookButtonText(lang),
        })
      );
      await ctx.scene.leave();
      return;
    }
    await ctx.editMessageText(t(lang, "book.moved"));
    await ctx.scene.leave();
    return;
  }

  await ctx.editMessageText(t(lang, "book.booking"));
  const res = await fetch(`${API_BASE}/bookings`, {
    method: "POST",
    headers: internalHeaders({ "Content-Type": "application/json", ...langHeaders(lang) }),
    body: JSON.stringify({
      client_telegram_id: from.id,
      client_username: from.username,
      client_name: clientName,
      master_id: s.masterId,
      service_id: s.serviceId,
      starts_at: startsAt,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    await ctx.editMessageText(
      t(lang, "book.bookFailed", {
        error: data.error ?? t(lang, "common.unknownError"),
        button: bookButtonText(lang),
      })
    );
    await ctx.scene.leave();
    return;
  }
  await ctx.editMessageText(t(lang, "book.booked"));
  await ctx.scene.leave();
});
