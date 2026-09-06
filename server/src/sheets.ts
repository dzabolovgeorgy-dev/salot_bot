import crypto from "node:crypto";

// Дублируем записи клиентов в Google Таблицу — админ видит их в привычном
// виде, без доступа в саму базу данных (Supabase). Если Google недоступен —
// сама запись клиента всё равно должна пройти, поэтому все функции здесь
// ловят свои ошибки и никогда не бросают наружу

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }

  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  if (!email || !rawKey) throw new Error("Не заданы GOOGLE_SHEETS_CLIENT_EMAIL / GOOGLE_SHEETS_PRIVATE_KEY");
  const key = rawKey.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), key);
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(data.error_description ?? "Не удалось авторизоваться в Google");

  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

// Все обращения к Google Sheets идут строго по одному, а не параллельно.
// Без этого две записи, пришедшие почти одновременно, могут переплести свои
// шаги (создание вкладки, запись заголовка, дозапись строки) и одна из них
// затрёт данные другой — так уже случалось на практике при тесте гонки
let sheetsQueue: Promise<void> = Promise.resolve();

function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = sheetsQueue.then(fn);
  sheetsQueue = run.then(
    () => {},
    () => {}
  );
  return run;
}

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

async function sheetsRequest(sheetId: string, path: string, init: RequestInit = {}): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${SHEETS_API}/${sheetId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

// Список названий вкладок — короткий кэш, чтобы не запрашивать при каждой
// записи подряд (например несколько записей на один день)
let titlesCache: { titles: Set<string>; expiresAt: number } | null = null;

async function getSheetTitles(sheetId: string): Promise<Set<string>> {
  if (titlesCache && titlesCache.expiresAt > Date.now()) return titlesCache.titles;
  const data = await sheetsRequest(sheetId, "");
  const titles = new Set<string>(data.sheets.map((s: any) => s.properties.title));
  titlesCache = { titles, expiresAt: Date.now() + 60_000 };
  return titles;
}

async function ensureSheetExists(sheetId: string, title: string, header: string[]): Promise<void> {
  const titles = await getSheetTitles(sheetId);
  if (titles.has(title)) return;

  try {
    await sheetsRequest(sheetId, ":batchUpdate", {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
    });
  } catch (err) {
    // Две записи почти одновременно — обе не нашли вкладку и обе пытаются создать.
    // Кто-то один выигрывает, второй получает "already exists" — это не ошибка,
    // а нормальный исход гонки, просто продолжаем как будто вкладка уже была
    if (!(err instanceof Error && err.message.includes("already exists"))) throw err;
  }
  titlesCache = null;

  await sheetsRequest(sheetId, `/values/${encodeURIComponent(`'${title}'!A1`)}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: JSON.stringify({ values: [header] }),
  });
}

const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

// Вкладка на месяц, а не на день — при большом потоке записей вкладок "по дню"
// накопилось бы десятки, и найти нужную стало бы невозможно
function monthTitleOf(iso: string): string {
  const d = new Date(iso);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

function dateDisplay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

function timeDisplay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDisplay(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

const CLIENTS_SHEET = "Клиенты";
const CLIENTS_HEADER = ["Имя", "Контакт", "Визитов", "Последний визит", "Потрачено", "ID"];

async function upsertClient(
  sheetId: string,
  params: { key: string; name: string; contact: string; visitDate: string }
): Promise<void> {
  await ensureSheetExists(sheetId, CLIENTS_SHEET, CLIENTS_HEADER);

  const data = await sheetsRequest(sheetId, `/values/${encodeURIComponent(`'${CLIENTS_SHEET}'!A:F`)}`);
  const rows: string[][] = data.values ?? [];
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[5] === params.key);

  if (rowIndex === -1) {
    await sheetsRequest(
      sheetId,
      `/values/${encodeURIComponent(`'${CLIENTS_SHEET}'!A:F`)}:append?valueInputOption=USER_ENTERED`,
      {
        method: "POST",
        body: JSON.stringify({ values: [[params.name, params.contact, 1, params.visitDate, 0, params.key]] }),
      }
    );
    return;
  }

  const visits = (parseInt(rows[rowIndex][2], 10) || 0) + 1;
  const sheetRow = rowIndex + 1;
  await sheetsRequest(
    sheetId,
    `/values/${encodeURIComponent(`'${CLIENTS_SHEET}'!A${sheetRow}:D${sheetRow}`)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      body: JSON.stringify({ values: [[params.name, params.contact, visits, params.visitDate]] }),
    }
  );
}

export interface SheetBookingRow {
  clientName: string;
  contact: string;
  clientKey: string;
  serviceName: string;
  masterName: string;
  startsAtIso: string;
  price: number;
}

// Никогда не бросает наружу — сбой Google Таблицы не должен ломать запись клиента
export async function appendBookingRow(row: SheetBookingRow): Promise<void> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) return;

  return runSerialized(async () => {
  try {
    const monthTitle = monthTitleOf(row.startsAtIso);
    const display = formatDisplay(row.startsAtIso);

    await ensureSheetExists(sheetId, monthTitle, ["Дата", "Имя", "Контакт", "Услуга", "Мастер", "Время", "Цена"]);
    await sheetsRequest(sheetId, `/values/${encodeURIComponent(`'${monthTitle}'!A:G`)}:append?valueInputOption=USER_ENTERED`, {
      method: "POST",
      body: JSON.stringify({
        values: [
          [
            dateDisplay(row.startsAtIso),
            row.clientName,
            row.contact,
            row.serviceName,
            row.masterName,
            timeDisplay(row.startsAtIso),
            row.price,
          ],
        ],
      }),
    });

    await upsertClient(sheetId, { key: row.clientKey, name: row.clientName, contact: row.contact, visitDate: display });
  } catch (err) {
    console.warn("Google Sheets: ошибка записи", err instanceof Error ? err.message : err);
  }
  });
}

// Мастер отметил визит выполненным — прибавляем сумму клиенту в «Клиенты».
// Если клиента там ещё нет (Google был недоступен при создании записи) — тихо пропускаем
export async function addClientSpend(clientKey: string, amount: number): Promise<void> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) return;

  return runSerialized(async () => {
  try {
    const data = await sheetsRequest(sheetId, `/values/${encodeURIComponent(`'${CLIENTS_SHEET}'!A:F`)}`);
    const rows: string[][] = data.values ?? [];
    const rowIndex = rows.findIndex((r, i) => i > 0 && r[5] === clientKey);
    if (rowIndex === -1) return;

    const current = parseInt((rows[rowIndex][4] ?? "0").toString().replace(/\D/g, ""), 10) || 0;
    const sheetRow = rowIndex + 1;
    await sheetsRequest(sheetId, `/values/${encodeURIComponent(`'${CLIENTS_SHEET}'!E${sheetRow}`)}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      body: JSON.stringify({ values: [[current + amount]] }),
    });
  } catch (err) {
    console.warn("Google Sheets: ошибка обновления суммы клиента", err instanceof Error ? err.message : err);
  }
  });
}
