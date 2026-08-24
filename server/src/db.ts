import Database from "better-sqlite3";

// Файл базы данных появится рядом с проектом при первом запуске
export const db = new Database("salon.db");

db.pragma("journal_mode = WAL");

// Создаём таблицы, если их ещё нет
db.exec(`
  CREATE TABLE IF NOT EXISTS masters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    bio TEXT,
    experience_years INTEGER,
    photo_url TEXT
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    price INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS master_services (
    master_id INTEGER NOT NULL REFERENCES masters(id),
    service_id INTEGER NOT NULL REFERENCES services(id),
    PRIMARY KEY (master_id, service_id)
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

// На случай, если таблица masters уже существует в старом виде (локальная база
// из прошлых запусков) — добавляем новые колонки, если их ещё нет.
for (const column of ["bio TEXT", "experience_years INTEGER", "photo_url TEXT"]) {
  try {
    db.exec(`ALTER TABLE masters ADD COLUMN ${column}`);
  } catch {
    // колонка уже существует
  }
}

// Если база пустая (например, сервер только что перезапустился на бесплатном
// тарифе хостинга и потерял данные) — наполняем её тестовыми мастерами и услугами.
const mastersCount = (
  db.prepare("SELECT COUNT(*) as count FROM masters").get() as { count: number }
).count;

if (mastersCount === 0) {
  const insertMaster = db.prepare(
    "INSERT INTO masters (name, bio, experience_years, photo_url) VALUES (?, ?, ?, ?)"
  );
  const anna = insertMaster.run(
    "Анна Иванова",
    "Парикмахер-стилист: стрижки, окрашивание и укладки любой сложности.",
    6,
    "https://i.pravatar.cc/300?img=47"
  );
  const maria = insertMaster.run(
    "Мария Петрова",
    "Мастер маникюра: аккуратный уход и стойкое покрытие.",
    4,
    "https://i.pravatar.cc/300?img=48"
  );

  const insertService = db.prepare(
    "INSERT INTO services (name, duration_minutes, price) VALUES (?, ?, ?)"
  );
  const cut = insertService.run("Стрижка", 30, 1500);
  const color = insertService.run("Окрашивание", 120, 4500);
  const manicure = insertService.run("Маникюр", 60, 2000);
  const styling = insertService.run("Укладка", 45, 1800);

  const insertMasterService = db.prepare(
    "INSERT INTO master_services (master_id, service_id) VALUES (?, ?)"
  );
  for (const serviceId of [cut.lastInsertRowid, color.lastInsertRowid, styling.lastInsertRowid]) {
    insertMasterService.run(anna.lastInsertRowid, serviceId);
  }
  insertMasterService.run(maria.lastInsertRowid, manicure.lastInsertRowid);
}
