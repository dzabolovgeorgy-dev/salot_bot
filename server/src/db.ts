import Database from "better-sqlite3";

// Файл базы данных появится рядом с проектом при первом запуске
export const db = new Database("salon.db");

db.pragma("journal_mode = WAL");

// Создаём таблицы, если их ещё нет
db.exec(`
  CREATE TABLE IF NOT EXISTS masters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    price INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_telegram_id INTEGER NOT NULL,
    master_id INTEGER NOT NULL REFERENCES masters(id),
    service_id INTEGER NOT NULL REFERENCES services(id),
    starts_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Если база пустая (например, сервер только что перезапустился на бесплатном
// тарифе хостинга и потерял данные) — наполняем её тестовыми мастерами и услугами.
const mastersCount = (
  db.prepare("SELECT COUNT(*) as count FROM masters").get() as { count: number }
).count;

if (mastersCount === 0) {
  const insertMaster = db.prepare("INSERT INTO masters (name) VALUES (?)");
  insertMaster.run("Анна Иванова");
  insertMaster.run("Мария Петрова");

  const insertService = db.prepare(
    "INSERT INTO services (name, duration_minutes, price) VALUES (?, ?, ?)"
  );
  insertService.run("Стрижка", 30, 1500);
  insertService.run("Окрашивание", 120, 4500);
  insertService.run("Маникюр", 60, 2000);
  insertService.run("Укладка", 45, 1800);
}
