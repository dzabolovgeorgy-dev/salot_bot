import { db } from "./db.js";
import { personalize, sendBroadcastMessage, MAX_TEXT_LENGTH } from "./broadcasts.js";
import { accrueGiftPoints } from "./loyalty.js";

export type GiftType = "discount" | "points" | "free_service";

export interface BirthdayCampaignSettings {
  enabled: boolean;
  message_template: string;
  gift_type: GiftType;
  gift_value: string;
}

// Поздравления уходят не в полночь, а начиная с этого часа (местное время
// салона) — чтобы не будить людей сообщением в 00:01
const SEND_FROM_HOUR = 10;
// Проверка раз в 15 минут, а не раз в сутки: сервер на Render перезапускается
// и засыпает, и один-единственный ежедневный запуск легко пропустить. Повторно
// не поздравит — client_notes.birthday_greeted_year
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const SEND_DELAY_MS = 50;
const GIFT_POINTS_REASON = "подарок на день рождения";

export async function getBirthdaySettings(): Promise<BirthdayCampaignSettings> {
  const { rows } = await db.query<BirthdayCampaignSettings>(
    "SELECT enabled, message_template, gift_type, gift_value FROM birthday_campaign_settings WHERE id = 1"
  );
  return rows[0];
}

// Проверяет присланные с экрана настройки — возвращает текст ошибки или
// готовые настройки
export function parseBirthdaySettings(raw: Partial<BirthdayCampaignSettings>): BirthdayCampaignSettings | string {
  const template = typeof raw.message_template === "string" ? raw.message_template.trim() : "";
  if (!template) return "Введите текст поздравления";
  if (template.length > MAX_TEXT_LENGTH - 200) return "Текст поздравления слишком длинный";
  if (raw.gift_type !== "discount" && raw.gift_type !== "points" && raw.gift_type !== "free_service") {
    return "Выберите тип подарка";
  }
  const value = String(raw.gift_value ?? "").trim();
  if (raw.gift_type === "discount") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 100) return "Скидка — целое число от 1 до 100";
  } else if (raw.gift_type === "points") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 100000) return "Баллы — целое число больше нуля";
  } else if (!value) {
    return "Укажите, какая услуга в подарок";
  }
  return { enabled: !!raw.enabled, message_template: template, gift_type: raw.gift_type, gift_value: value };
}

// Как подарок звучит в тексте поздравления — подставляется вместо {gift}
export function describeGift(type: GiftType, value: string): string {
  if (type === "discount") return `скидка ${value}% на любую услугу`;
  if (type === "points") return `${value} баллов на ваш счёт`;
  return `бесплатная услуга «${value}»`;
}

// Готовый текст поздравления для конкретного клиента. Если {gift} в тексте
// нет — подарок дописывается в конце, чтобы клиент точно о нём узнал
export function buildGreeting(settings: BirthdayCampaignSettings, name: string | null): string {
  const gift = describeGift(settings.gift_type, settings.gift_value);
  const text = settings.message_template.includes("{gift}")
    ? settings.message_template.replaceAll("{gift}", gift)
    : `${settings.message_template}\n\n🎁 Ваш подарок: ${gift}`;
  return personalize(text, name);
}

interface BirthdayClient {
  id: number;
  telegram_id: string;
  name: string | null;
}

// Именинники сегодня: согласие на рассылки есть, Telegram есть, в этом году
// ещё не поздравляли. Родившиеся 29 февраля в невисокосный год — 28-го
async function findTodaysBirthdays(): Promise<BirthdayClient[]> {
  const { rows } = await db.query<BirthdayClient>(
    `SELECT cn.id, cn.client_telegram_id AS telegram_id,
            (SELECT b.client_name FROM bookings b WHERE b.client_telegram_id = cn.client_telegram_id
               AND b.client_name IS NOT NULL ORDER BY b.created_at DESC LIMIT 1) AS name
     FROM client_notes cn
     WHERE cn.marketing_consent = true
       AND cn.client_telegram_id IS NOT NULL
       AND cn.birth_date IS NOT NULL
       AND cn.birthday_greeted_year IS DISTINCT FROM EXTRACT(YEAR FROM now())::int
       AND EXTRACT(HOUR FROM now()) >= $1
       AND (
         to_char(cn.birth_date, 'MM-DD') = to_char(now(), 'MM-DD')
         OR (to_char(cn.birth_date, 'MM-DD') = '02-29' AND to_char(now(), 'MM-DD') = '02-28'
             AND NOT (EXTRACT(YEAR FROM now())::int % 4 = 0
                      AND (EXTRACT(YEAR FROM now())::int % 100 <> 0 OR EXTRACT(YEAR FROM now())::int % 400 = 0)))
       )`,
    [SEND_FROM_HOUR]
  );
  return rows;
}

async function greetBirthdays(): Promise<void> {
  const settings = await getBirthdaySettings();
  if (!settings?.enabled) return;

  const clients = await findTodaysBirthdays();
  for (const client of clients) {
    // Сначала отмечаем "в этом году поздравлен" — условие в UPDATE не даст
    // двум проверкам, сработавшим одновременно, поздравить дважды
    const { rowCount } = await db.query(
      `UPDATE client_notes SET birthday_greeted_year = EXTRACT(YEAR FROM now())::int
       WHERE id = $1 AND birthday_greeted_year IS DISTINCT FROM EXTRACT(YEAR FROM now())::int`,
      [client.id]
    );
    if (!rowCount) continue;

    const telegramId = Number(client.telegram_id);
    try {
      await sendBroadcastMessage(telegramId, buildGreeting(settings, client.name), null);
    } catch (err) {
      // Не дошло (например, бот заблокирован) — подарок баллами не начисляем.
      // Повторно в этом году не пытаемся: отметка уже стоит
      console.warn(`Поздравление с ДР не отправлено ${telegramId}:`, err);
      continue;
    }

    if (settings.gift_type === "points") {
      try {
        await accrueGiftPoints(telegramId, Number(settings.gift_value), GIFT_POINTS_REASON);
      } catch (err) {
        console.error(`Не удалось начислить баллы на ДР ${telegramId}:`, err);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
  }
}

// Вызывать один раз при старте сервера
export function startBirthdayScheduler(): void {
  const run = async () => {
    try {
      await greetBirthdays();
    } catch (err) {
      console.error("Ошибка при поздравлениях с днём рождения (повторим позже):", err);
    }
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
