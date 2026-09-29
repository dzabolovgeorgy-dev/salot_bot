import { db } from "./db.js";
import { bot } from "./bot.js";
import { LOYALTY_TIERS } from "./loyalty.js";

// Условия отбора получателей рассылки — хранятся в broadcasts.segment_filter.
// Используется ровно одно условие (или ни одного — тогда "все клиенты")
export interface SegmentFilter {
  service_id?: number;
  master_id?: number;
  loyalty_tier?: string;
  min_days_since_visit?: number;
}

export interface Recipient {
  telegram_id: number;
  name: string | null;
}

// Лимиты Telegram на длину: подпись под фото короче обычного сообщения
export const MAX_TEXT_LENGTH = 4096;
export const MAX_CAPTION_LENGTH = 1024;

// Приводит присланные с экрана условия к одному проверенному условию —
// или null ("все клиенты"). Возвращает строку-ошибку, если условие неверное
export function parseSegmentFilter(raw: unknown): SegmentFilter | null | string {
  if (raw == null) return null;
  if (typeof raw !== "object") return "Неверный сегмент";
  const f = raw as Record<string, unknown>;
  if (f.service_id != null) {
    const id = Number(f.service_id);
    return Number.isInteger(id) && id > 0 ? { service_id: id } : "Неверная услуга";
  }
  if (f.master_id != null) {
    const id = Number(f.master_id);
    return Number.isInteger(id) && id > 0 ? { master_id: id } : "Неверный мастер";
  }
  if (f.loyalty_tier != null) {
    const tier = String(f.loyalty_tier);
    return LOYALTY_TIERS.some((t) => t.name === tier) ? { loyalty_tier: tier } : "Неверный уровень лояльности";
  }
  if (f.min_days_since_visit != null) {
    const days = Number(f.min_days_since_visit);
    return Number.isInteger(days) && days > 0 ? { min_days_since_visit: days } : "Число дней должно быть больше нуля";
  }
  return null;
}

// Кому уйдёт рассылка. Всегда — только клиенты с Telegram, давшие согласие
// на рекламу (client_notes.marketing_consent), какое бы условие ни выбрали.
// Имя — из последней записи клиента, для подстановки {name} в текст
export async function selectRecipients(filter: SegmentFilter | null): Promise<Recipient[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.service_id) {
    params.push(filter.service_id);
    conditions.push(`EXISTS (SELECT 1 FROM bookings b WHERE b.client_telegram_id = cn.client_telegram_id
                             AND b.service_id = $${params.length} AND b.status <> 'no_show')`);
  } else if (filter?.master_id) {
    params.push(filter.master_id);
    conditions.push(`EXISTS (SELECT 1 FROM bookings b WHERE b.client_telegram_id = cn.client_telegram_id
                             AND b.master_id = $${params.length} AND b.status <> 'no_show')`);
  } else if (filter?.loyalty_tier) {
    // Уровень не хранится — считается по сумме потраченного, как и в loyalty.ts.
    // У клиента без строки в loyalty_points потрачено 0 — это "Новичок"
    const index = LOYALTY_TIERS.findIndex((t) => t.name === filter.loyalty_tier);
    const min = LOYALTY_TIERS[index].minSpent;
    const next = LOYALTY_TIERS[index + 1]?.minSpent ?? null;
    params.push(min);
    let cond = `COALESCE(lp.total_spent, 0) >= $${params.length}`;
    if (next != null) {
      params.push(next);
      cond += ` AND COALESCE(lp.total_spent, 0) < $${params.length}`;
    }
    conditions.push(cond);
  } else if (filter?.min_days_since_visit) {
    // "Давно не были": последний состоявшийся визит раньше, чем N дней назад,
    // и новой записи на будущее у клиента нет — иначе он и так придёт
    params.push(filter.min_days_since_visit);
    conditions.push(`(SELECT MAX(b.starts_at) FROM bookings b WHERE b.client_telegram_id = cn.client_telegram_id
                        AND b.status = 'completed') < now() - make_interval(days => $${params.length})`);
    conditions.push(`NOT EXISTS (SELECT 1 FROM bookings b WHERE b.client_telegram_id = cn.client_telegram_id
                                 AND b.status = 'upcoming' AND b.starts_at > now())`);
  }

  const { rows } = await db.query<{ telegram_id: string; name: string | null }>(
    `SELECT cn.client_telegram_id AS telegram_id,
            (SELECT b.client_name FROM bookings b WHERE b.client_telegram_id = cn.client_telegram_id
               AND b.client_name IS NOT NULL ORDER BY b.created_at DESC LIMIT 1) AS name
     FROM client_notes cn
     LEFT JOIN loyalty_points lp ON lp.client_telegram_id = cn.client_telegram_id
     WHERE cn.marketing_consent = true AND cn.client_telegram_id IS NOT NULL
     ${conditions.map((c) => `AND ${c}`).join("\n     ")}`,
    params
  );
  return rows.map((r) => ({ telegram_id: Number(r.telegram_id), name: r.name }));
}

// Подставляет имя клиента вместо {name}. Если имени нет — убирает метку
// вместе с запятой рядом: "Привет, {name}!" → "Привет!",
// "{name}, скидка!" → "Скидка!"
export function personalize(text: string, name: string | null): string {
  const firstName = name?.trim().split(/\s+/)[0];
  if (firstName) return text.replaceAll("{name}", firstName);
  const withoutLeading = text.replace(/^\s*\{name\}[,!]?\s*/, "");
  const result = withoutLeading.replace(/[,\s]*\{name\}/g, "").trim();
  return withoutLeading === text ? result : result.charAt(0).toUpperCase() + result.slice(1);
}

// Отправляет одно сообщение рассылки. Без parse_mode — текст уходит ровно
// так, как его набрал администратор, без риска, что символы вроде * или _
// сломают отправку. Фото можно передать ссылкой или кодом файла, который
// Telegram вернул после первой отправки (возвращаем его) — тогда Telegram
// не скачивает одну и ту же картинку заново для каждого получателя
export async function sendBroadcastMessage(chatId: number, text: string, photo: string | null): Promise<string | null> {
  if (photo) {
    const msg = await bot.telegram.sendPhoto(chatId, photo, { caption: text });
    return msg.photo.at(-1)?.file_id ?? null;
  }
  await bot.telegram.sendMessage(chatId, text);
  return null;
}

// ── Массовая отправка ────────────────────────────────────────────────────

// Telegram разрешает боту около 30 сообщений в секунду разным людям. Берём
// с запасом — 20 в секунду (пауза 50 мс): бот в это же время может слать
// напоминания и подтверждения записей, им тоже нужно место в этом лимите
const SEND_DELAY_MS = 50;
// Если Telegram всё же попросил притормозить (ошибка 429), ждём, сколько он
// сказал, и пробуем того же получателя ещё раз — но не бесконечно
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface TelegramErrorLike {
  response?: { error_code?: number; parameters?: { retry_after?: number } };
}

type RecipientStatus = "sent" | "error" | "blocked";

// Отправка одному получателю с повтором при "слишком часто". 403 — человек
// заблокировал бота или удалил аккаунт, это отдельный статус "заблокировал
// бота"; всё остальное — "ошибка"
async function sendToRecipient(
  recipient: Recipient,
  text: string,
  photo: string | null
): Promise<{ status: RecipientStatus; fileId: string | null }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const fileId = await sendBroadcastMessage(recipient.telegram_id, personalize(text, recipient.name), photo);
      return { status: "sent", fileId };
    } catch (err) {
      const code = (err as TelegramErrorLike).response?.error_code;
      const retryAfter = (err as TelegramErrorLike).response?.parameters?.retry_after;
      if (code === 429 && attempt < MAX_RETRIES) {
        await sleep(((retryAfter ?? 1) + 1) * 1000);
        continue;
      }
      if (code === 403) return { status: "blocked", fileId: null };
      console.warn(`Рассылка: не удалось отправить ${recipient.telegram_id}:`, err);
      return { status: "error", fileId: null };
    }
  }
}

// Какая рассылка отправляется прямо сейчас. Одновременно — только одна:
// две параллельные вместе превысили бы лимит Telegram. Если в это время
// пришла ещё одна, она остаётся "отправляется" и начнётся при следующей
// проверке (раз в минуту) после окончания текущей
let runningId: number | null = null;

// Отправляет рассылку всем получателям по очереди. Кто уже есть в
// broadcast_recipients (отправка прервалась перезапуском сервера и теперь
// продолжается) — пропускаются. Ошибка у одного получателя не останавливает
// рассылку для остальных
export async function runBroadcast(broadcastId: number): Promise<void> {
  if (runningId !== null) return;
  runningId = broadcastId;
  try {
    const { rows } = await db.query<{ text: string; image_url: string | null; segment_filter: SegmentFilter | null }>(
      "SELECT text, image_url, segment_filter FROM broadcasts WHERE id = $1 AND status = 'sending'",
      [broadcastId]
    );
    if (!rows[0]) return;
    const { text, image_url, segment_filter } = rows[0];

    const recipients = await selectRecipients(segment_filter);
    const { rows: done } = await db.query<{ client_telegram_id: string }>(
      "SELECT client_telegram_id FROM broadcast_recipients WHERE broadcast_id = $1",
      [broadcastId]
    );
    const alreadyDone = new Set(done.map((r) => Number(r.client_telegram_id)));

    let photo = image_url;
    for (const recipient of recipients) {
      if (alreadyDone.has(recipient.telegram_id)) continue;
      const { status, fileId } = await sendToRecipient(recipient, text, photo);
      if (fileId) photo = fileId;
      await db.query(
        `INSERT INTO broadcast_recipients (broadcast_id, client_telegram_id, status)
         VALUES ($1, $2, $3) ON CONFLICT (broadcast_id, client_telegram_id) DO NOTHING`,
        [broadcastId, recipient.telegram_id, status]
      );
      await sleep(SEND_DELAY_MS);
    }

    await db.query("UPDATE broadcasts SET status = 'completed' WHERE id = $1", [broadcastId]);
    console.log(`Рассылка ${broadcastId} завершена`);
  } catch (err) {
    // Статус остаётся "sending" — следующая проверка (раз в минуту) подхватит
    // рассылку и продолжит с того места, где остановились
    console.error(`Рассылка ${broadcastId} прервалась, продолжим при следующей проверке:`, err);
  } finally {
    runningId = null;
  }
}

const CHECK_INTERVAL_MS = 60 * 1000;

// Раз в минуту: запланированные рассылки, время которых наступило, переводим
// в "отправляется" и запускаем; заодно подхватываем "отправляется", которые
// оборвал перезапуск сервера (на Render это бывает при каждой выкладке).
// Перевод статуса с условием status = 'scheduled' — даже если проверка
// сработает дважды, рассылка запустится один раз
async function checkBroadcasts(): Promise<void> {
  await db.query(
    "UPDATE broadcasts SET status = 'sending' WHERE status = 'scheduled' AND scheduled_at <= now()"
  );
  const { rows } = await db.query<{ id: number }>("SELECT id FROM broadcasts WHERE status = 'sending' ORDER BY id");
  // Берём самую раннюю; не ждём окончания — длинная рассылка не должна
  // задерживать следующую проверку
  if (rows[0]) runBroadcast(rows[0].id);
}

// Вызывать один раз при старте сервера
export function startBroadcastScheduler(): void {
  const run = async () => {
    try {
      await checkBroadcasts();
    } catch (err) {
      console.error("Ошибка при проверке рассылок (пробуем снова через минуту):", err);
    }
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
