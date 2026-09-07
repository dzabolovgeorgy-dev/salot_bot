import { createClient } from "@supabase/supabase-js";

const BUCKET = "master-photos";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

// Бакет ("папка" в файловом хранилище Supabase) создаётся сам при первом
// запуске сервера — не нужно ничего настраивать руками в дашборде.
// public: true — чтобы фото открывались обычной ссылкой <img src="...">
export async function initStorage(): Promise<void> {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (buckets?.some((b) => b.name === BUCKET)) return;
  const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
  if (error) console.warn("Не удалось создать бакет для фото:", error.message);
}

// Загружает файл и возвращает публичную ссылку на него
export async function uploadPhoto(path: string, buffer: Buffer, contentType: string): Promise<string> {
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(error.message);
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

export async function deletePhoto(path: string): Promise<void> {
  await supabase.storage.from(BUCKET).remove([path]);
}

// Из публичной ссылки достаём путь внутри бакета — нужен, чтобы удалить
// старое фото при замене (иначе в хранилище копится мусор)
export function pathFromPublicUrl(url: string): string | null {
  const marker = `/object/public/${BUCKET}/`;
  const i = url.indexOf(marker);
  return i === -1 ? null : url.slice(i + marker.length);
}
