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
