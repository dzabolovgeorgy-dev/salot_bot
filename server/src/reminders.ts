import { db } from "./db.js";
import { bot } from "./bot.js";
import { formatRuDateTime } from "./format.js";
import { bookingActionButtons } from "./bookingScene.js";

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

async function findDue(column: ReminderColumn, hoursAhead: number): Promise<DueBooking[]> {
  const { rows } = await db.query<DueBooking>(
    `SELECT b.id, b.client_telegram_id, b.starts_at, s.name AS service_name, m.name AS master_name
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

async function sendReminder(booking: DueBooking, lead: string): Promise<void> {
  try {
    await bot.telegram.sendMessage(
      booking.client_telegram_id,
      `⏰ Напоминаем: ${lead}\n\n${booking.service_name} — ${booking.master_name}\n${formatRuDateTime(booking.starts_at)}`,
      { reply_markup: { inline_keyboard: bookingActionButtons(booking.id) } }
    );
  } catch (err) {
    // Бот заблокирован клиентом, тестовый ID и т.п. — не должно ломать
    // проверку остальных записей
    console.warn("Не удалось отправить напоминание клиенту:", err instanceof Error ? err.message : err);
  }
}

async function checkAndSend(column: ReminderColumn, hoursAhead: number, lead: string): Promise<void> {
  const due = await findDue(column, hoursAhead);
  for (const booking of due) {
    await sendReminder(booking, lead);
    await db.query(`UPDATE bookings SET ${column} = true WHERE id = $1`, [booking.id]);
  }
}

// Запускает периодическую проверку "кому пора напомнить о записи" — за сутки
// и за 2 часа. Вызывать один раз при старте сервера
export function startReminderScheduler(): void {
  const run = async () => {
    try {
      await checkAndSend("reminder_24h_sent", 24, "завтра у вас запись");
      await checkAndSend("reminder_2h_sent", 2, "уже совсем скоро ваша запись");
    } catch (err) {
      console.error("Ошибка при проверке напоминаний (пробуем снова через 5 минут):", err);
    }
  };
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
