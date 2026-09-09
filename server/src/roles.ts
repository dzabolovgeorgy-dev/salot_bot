import { db } from "./db.js";

export type Role = { role: "client" } | { role: "master"; master_id: number; master_name: string } | { role: "admin" };

// Роль пользователя по Telegram ID: клиент (нет в staff), мастер или админ.
// Вынесено в отдельный файл, чтобы им мог пользоваться и api.ts (эндпоинты),
// и bot.ts (приветствие в чате) — без циклической зависимости между ними
export async function getRole(telegramId: number): Promise<Role> {
  const { rows } = await db.query<{ role: "master" | "admin"; master_id: number | null; master_name: string | null }>(
    `SELECT s.role, s.master_id, m.name AS master_name
     FROM staff s
     LEFT JOIN masters m ON m.id = s.master_id
     WHERE s.telegram_id = $1`,
    [telegramId]
  );
  const row = rows[0];
  if (!row) return { role: "client" };
  if (row.role === "master") {
    return { role: "master", master_id: row.master_id!, master_name: row.master_name! };
  }
  return { role: "admin" };
}

export async function requireAdmin(telegramId: number): Promise<boolean> {
  const role = await getRole(telegramId);
  return role.role === "admin";
}
