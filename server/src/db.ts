import pg, { Pool } from "pg";
import { generateAccessCode } from "./accessCode.js";

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
      price INTEGER NOT NULL
    );

    ALTER TABLE services DROP COLUMN IF EXISTS requires_allergy_check;

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
    -- Отметка, что напоминание МАСТЕРУ о предстоящей записи уже отправлено
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_master_sent BOOLEAN NOT NULL DEFAULT false;
    -- Сообщение мастеру о новой записи (с кнопками "Выполнена"/"Не пришёл"):
    -- запоминаем, где оно лежит и что в нём написано, чтобы обновить его, когда
    -- статус поменяли в панели, а не в самом чате
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS master_msg_chat_id BIGINT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS master_msg_id BIGINT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS master_msg_text TEXT;
    -- Записи, которые администратор создаёт вручную (звонок/WhatsApp), могут
    -- быть без Telegram ID — тогда обязателен client_phone
    ALTER TABLE bookings ALTER COLUMN client_telegram_id DROP NOT NULL;

    CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('master', 'admin')),
      master_id INTEGER REFERENCES masters(id),
      -- Короткий код для входа в PWA-версию без Telegram (см. server/src/pwaAuth.ts)
      access_code TEXT UNIQUE,
      CHECK ((role = 'master' AND master_id IS NOT NULL) OR (role = 'admin' AND master_id IS NULL))
    );

    ALTER TABLE staff ADD COLUMN IF NOT EXISTS access_code TEXT UNIQUE;

    -- Вход по PWA-сессии: после правильного кода браузеру выдаётся токен
    -- (в httpOnly cookie), который живёт здесь и подтверждает личность при
    -- каждом следующем запросе — без повторного ввода кода
    CREATE TABLE IF NOT EXISTS pwa_sessions (
      token TEXT PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      expires_at TIMESTAMP NOT NULL
    );

    CREATE INDEX IF NOT EXISTS pwa_sessions_expires_idx ON pwa_sessions (expires_at);

    -- Одноразовые коды входа в PWA: сотрудник получает код в приложении Telegram
    -- (личность подтверждена подписью), вводит его в PWA, и код сразу удаляется.
    -- В базе лежит не сам код, а его отпечаток (sha256), и живёт он недолго
    CREATE TABLE IF NOT EXISTS pwa_login_codes (
      code_hash TEXT PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      expires_at TIMESTAMP NOT NULL
    );

    CREATE INDEX IF NOT EXISTS pwa_login_codes_telegram_idx ON pwa_login_codes (telegram_id);

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
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      -- Короткая подпись под фото работы ("Окрашивание в технике балаяж" и т.п.) —
      -- необязательная, мастер добавляет/меняет её отдельно от самой загрузки
      caption TEXT
    );

    ALTER TABLE master_photos ADD COLUMN IF NOT EXISTS caption TEXT;

    -- Папки для фото работ ("Стрижки", "Окрашивание" и т.п.) — мастер сам
    -- создаёт и называет. Одно фото может лежать сразу в нескольких папках,
    -- поэтому связь отдельной таблицей, а не столбцом в master_photos
    CREATE TABLE IF NOT EXISTS photo_folders (
      id SERIAL PRIMARY KEY,
      master_id INTEGER NOT NULL REFERENCES masters(id),
      name TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS master_photo_folders (
      photo_id INTEGER NOT NULL REFERENCES master_photos(id) ON DELETE CASCADE,
      folder_id INTEGER NOT NULL REFERENCES photo_folders(id) ON DELETE CASCADE,
      PRIMARY KEY (photo_id, folder_id)
    );

    -- "Вдохновение" — галерея примеров для клиента (не работы конкретного
    -- мастера, а общая подборка причёсок/ногтей и т.п. для выбора стиля перед
    -- записью). master_id — необязательная ссылка, если фото всё же чья-то
    -- работа, тогда на карточке показываем автора и предлагаем запись к нему
    CREATE TABLE IF NOT EXISTS inspiration_photos (
      id SERIAL PRIMARY KEY,
      image_url TEXT NOT NULL,
      category TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      master_id INTEGER REFERENCES masters(id),
      -- Сколько раз с этого фото нажали "Записаться на такое" — простая
      -- метрика интереса для мастера, не то же самое, что реальные записи
      -- (человек мог нажать и передумать, не дойдя до подтверждения)
      click_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    -- Путь в файловом хранилище — есть только у фото, загруженных через
    -- приложение (мастером/админом); у фото, добавленных напрямую в базу
    -- (внешние ссылки), его нет, и удалять из хранилища тогда нечего
    ALTER TABLE inspiration_photos ADD COLUMN IF NOT EXISTS storage_path TEXT;

    CREATE INDEX IF NOT EXISTS inspiration_photos_category_idx ON inspiration_photos (category);
    CREATE INDEX IF NOT EXISTS inspiration_photos_tags_idx ON inspiration_photos USING GIN (tags);
    CREATE INDEX IF NOT EXISTS inspiration_photos_master_idx ON inspiration_photos (master_id);

    -- Избранное клиента — какие фото из "Вдохновения" он сохранил себе
    CREATE TABLE IF NOT EXISTS saved_photos (
      id SERIAL PRIMARY KEY,
      client_telegram_id BIGINT NOT NULL,
      photo_id INTEGER NOT NULL REFERENCES inspiration_photos(id) ON DELETE CASCADE,
      saved_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE (client_telegram_id, photo_id)
    );

    CREATE INDEX IF NOT EXISTS saved_photos_client_idx ON saved_photos (client_telegram_id);

    -- Фото-референс, которое клиент прикрепил к своей записи (необязательно) —
    -- мастер видит его прямо в карточке записи
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reference_photo_id INTEGER REFERENCES inspiration_photos(id);

    CREATE TABLE IF NOT EXISTS client_notes (
      id SERIAL PRIMARY KEY,
      client_telegram_id BIGINT UNIQUE,
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      client_phone TEXT,
      admin_comment TEXT
    );

    ALTER TABLE client_notes ADD COLUMN IF NOT EXISTS client_phone TEXT;
    ALTER TABLE client_notes ALTER COLUMN client_telegram_id DROP NOT NULL;
    ALTER TABLE client_notes ADD COLUMN IF NOT EXISTS admin_comment TEXT;
    ALTER TABLE client_notes DROP COLUMN IF EXISTS note;
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

    -- Склад — материалы (краска, лак и т.п.) с текущим остатком и порогом,
    -- ниже которого админу нужно предупреждение, что материал заканчивается
    CREATE TABLE IF NOT EXISTS inventory_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      min_threshold INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );

    -- История поступлений/списаний по каждому материалу — change_amount
    -- положительный при поступлении, отрицательный при списании
    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      change_amount INTEGER NOT NULL,
      reason TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS inventory_transactions_item_idx ON inventory_transactions (item_id);

    -- Состав услуги: сколько единиц материала уходит на одно выполнение.
    -- Когда запись отмечают выполненной, по этой таблице сервер сам
    -- списывает нужные материалы со склада — вручную ничего вводить не надо
    CREATE TABLE IF NOT EXISTS service_inventory_items (
      service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity_per_use INTEGER NOT NULL CHECK (quantity_per_use > 0),
      PRIMARY KEY (service_id, item_id)
    );

    -- Мультиязычность. Основной (русский) текст живёт в прежних колонках
    -- (services.name, masters.bio), переводы — в соседних колонках с суффиксом
    -- языка (name_en, bio_en). Пустая/NULL колонка перевода = "перевода нет",
    -- тогда показывается русский текст (см. server/src/i18n.ts). Новый язык —
    -- новые колонки name_<язык>/bio_<язык> и запись в SUPPORTED_LANGS
    ALTER TABLE services ADD COLUMN IF NOT EXISTS name_en TEXT;
    ALTER TABLE masters ADD COLUMN IF NOT EXISTS bio_en TEXT;

    -- Язык интерфейса каждого пользователя: определяется один раз по языку
    -- Telegram (language_code) при первом обращении и дальше берётся отсюда,
    -- а не определяется заново. Одна запись на человека — общая для бота и TWA
    CREATE TABLE IF NOT EXISTS user_languages (
      telegram_id BIGINT PRIMARY KEY,
      language TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );

    -- Рассылки. Отдельной таблицы "клиенты" нет — карточка клиента это
    -- client_notes, туда и кладём согласие на рекламные сообщения и дату
    -- рождения. Без согласия (по умолчанию его нет) клиент не попадает
    -- ни в одну рассылку, какой бы сегмент ни выбрали
    ALTER TABLE client_notes ADD COLUMN IF NOT EXISTS marketing_consent BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE client_notes ADD COLUMN IF NOT EXISTS marketing_consent_date TIMESTAMP;
    ALTER TABLE client_notes ADD COLUMN IF NOT EXISTS birth_date DATE;
    -- Год, в котором клиента уже поздравили с днём рождения — чтобы при
    -- перезапуске сервера в тот же день поздравление не ушло повторно
    ALTER TABLE client_notes ADD COLUMN IF NOT EXISTS birthday_greeted_year INTEGER;

    -- segment_filter — условия отбора получателей, например
    -- {"min_days_since_visit": 60} или {"service_id": 3}; NULL — все клиенты.
    -- scheduled_at NULL — отправить сразу
    CREATE TABLE IF NOT EXISTS broadcasts (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      image_url TEXT,
      segment_filter JSONB,
      scheduled_at TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'scheduled', 'sending', 'completed')),
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS broadcasts_scheduled_idx ON broadcasts (scheduled_at) WHERE status = 'scheduled';

    -- Кому ушла конкретная рассылка и чем закончилась отправка. Уникальность
    -- пары (рассылка, клиент) — если отправка прервалась (перезапуск сервера)
    -- и продолжилась, уже получившим сообщение оно не придёт второй раз
    CREATE TABLE IF NOT EXISTS broadcast_recipients (
      id SERIAL PRIMARY KEY,
      broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
      client_telegram_id BIGINT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sent', 'error', 'blocked')),
      sent_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE (broadcast_id, client_telegram_id)
    );

    -- Настройка автоматического поздравления с днём рождения — всегда одна
    -- строка (id = 1). gift_value — текст, потому что смысл зависит от типа:
    -- процент скидки, число баллов или название бесплатной услуги
    CREATE TABLE IF NOT EXISTS birthday_campaign_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled BOOLEAN NOT NULL DEFAULT false,
      message_template TEXT NOT NULL DEFAULT '{name}, с днём рождения! 🎉 Дарим вам подарок: {gift}',
      gift_type TEXT NOT NULL DEFAULT 'discount'
        CHECK (gift_type IN ('discount', 'points', 'free_service')),
      gift_value TEXT NOT NULL DEFAULT '10'
    );

    INSERT INTO birthday_campaign_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    -- Частые вопросы (FAQ) для клиентов. display_order — порядок в списке
    -- (меньше — выше). question_en/answer_en — перевод, как name_en у услуг:
    -- пусто — показывается русский текст. show_route_button — под ответом
    -- кнопка "Построить маршрут" (для вопроса "Где вы находитесь?" и т.п.)
    CREATE TABLE IF NOT EXISTS faq_items (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      question_en TEXT,
      answer_en TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      show_route_button BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    -- Общие настройки салона — всегда одна строка (id = 1). Адрес нужен для
    -- кнопки "Построить маршрут": если задана прямая ссылка на карту — берётся
    -- она, иначе ссылка на Google Maps собирается из адреса.
    -- faq_seeded — примеры вопросов уже добавлялись один раз; если админ их
    -- удалит, при перезапуске сервера они не появятся снова
    CREATE TABLE IF NOT EXISTS salon_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      salon_address TEXT,
      salon_location_url TEXT,
      faq_seeded BOOLEAN NOT NULL DEFAULT false
    );

    INSERT INTO salon_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    -- Часы работы салона — свободным текстом ("Ежедневно 9:00–21:00",
    -- "Пн–Сб 10:00–20:00, Вс выходной"), показываются клиенту под картой
    -- во вкладке FAQ. _en — перевод, как у вопросов
    ALTER TABLE salon_settings ADD COLUMN IF NOT EXISTS working_hours TEXT;
    ALTER TABLE salon_settings ADD COLUMN IF NOT EXISTS working_hours_en TEXT;
    -- Демо-адрес и часы уже вписывались один раз (см. ниже) — флаг, чтобы
    -- после того как админ сотрёт или поменяет их, они не вернулись сами
    ALTER TABLE salon_settings ADD COLUMN IF NOT EXISTS demo_contacts_seeded BOOLEAN NOT NULL DEFAULT false;
  `);

  // Примеры частых вопросов — один раз, чтобы раздел FAQ не был пустым при
  // первом показе. Общие для любого салона, без конкретных адресов и цен —
  // админ правит их под себя в "Ещё" → FAQ
  const { rowCount: seedFaq } = await db.query(
    "UPDATE salon_settings SET faq_seeded = true WHERE id = 1 AND faq_seeded = false"
  );
  if (seedFaq) {
    const examples: [string, string, boolean][] = [
      ["Как записаться?", "Выберите услугу, мастера и удобное время прямо в этом приложении или в чате с ботом командой /book.", false],
      ["Можно ли перенести или отменить запись?", "Да — в разделе «Мои записи» или кнопками под сообщением о записи в чате с ботом. Пожалуйста, предупреждайте заранее.", false],
      ["Как работают бонусные баллы?", "За каждый визит начисляется кэшбэк баллами — процент зависит от вашего уровня. Баллами можно оплатить до 30% стоимости следующего визита.", false],
      ["Какие способы оплаты вы принимаете?", "Наличные и банковские карты.", false],
    ];
    for (const [i, [question, answer, route]] of examples.entries()) {
      await db.query(
        "INSERT INTO faq_items (question, answer, display_order, show_route_button) VALUES ($1, $2, $3, $4)",
        [question, answer, (i + 1) * 10, route]
      );
    }
  }

  // Демо-адрес и часы работы для показа бота салонам — чтобы карта во вкладке
  // FAQ была видна сразу (так же, как демо-мастера и услуги ниже). Один раз и
  // только в пустые поля: настоящий адрес, если его уже вписали, не трогаем.
  // Салон-покупатель меняет их на свои в "Ещё" → "Частые вопросы"
  const { rowCount: seedContacts } = await db.query(
    "UPDATE salon_settings SET demo_contacts_seeded = true WHERE id = 1 AND demo_contacts_seeded = false"
  );
  if (seedContacts) {
    await db.query(
      `UPDATE salon_settings SET
         salon_address = COALESCE(salon_address, 'Anexartisias 47, Limassol, Cyprus'),
         working_hours = COALESCE(working_hours, 'Ежедневно 9:00–21:00'),
         working_hours_en = COALESCE(working_hours_en, 'Daily 9:00–21:00')
       WHERE id = 1`
    );
  }

  // Пример вопроса "Где вы находитесь?" больше не нужен — адрес, карта и часы
  // работы стоят карточкой в самом верху вкладки FAQ. Удаляем только сам
  // пример (точный текст любой из его прежних версий): если админ написал
  // свой вопрос об адресе, он останется
  await db.query(
    `DELETE FROM faq_items
     WHERE question = 'Где вы находитесь?'
       AND answer IN (
         'Адрес салона указан ниже — нажмите «Построить маршрут», чтобы открыть его на карте.',
         'Адрес, карта и часы работы — в самом верху этого раздела. Нажмите «Построить маршрут», чтобы проложить путь до салона.'
       )`
  );

  // Безопасность: у Supabase есть свой отдельный автоматический интернет-адрес
  // для базы (REST API), доступный кому угодно по одному лишь "анонимному"
  // ключу проекта — этим адресом наше приложение никогда не пользуется (сервер
  // обращается к базе напрямую под ролью postgres), но Supabase по умолчанию
  // даёт этому чужому входу полный доступ (читать/менять/даже стирать) ко
  // всем таблицам, если для них не включена защита на уровне строк (RLS).
  // Роль postgres (которой мы и пользуемся) владеет таблицами и эту защиту
  // не замечает — на работу сервера ничего из этого блока не влияет
  await db.query(`
    ALTER TABLE masters ENABLE ROW LEVEL SECURITY;
    ALTER TABLE services ENABLE ROW LEVEL SECURITY;
    ALTER TABLE master_services ENABLE ROW LEVEL SECURITY;
    ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pwa_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE user_languages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pwa_login_codes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE blocked_slots ENABLE ROW LEVEL SECURITY;
    ALTER TABLE master_photos ENABLE ROW LEVEL SECURITY;
    ALTER TABLE photo_folders ENABLE ROW LEVEL SECURITY;
    ALTER TABLE master_photo_folders ENABLE ROW LEVEL SECURITY;
    ALTER TABLE inspiration_photos ENABLE ROW LEVEL SECURITY;
    ALTER TABLE saved_photos ENABLE ROW LEVEL SECURITY;
    ALTER TABLE client_notes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE loyalty_points ENABLE ROW LEVEL SECURITY;
    ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE master_ratings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE service_inventory_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE broadcast_recipients ENABLE ROW LEVEL SECURITY;
    ALTER TABLE birthday_campaign_settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE faq_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE salon_settings ENABLE ROW LEVEL SECURITY;

    REVOKE ALL ON
      masters, services, master_services, bookings, staff, pwa_sessions, pwa_login_codes, user_languages,
      blocked_slots, master_photos, photo_folders, master_photo_folders,
      inspiration_photos, saved_photos, client_notes, loyalty_points,
      loyalty_transactions, master_ratings, inventory_items, inventory_transactions,
      service_inventory_items, broadcasts, broadcast_recipients, birthday_campaign_settings,
      faq_items, salon_settings
    FROM anon, authenticated;
  `);

  // Сотрудникам, добавленным ещё до появления входа по коду, нужно выдать
  // код задним числом — иначе они не смогут войти в PWA-версию
  const { rows: staffWithoutCode } = await db.query<{ id: number }>(
    "SELECT id FROM staff WHERE access_code IS NULL"
  );
  for (const { id } of staffWithoutCode) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await db.query("UPDATE staff SET access_code = $1 WHERE id = $2", [generateAccessCode(), id]);
        break;
      } catch {
        // код уже занят другим сотрудником — пробуем сгенерировать ещё раз
      }
    }
  }

  // Если база пустая — наполняем тестовыми мастерами и услугами
  const { rows: countRows } = await db.query("SELECT COUNT(*)::int AS count FROM masters");
  if (countRows[0].count === 0) await seedDemoMastersAndServices();

  await fillDemoTranslations();
}

async function seedDemoMastersAndServices(): Promise<void> {
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
    `INSERT INTO services (name, duration_minutes, price) VALUES ($1, $2, $3) RETURNING id`,
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

// Английские переводы демо-данных — чтобы английская версия бота сразу
// выглядела законченной на показе. Заполняется только пустое (или тестовая
// заглушка "[EN] …") и только у записей с точно таким русским текстом, как в
// демо: свои услуги/описания салона не трогаем — их переводят в панели.
// Безопасно выполнять при каждом запуске
const DEMO_SERVICE_NAMES_EN: Record<string, string> = {
  "Стрижка": "Haircut",
  "Женская стрижка": "Women's haircut",
  "Мужская стрижка": "Men's haircut",
  "Детская стрижка": "Kids' haircut",
  "Окрашивание": "Hair colouring",
  "Укладка": "Hair styling",
  "Маникюр": "Manicure",
  "Педикюр": "Pedicure",
  "Покрытие гель-лаком": "Gel polish",
  "Наращивание ресниц": "Eyelash extensions",
  "Ламинирование ресниц": "Lash lift",
  "Коррекция бровей": "Eyebrow shaping",
  "Окрашивание бровей": "Eyebrow tinting",
  "Стрижка бороды": "Beard trim",
};

const DEMO_MASTER_BIOS_EN: Record<string, string> = {
  "Парикмахер-стилист: стрижки, окрашивание и укладки любой сложности.":
    "Hair stylist: haircuts, colouring and styling of any complexity.",
  "Мастер маникюра: аккуратный уход и стойкое покрытие.": "Manicure specialist: gentle care and long-lasting polish.",
};

const DEMO_FAQ_EN: Record<string, [string, string]> = {
  "Как записаться?": [
    "How do I book?",
    "Choose a service, a specialist and a convenient time right in this app, or in the chat with the bot using the /book command.",
  ],
  "Можно ли перенести или отменить запись?": [
    "Can I reschedule or cancel my booking?",
    "Yes — in “My bookings” or with the buttons under the booking message in the chat with the bot. Please let us know in advance.",
  ],
  "Как работают бонусные баллы?": [
    "How do bonus points work?",
    "You earn cashback in points for every visit — the percentage depends on your level. Points can cover up to 30% of your next visit.",
  ],
  "Какие способы оплаты вы принимаете?": ["What payment methods do you accept?", "Cash and bank cards."],
};

async function fillDemoTranslations(): Promise<void> {
  const empty = (col: string) => `(${col} IS NULL OR ${col} = '' OR ${col} LIKE '[EN]%')`;
  for (const [ru, en] of Object.entries(DEMO_SERVICE_NAMES_EN)) {
    await db.query(`UPDATE services SET name_en = $1 WHERE name = $2 AND ${empty("name_en")}`, [en, ru]);
  }
  for (const [ru, en] of Object.entries(DEMO_MASTER_BIOS_EN)) {
    await db.query(`UPDATE masters SET bio_en = $1 WHERE bio = $2 AND ${empty("bio_en")}`, [en, ru]);
  }
  for (const [ru, [question, answer]] of Object.entries(DEMO_FAQ_EN)) {
    await db.query(
      `UPDATE faq_items SET question_en = $1, answer_en = $2
       WHERE question = $3 AND ${empty("question_en")} AND ${empty("answer_en")}`,
      [question, answer, ru]
    );
  }
}
