import pg, { Pool } from "pg";

// Наши даты хранятся "как есть" (без часового пояса, локальное время салона) —
// отключаем автоматическое превращение timestamp-колонок в JS Date, иначе
// драйвер сдвигает время под часовой пояс сервера
pg.types.setTypeParser(1114, (value) => value);
pg.types.setTypeParser(1082, (value) => value); // date

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function initDb(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS masters (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      bio TEXT,
      experience_years INTEGER,
      photo_url TEXT,
      schedule_anchor DATE,
      work_days INTEGER,
      off_days INTEGER
    );

    ALTER TABLE masters ADD COLUMN IF NOT EXISTS schedule_anchor DATE;
    ALTER TABLE masters ADD COLUMN IF NOT EXISTS work_days INTEGER;
    ALTER TABLE masters ADD COLUMN IF NOT EXISTS off_days INTEGER;

    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      price INTEGER NOT NULL,
      requires_allergy_check BOOLEAN NOT NULL DEFAULT false
    );

    ALTER TABLE services ADD COLUMN IF NOT EXISTS requires_allergy_check BOOLEAN NOT NULL DEFAULT false;

    CREATE TABLE IF NOT EXISTS master_services (
      master_id INTEGER NOT NULL REFERENCES masters(id),
      service_id INTEGER NOT NULL REFERENCES services(id),
      PRIMARY KEY (master_id, service_id)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      client_telegram_id BIGINT NOT NULL,
      master_id INTEGER NOT NULL REFERENCES masters(id),
      service_id INTEGER NOT NULL REFERENCES services(id),
      starts_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      client_name TEXT,
      status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'completed', 'no_show')),
      client_username TEXT
    );

    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_name TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'upcoming'
      CHECK (status IN ('upcoming', 'completed', 'no_show'));
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_username TEXT;

    CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('master', 'admin')),
      master_id INTEGER REFERENCES masters(id),
      CHECK ((role = 'master' AND master_id IS NOT NULL) OR (role = 'admin' AND master_id IS NULL))
    );

    CREATE TABLE IF NOT EXISTS blocked_slots (
      id SERIAL PRIMARY KEY,
      master_id INTEGER NOT NULL REFERENCES masters(id),
      starts_at TIMESTAMP NOT NULL,
      ends_at TIMESTAMP NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS client_notes (
      id SERIAL PRIMARY KEY,
      client_telegram_id BIGINT NOT NULL UNIQUE,
      note TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  // Если база пустая — наполняем тестовыми мастерами и услугами
  const { rows: countRows } = await db.query("SELECT COUNT(*)::int AS count FROM masters");
  if (countRows[0].count > 0) return;

  const anna = await db.query(
    `INSERT INTO masters (name, bio, experience_years, photo_url) VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      "Анна Иванова",
      "Парикмахер-стилист: стрижки, окрашивание и укладки любой сложности.",
      6,
      "https://i.pravatar.cc/300?img=47",
    ]
  );
  const maria = await db.query(
    `INSERT INTO masters (name, bio, experience_years, photo_url) VALUES ($1, $2, $3, $4) RETURNING id`,
    ["Мария Петрова", "Мастер маникюра: аккуратный уход и стойкое покрытие.", 4, "https://i.pravatar.cc/300?img=48"]
  );

  const cut = await db.query(
    `INSERT INTO services (name, duration_minutes, price) VALUES ($1, $2, $3) RETURNING id`,
    ["Стрижка", 30, 1500]
  );
  const color = await db.query(
    `INSERT INTO services (name, duration_minutes, price, requires_allergy_check) VALUES ($1, $2, $3, true) RETURNING id`,
    ["Окрашивание", 120, 4500]
  );
  const manicure = await db.query(
    `INSERT INTO services (name, duration_minutes, price) VALUES ($1, $2, $3) RETURNING id`,
    ["Маникюр", 60, 2000]
  );
  const styling = await db.query(
    `INSERT INTO services (name, duration_minutes, price) VALUES ($1, $2, $3) RETURNING id`,
    ["Укладка", 45, 1800]
  );

  const annaId = anna.rows[0].id;
  const mariaId = maria.rows[0].id;
  for (const serviceId of [cut.rows[0].id, color.rows[0].id, styling.rows[0].id]) {
    await db.query("INSERT INTO master_services (master_id, service_id) VALUES ($1, $2)", [annaId, serviceId]);
  }
  await db.query("INSERT INTO master_services (master_id, service_id) VALUES ($1, $2)", [
    mariaId,
    manicure.rows[0].id,
  ]);
}
