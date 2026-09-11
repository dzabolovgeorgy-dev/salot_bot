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

// База (Supabase) по умолчанию живёт в UTC, а now() в SQL-запросах сравнивается
// с starts_at, который хранится как местное время салона без часового пояса —
// без этого now() в SQL "отстаёт" от реального местного времени на разницу
// с UTC, и всё, что сравнивается с now() (проверка "не в прошлом", напоминания,
// список предстоящих записей), считает неверно
db.on("connect", (client) => {
  client.query("SET TIME ZONE 'Europe/Moscow'").catch(() => {});
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
      off_days INTEGER,
      work_start_time TEXT NOT NULL DEFAULT '09:00',
      work_end_time TEXT NOT NULL DEFAULT '20:00',
      -- 'cycle' = скользящий график (work_days/off_days) — устаревший режим,
      -- больше не выбирается в интерфейсе, но старые мастера могут на нём остаться;
      -- 'weekdays' = фиксированные дни недели (work_weekdays);
      -- 'month' = выходные дни отмечены вручную на конкретный месяц
      -- (schedule_month + schedule_month_off_days), настраивается заново каждый месяц;
      -- NULL = графика нет, работает всегда.
      -- Проверка допустимых значений — на уровне приложения, не CHECK-constraint,
      -- чтобы не усложнять идемпотентную миграцию при повторных запусках
      schedule_type TEXT,
      work_weekdays INTEGER[],
      schedule_month TEXT,
      schedule_month_off_days INTEGER[],
      -- Перерыв (в минутах) между соседними записями у этого мастера — время
      -- убраться/подготовиться. Раньше было общее число на всех (15 минут),
      -- теперь каждый мастер настраивает своё в "Мой график"
      buffer_minutes INTEGER NOT NULL DEFAULT 15
    );

    ALTER TABLE masters ADD COLUMN IF NOT EXISTS schedule_anchor DATE;
    ALTER TABLE masters ADD COLUMN IF NOT EXISTS work_days INTEGER;
    ALTER TABLE masters ADD COLUMN IF NOT EXISTS off_days INTEGER;
    ALTER TABLE masters ADD COLUMN IF NOT EXISTS work_start_time TEXT NOT NULL DEFAULT '09:00';
    ALTER TABLE masters ADD COLUMN IF NOT EXISTS work_end_time TEXT NOT NULL DEFAULT '20:00';
    ALTER TABLE masters ADD COLUMN IF NOT EXISTS schedule_type TEXT;
    ALTER TABLE masters ADD COLUMN IF NOT EXISTS work_weekdays INTEGER[];
    ALTER TABLE masters ADD COLUMN IF NOT EXISTS schedule_month TEXT;
    ALTER TABLE masters ADD COLUMN IF NOT EXISTS schedule_month_off_days INTEGER[];
    ALTER TABLE masters ADD COLUMN IF NOT EXISTS buffer_minutes INTEGER NOT NULL DEFAULT 15;
    -- Мастера с уже заданным циклическим графиком (work_days/off_days) считаем
    -- schedule_type='cycle' задним числом, чтобы их график не "потерялся"
    UPDATE masters SET schedule_type = 'cycle'
      WHERE schedule_type IS NULL AND schedule_anchor IS NOT NULL AND work_days IS NOT NULL AND off_days IS NOT NULL;

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
      client_telegram_id BIGINT,
      master_id INTEGER NOT NULL REFERENCES masters(id),
      service_id INTEGER NOT NULL REFERENCES services(id),
      starts_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      client_name TEXT,
      status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'completed', 'no_show')),
      client_username TEXT,
      client_phone TEXT,
      -- Отметки, что напоминание клиенту уже отправлено — чтобы при каждой
      -- проверке (раз в несколько минут) не слать одно и то же повторно
      reminder_24h_sent BOOLEAN NOT NULL DEFAULT false,
      reminder_2h_sent BOOLEAN NOT NULL DEFAULT false
    );

    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_name TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'upcoming'
      CHECK (status IN ('upcoming', 'completed', 'no_show'));
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_username TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_phone TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_24h_sent BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_2h_sent BOOLEAN NOT NULL DEFAULT false;
    -- Записи, которые администратор создаёт вручную (звонок/WhatsApp), могут
    -- быть без Telegram ID — тогда обязателен client_phone
    ALTER TABLE bookings ALTER COLUMN client_telegram_id DROP NOT NULL;

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

    CREATE TABLE IF NOT EXISTS master_photos (
      id SERIAL PRIMARY KEY,
      master_id INTEGER NOT NULL REFERENCES masters(id),
      url TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS client_notes (
      id SERIAL PRIMARY KEY,
      client_telegram_id BIGINT UNIQUE,
      note TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      client_phone TEXT,
      admin_comment TEXT
    );

    ALTER TABLE client_notes ADD COLUMN IF NOT EXISTS client_phone TEXT;
    ALTER TABLE client_notes ALTER COLUMN client_telegram_id DROP NOT NULL;
    ALTER TABLE client_notes ALTER COLUMN note DROP NOT NULL;
    ALTER TABLE client_notes ADD COLUMN IF NOT EXISTS admin_comment TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS client_notes_phone_key ON client_notes (client_phone);

    CREATE TABLE IF NOT EXISTS loyalty_points (
      id SERIAL PRIMARY KEY,
      client_telegram_id BIGINT NOT NULL UNIQUE,
      points_balance INTEGER NOT NULL DEFAULT 0,
      total_spent INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id SERIAL PRIMARY KEY,
      client_telegram_id BIGINT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      -- NULL для списаний и сгораний — сгорает только то, что было начислено
      expires_at TIMESTAMP,
      -- Только для начислений — на какую услугу начислен кэшбэк, для истории в TWA
      service_name TEXT
    );

    ALTER TABLE loyalty_transactions ADD COLUMN IF NOT EXISTS service_name TEXT;

    CREATE INDEX IF NOT EXISTS loyalty_transactions_client_idx ON loyalty_transactions (client_telegram_id);
    CREATE INDEX IF NOT EXISTS loyalty_transactions_expires_idx ON loyalty_transactions (expires_at) WHERE expires_at IS NOT NULL;

    -- booking_id UNIQUE — одна оценка на визит; повторное нажатие звезды или
    -- добавление комментария потом обновляет ту же строку, а не плодит новые
    CREATE TABLE IF NOT EXISTS master_ratings (
      id SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
      master_id INTEGER NOT NULL REFERENCES masters(id),
      client_telegram_id BIGINT,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS master_ratings_master_idx ON master_ratings (master_id);
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
    ["Стрижка", 30, 15]
  );
  const color = await db.query(
    `INSERT INTO services (name, duration_minutes, price, requires_allergy_check) VALUES ($1, $2, $3, true) RETURNING id`,
    ["Окрашивание", 120, 45]
  );
  const manicure = await db.query(
    `INSERT INTO services (name, duration_minutes, price) VALUES ($1, $2, $3) RETURNING id`,
    ["Маникюр", 60, 20]
  );
  const styling = await db.query(
    `INSERT INTO services (name, duration_minutes, price) VALUES ($1, $2, $3) RETURNING id`,
    ["Укладка", 45, 18]
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
