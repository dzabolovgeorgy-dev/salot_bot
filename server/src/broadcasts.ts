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
// сломают отправку
export async function sendBroadcastMessage(chatId: number, text: string, imageUrl: string | null): Promise<void> {
  if (imageUrl) {
    await bot.telegram.sendPhoto(chatId, imageUrl, { caption: text });
  } else {
    await bot.telegram.sendMessage(chatId, text);
  }
}
