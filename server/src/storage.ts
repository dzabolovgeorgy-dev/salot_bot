const BUCKET = "master-photos";

// Как и в sheets.ts — обращаемся к Supabase Storage напрямую через fetch, без
// библиотеки @supabase/supabase-js: она в этой версии тянет за собой лишнюю
// зависимость (iceberg-js) и на Render зависала на реальной загрузке файла
// без ошибки (без таймаута fetch мог ждать ответ бесконечно)
function baseUrl(): string {
  return process.env.SUPABASE_URL!.replace(/\/$/, "");
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = process.env.SUPABASE_SERVICE_KEY!;
  return { Authorization: `Bearer ${key}`, apikey: key, ...extra };
}

function withTimeout(): AbortSignal {
  return AbortSignal.timeout(20000);
}

// Бакет ("папка" в файловом хранилище Supabase) создаётся сам при первом
// запуске сервера — не нужно ничего настраивать руками в дашборде.
// public: true — чтобы фото открывались обычной ссылкой <img src="...">
export async function initStorage(): Promise<void> {
  const res = await fetch(`${baseUrl()}/storage/v1/bucket`, { headers: authHeaders(), signal: withTimeout() });
  if (!res.ok) {
    console.warn("Не удалось получить список бакетов для фото:", res.status, await res.text());
    return;
  }
  const buckets = (await res.json()) as { name: string }[];
  if (buckets.some((b) => b.name === BUCKET)) return;

  const createRes = await fetch(`${baseUrl()}/storage/v1/bucket`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name: BUCKET, public: true }),
    signal: withTimeout(),
  });
  if (!createRes.ok) console.warn("Не удалось создать бакет для фото:", createRes.status, await createRes.text());
}

// Загружает файл и возвращает публичную ссылку на него
export async function uploadPhoto(path: string, buffer: Buffer, contentType: string): Promise<string> {
  const res = await fetch(`${baseUrl()}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": contentType, "x-upsert": "true" }),
    body: new Uint8Array(buffer),
    signal: withTimeout(),
  });
  if (!res.ok) throw new Error(`Supabase Storage: ${res.status} ${await res.text()}`);
  return `${baseUrl()}/storage/v1/object/public/${BUCKET}/${path}`;
}

export async function deletePhoto(path: string): Promise<void> {
  await fetch(`${baseUrl()}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prefixes: [path] }),
    signal: withTimeout(),
  });
}

// Из публичной ссылки достаём путь внутри бакета — нужен, чтобы удалить
// старое фото при замене (иначе в хранилище копится мусор)
export function pathFromPublicUrl(url: string): string | null {
  const marker = `/object/public/${BUCKET}/`;
  const i = url.indexOf(marker);
  return i === -1 ? null : url.slice(i + marker.length);
}
