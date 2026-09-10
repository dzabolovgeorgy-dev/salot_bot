import { Context, Scenes } from "telegraf";
import { isWorkDay, generateTimeSlots, slotStep, type MasterSchedule } from "./schedule.js";
import { internalHeaders } from "./internalAuth.js";

interface InlineButton {
  text: string;
  callback_data: string;
}

export const API_BASE = `http://localhost:${process.env.PORT ?? 3000}/api`;

// Текст постоянной кнопки быстрой записи внизу чата (задаётся в bot.ts) —
// экспортируем отсюда, чтобы bot.ts мог её импортировать, не создавая
// круговую зависимость (bot.ts и так уже импортирует эту сцену)
export const BOOK_BUTTON_TEXT = "📅 Записаться в чате";

// Кнопки "Перенести"/"Отменить" под уведомлением о записи в чате — используются
// и в api.ts (когда шлёт подтверждение записи), и в bot.ts (чтобы вернуть их
// после того как человек передумал отменять — см. cancelbk_no)
export function bookingActionButtons(bookingId: number): InlineButton[][] {
  return [
    [
      { text: "🔄 Перенести", callback_data: `resched:${bookingId}` },
      { text: "❌ Отменить", callback_data: `cancelbk:${bookingId}` },
    ],
  ];
}

// Те же кнопки плюс "Опаздываю" — только под напоминанием (reminders.ts):
// сообщить, что вот-вот начнётся запись, а предупредить об опоздании раньше
// времени смысла нет — поэтому не добавляем эту кнопку в bookingActionButtons,
// который используется и сразу при создании записи
export function reminderActionButtons(bookingId: number): InlineButton[][] {
  return [
    [
      { text: "🔄 Перенести", callback_data: `resched:${bookingId}` },
      { text: "❌ Отменить", callback_data: `cancelbk:${bookingId}` },
    ],
    [{ text: "⏳ Я опаздываю", callback_data: `late:${bookingId}` }],
  ];
}

// Данные записи копятся в сессии сцены по ходу диалога — на каждом шаге
// заполняется одно новое поле, следующий шаг определяем по тому, что уже есть
interface BookingSceneState {
  serviceId?: number;
  serviceName?: string;
  serviceDuration?: number;
  servicePrice?: number;
  masterId?: number;
  masterName?: string;
  date?: string;
  time?: string;
  serviceRequiresAllergyCheck?: boolean;
  // true — ждём следующим сообщением текст про аллергию/особенности (после
  // кнопки "Уточнить"/"Указать"), а не обрабатываем текст как случайный
  awaitingAllergyNote?: boolean;
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
  scene: Scenes.SceneContextScene<BotContext, BookingSceneSessionData>;
  session: Scenes.SceneSession<BookingSceneSessionData>;
}

interface Service {
  id: number;
  name: string;
  duration_minutes: number;
  price: number;
  requires_allergy_check: boolean;
}

interface Master extends MasterSchedule {
  id: number;
  name: string;
  work_start_time: string;
  work_end_time: string;
  buffer_minutes: number;
  service_ids: number[];
}

const MONTH_NAMES = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
const WEEKDAY_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDayLabel(d: Date): string {
  return `${WEEKDAY_NAMES[(d.getDay() + 6) % 7]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
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

// Если сервер перезапустился (данные диалога хранятся в памяти, не в базе) —
// шаг сессии теряется. Просим начать заново, а не падаем с ошибкой
async function requireField<K extends keyof BookingSceneState>(
  ctx: BotContext,
  field: K
): Promise<BookingSceneState[K] | undefined> {
  const value = state(ctx)[field];
  if (value === undefined) {
    await ctx.answerCbQuery("Сессия сброшена — начните заново");
    await ctx.reply(`Похоже, сервер перезапускался и диалог сбросился. Нажмите «${BOOK_BUTTON_TEXT}», чтобы начать заново.`);
    await ctx.scene.leave();
  }
  return value;
}

// Общий шаг "выберите день" — используется и в обычной записи (после выбора
// мастера), и при переносе существующей записи (сразу после входа в сцену,
// услуга и мастер уже известны из старой записи)
async function sendDayPicker(ctx: BotContext, master: Master, send: (text: string, extra: object) => Promise<unknown>) {
  const days: Date[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (let i = 0; days.length < 10 && i < 30; i++) {
    const d = new Date(cursor);
    d.setDate(cursor.getDate() + i);
    if (isWorkDay(dateKey(d), master)) days.push(d);
  }
  if (days.length === 0) {
    await send(
      `У мастера ${master.name} нет рабочих дней в ближайший месяц. Нажмите «${BOOK_BUTTON_TEXT}», чтобы начать заново.`,
      {}
    );
    await ctx.scene.leave();
    return;
  }
  const buttons: InlineButton[][] = chunk(
    days.map((d) => ({ text: formatDayLabel(d), callback_data: `day:${dateKey(d)}` })),
    2
  );
  buttons.push([{ text: "Отмена", callback_data: "cancel" }]);
  await send(`Мастер: ${master.name}\n\nВыберите день:`, { reply_markup: { inline_keyboard: buttons } });
}

export const bookingScene = new Scenes.BaseScene<BotContext>("booking");

bookingScene.enter(async (ctx) => {
  const entryState = ctx.scene.state as RescheduleEntryState;
  const reschedule = entryState.reschedule;

  if (reschedule) {
    ctx.scene.session.booking = {
      rescheduleBookingId: reschedule.bookingId,
      masterId: reschedule.masterId,
      masterName: reschedule.masterName,
      serviceId: reschedule.serviceId,
      serviceName: reschedule.serviceName,
      serviceDuration: reschedule.serviceDuration,
      servicePrice: reschedule.servicePrice,
    };
    const mastersRes = await fetch(`${API_BASE}/masters`);
    const masters = (await mastersRes.json()) as Master[];
    const master = masters.find((m) => m.id === reschedule.masterId);
    if (!master) {
      await ctx.reply("Этого мастера больше нет — перенести запись не получится, отмените и запишитесь заново.");
      await ctx.scene.leave();
      return;
    }
    await sendDayPicker(ctx, master, (text, extra) => ctx.reply(text, extra));
    return;
  }

  ctx.scene.session.booking = {};
  const res = await fetch(`${API_BASE}/services`);
  const services = (await res.json()) as Service[];
  if (services.length === 0) {
    await ctx.reply("Пока нет доступных услуг, попробуйте позже.");
    await ctx.scene.leave();
    return;
  }
  const buttons: InlineButton[][] = services.map((s) => [
    { text: `${s.name} — ${s.price} ₽ (${s.duration_minutes} мин)`, callback_data: `svc:${s.id}` },
  ]);
  buttons.push([{ text: "Отмена", callback_data: "cancel" }]);
  await ctx.reply("Какая услуга вас интересует?", { reply_markup: { inline_keyboard: buttons } });
});

bookingScene.action("cancel", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(`Запись отменена. Если захотите начать заново — нажмите «${BOOK_BUTTON_TEXT}».`);
  await ctx.scene.leave();
});

bookingScene.action(/^svc:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const serviceId = Number(ctx.match[1]);
  // Оба запроса не зависят друг от друга — запускаем сразу вместе, а не по
  // очереди, чтобы каждый шаг диалога отвечал быстрее
  const [res, mastersRes] = await Promise.all([fetch(`${API_BASE}/services`), fetch(`${API_BASE}/masters`)]);
  const services = (await res.json()) as Service[];
  const service = services.find((s) => s.id === serviceId);
  if (!service) {
    await ctx.editMessageText(`Эта услуга уже недоступна. Нажмите «${BOOK_BUTTON_TEXT}», чтобы начать заново.`);
    await ctx.scene.leave();
    return;
  }
  Object.assign(state(ctx), {
    serviceId: service.id,
    serviceName: service.name,
    serviceDuration: service.duration_minutes,
    servicePrice: service.price,
    serviceRequiresAllergyCheck: service.requires_allergy_check,
  });

  const masters = (await mastersRes.json()) as Master[];
  const available = masters.filter((m) => m.service_ids.includes(serviceId));
  if (available.length === 0) {
    await ctx.editMessageText(`Для этой услуги пока нет мастеров. Нажмите «${BOOK_BUTTON_TEXT}», чтобы выбрать другую услугу.`);
    await ctx.scene.leave();
    return;
  }
  const buttons: InlineButton[][] = available.map((m) => [
    { text: m.name, callback_data: `mst:${m.id}` },
  ]);
  buttons.push([{ text: "Отмена", callback_data: "cancel" }]);
  await ctx.editMessageText(`Услуга: ${service.name}\n\nВыберите мастера:`, {
    reply_markup: { inline_keyboard: buttons },
  });
});

bookingScene.action(/^mst:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if ((await requireField(ctx, "serviceId")) === undefined) return;
  const masterId = Number(ctx.match[1]);
  const mastersRes = await fetch(`${API_BASE}/masters`);
  const masters = (await mastersRes.json()) as Master[];
  const master = masters.find((m) => m.id === masterId);
  if (!master) {
    await ctx.editMessageText(`Этот мастер уже недоступен. Нажмите «${BOOK_BUTTON_TEXT}», чтобы начать заново.`);
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
  state(ctx).date = date;

  const [mastersRes, busyRes] = await Promise.all([
    fetch(`${API_BASE}/masters`),
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
    await ctx.editMessageText(
      `На этот день свободного времени не осталось. Нажмите «${BOOK_BUTTON_TEXT}», чтобы выбрать другой день.`
    );
    await ctx.scene.leave();
    return;
  }
  const buttons: InlineButton[][] = chunk(
    freeSlots.map((t) => ({ text: t, callback_data: `time:${t}` })),
    4
  );
  buttons.push([{ text: "Отмена", callback_data: "cancel" }]);
  const dateObj = new Date(`${date}T00:00:00`);
  await ctx.editMessageText(`${formatDayLabel(dateObj)}\n\nВыберите время:`, {
    reply_markup: { inline_keyboard: buttons },
  });
});

// Экран "Проверьте запись" — общий финальный шаг перед подтверждением.
// edit=true — правим предыдущее сообщение бота (обычный ход диалога кнопками),
// edit=false — шлём новое (после того как человек написал текст про аллергию,
// редактировать уже нечего — то сообщение было "Напишите...")
async function sendConfirmScreen(ctx: BotContext, edit: boolean) {
  const s = state(ctx);
  const dateObj = new Date(`${s.date}T00:00:00`);
  const heading = s.rescheduleBookingId ? "Перенести запись на:" : "Проверьте запись:";
  const text = `${heading}\n\nУслуга: ${s.serviceName}\nМастер: ${s.masterName}\n${formatDayLabel(dateObj)}, ${s.time}\nЦена: ${s.servicePrice} ₽\n\nВсё верно?`;
  const extra = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Подтвердить", callback_data: "confirm" }],
        [{ text: "Отмена", callback_data: "cancel" }],
      ],
    },
  };
  if (edit) await ctx.editMessageText(text, extra);
  else await ctx.reply(text, extra);
}

// Услуга требует знать про аллергию/чувствительность (requires_allergy_check) —
// перед подтверждением спрашиваем, но в один тап: если уже есть заметка —
// просто "актуально?", если нет — "есть что учесть?". Печатать текст нужно,
// только если человек сам захочет уточнить/добавить — лишний тап не нужен
async function askAllergyIfNeeded(ctx: BotContext) {
  const res = await fetch(`${API_BASE}/client-notes/${ctx.from!.id}`, { headers: internalHeaders() });
  const data = (await res.json().catch(() => ({}))) as { note?: string | null };
  if (data.note) {
    await ctx.editMessageText(`⚠️ У нас записано: «${data.note}». Это всё ещё актуально?`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Да, актуально", callback_data: "allergy_keep" }],
          [{ text: "Уточнить", callback_data: "allergy_edit" }],
        ],
      },
    });
  } else {
    await ctx.editMessageText(
      "⚠️ Для этой услуги важно знать про аллергию или чувствительность кожи. Есть что учесть?",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Нет, всё в порядке", callback_data: "allergy_none" }],
            [{ text: "Указать", callback_data: "allergy_add" }],
          ],
        },
      }
    );
  }
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

  // При переносе услугу не меняют — заметка о клиенте уже была спрошена при
  // первой записи, второй раз не нужно (так же ведёт себя и приложение)
  if (s.serviceRequiresAllergyCheck && !s.rescheduleBookingId) {
    await askAllergyIfNeeded(ctx);
    return;
  }

  await sendConfirmScreen(ctx, true);
});

bookingScene.action("allergy_keep", async (ctx) => {
  await ctx.answerCbQuery();
  await sendConfirmScreen(ctx, true);
});

bookingScene.action("allergy_none", async (ctx) => {
  await ctx.answerCbQuery();
  await sendConfirmScreen(ctx, true);
});

bookingScene.action(/^allergy_(edit|add)$/, async (ctx) => {
  await ctx.answerCbQuery();
  state(ctx).awaitingAllergyNote = true;
  await ctx.editMessageText("Напишите одним сообщением, что нужно знать мастеру (например: «аллергия на аммиак»).");
});

// Свободный текст ловим только пока реально ждём заметку про аллергию — в
// остальное время диалог идёт кнопками. Если текст не про это — пропускаем
// дальше (next()), а не проглатываем: иначе, например, повторное нажатие
// постоянной кнопки "Записаться в чате" посреди диалога перестало бы работать
bookingScene.on("text", async (ctx, next) => {
  const s = state(ctx);
  if (!s.awaitingAllergyNote) {
    await next();
    return;
  }
  s.awaitingAllergyNote = false;

  const note = ctx.message.text.trim();
  if (note) {
    await fetch(`${API_BASE}/client-notes/${ctx.from!.id}`, {
      method: "PUT",
      headers: internalHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ note }),
    }).catch(() => {});
  }
  await ctx.reply("Записал, спасибо.");
  await sendConfirmScreen(ctx, false);
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
  const clientName = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "Клиент";
  const startsAt = `${s.date}T${s.time}:00`;

  if (s.rescheduleBookingId) {
    await ctx.editMessageText("Переношу…");
    const res = await fetch(`${API_BASE}/bookings/${s.rescheduleBookingId}`, {
      method: "PATCH",
      headers: internalHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ client_telegram_id: from.id, starts_at: startsAt }),
    });
    const data = await res.json();
    if (!res.ok) {
      await ctx.editMessageText(
        `Не получилось перенести: ${data.error ?? "неизвестная ошибка"}. Нажмите «${BOOK_BUTTON_TEXT}», чтобы попробовать снова.`
      );
      await ctx.scene.leave();
      return;
    }
    await ctx.editMessageText("✅ Перенесено! Подробности пришлю следующим сообщением.");
    await ctx.scene.leave();
    return;
  }

  await ctx.editMessageText("Записываю…");
  const res = await fetch(`${API_BASE}/bookings`, {
    method: "POST",
    headers: internalHeaders({ "Content-Type": "application/json" }),
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
      `Не получилось записать: ${data.error ?? "неизвестная ошибка"}. Нажмите «${BOOK_BUTTON_TEXT}», чтобы попробовать снова.`
    );
    await ctx.scene.leave();
    return;
  }
  await ctx.editMessageText("✅ Готово! Подробности пришлю следующим сообщением.");
  await ctx.scene.leave();
});
