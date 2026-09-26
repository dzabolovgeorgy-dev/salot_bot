import { db } from "./db.js";
import { bot } from "./bot.js";
import { formatDateTime } from "./format.js";
import { reminderActionButtons } from "./bookingScene.js";
import { localized, t, type Lang } from "./i18n.js";
import { getUserLanguage } from "./userLanguage.js";

// Как часто проверять, кому пора отправить напоминание. Не обязательно бить
// ровно в 24:00:00 или 2:00:00 до записи — раз в несколько минут достаточно,
// отметка reminder_*_sent не даёт отправить дважды
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

interface DueBooking {
  id: number;
  client_telegram_id: string;
  starts_at: string;
  service_name: string;
  master_name: string;
}

type ReminderColumn = "reminder_24h_sent" | "reminder_2h_sent";

// Название услуги приходит на русском и на английском сразу — язык клиента
// известен только при отправке (см. sendReminder), там и выбираем
interface DueRowRaw extends DueBooking {
  service_name_en: string | null;
}

async function findDue(column: ReminderColumn, hoursAhead: number): Promise<DueRowRaw[]> {
  const { rows } = await db.query<DueRowRaw>(
    `SELECT b.id, b.client_telegram_id, b.starts_at, s.name AS service_name, s.name_en AS service_name_en, m.name AS master_name
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     JOIN masters m ON m.id = b.master_id
     WHERE b.status = 'upcoming'
       AND b.client_telegram_id IS NOT NULL
       AND b.${column} = false
       AND b.starts_at <= now() + ($1 * interval '1 hour')
       AND b.starts_at > now()`,
    [hoursAhead]
  );
  return rows;
}

async function sendReminder(booking: DueRowRaw, leadKey: "reminder.tomorrow" | "reminder.soon"): Promise<void> {
  try {
    const lang: Lang = await getUserLanguage(booking.client_telegram_id);
    await bot.telegram.sendMessage(
      booking.client_telegram_id,
      t(lang, "reminder.text", {
        lead: t(lang, leadKey),
        service: localized(lang, booking.service_name, { en: booking.service_name_en }),
        master: booking.master_name,
        date: formatDateTime(booking.starts_at, lang),
      }),
      { reply_markup: { inline_keyboard: reminderActionButtons(booking.id, lang) } }
    );
  } catch (err) {
    // Бот заблокирован клиентом, тестовый ID и т.п. — не должно ломать
    // проверку остальных записей
    console.warn("Не удалось отправить напоминание клиенту:", err instanceof Error ? err.message : err);
  }
}

async function checkAndSend(
  column: ReminderColumn,
  hoursAhead: number,
  leadKey: "reminder.tomorrow" | "reminder.soon"
): Promise<void> {
  const due = await findDue(column, hoursAhead);
  for (const booking of due) {
    await sendReminder(booking, leadKey);
    await db.query(`UPDATE bookings SET ${column} = true WHERE id = $1`, [booking.id]);
  }
}

// Запускает периодическую проверку "кому пора напомнить о записи" — за сутки
// и за 2 часа. Вызывать один раз при старте сервера
export function startReminderScheduler(): void {
  const run = async () => {
    try {
      await checkAndSend("reminder_24h_sent", 24, "reminder.tomorrow");
      await checkAndSend("reminder_2h_sent", 2, "reminder.soon");
    } catch (err) {
      console.error("Ошибка при проверке напоминаний (пробуем снова через 5 минут):", err);
    }
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
