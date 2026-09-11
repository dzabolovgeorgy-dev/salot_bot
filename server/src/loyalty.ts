import { db } from "./db.js";

// Уровни зависят от total_spent (сумма потраченного за всё время, в валюте базы).
// Границы — нижняя включительно, верхняя не включительно (кроме последнего уровня)
export interface LoyaltyTier {
  name: string;
  minSpent: number;
  cashbackRate: number;
}

export const LOYALTY_TIERS: LoyaltyTier[] = [
  { name: "Новичок", minSpent: 0, cashbackRate: 0.03 },
  { name: "Серебро", minSpent: 150, cashbackRate: 0.05 },
  { name: "Золото", minSpent: 450, cashbackRate: 0.07 },
  { name: "Платина", minSpent: 900, cashbackRate: 0.1 },
];

const POINTS_EXPIRY_MONTHS = 6;
// Баллами можно закрыть не больше этой доли чека за один визит
const MAX_REDEEM_SHARE = 0.3;

export function getTier(totalSpent: number): LoyaltyTier {
  let tier = LOYALTY_TIERS[0];
  for (const candidate of LOYALTY_TIERS) {
    if (totalSpent >= candidate.minSpent) tier = candidate;
  }
  return tier;
}

// Следующий уровень и сколько до него осталось потратить (null — уже на максимальном уровне)
export function getNextTierProgress(totalSpent: number): { nextTier: LoyaltyTier; remaining: number } | null {
  const currentIndex = LOYALTY_TIERS.findIndex((t) => t.name === getTier(totalSpent).name);
  const nextTier = LOYALTY_TIERS[currentIndex + 1];
  if (!nextTier) return null;
  return { nextTier, remaining: nextTier.minSpent - totalSpent };
}

// Начисляет кэшбэк за визит: кэшбэк — по уровню клиента ДО этого визита,
// затем сумма визита добавляется в total_spent (уровень для следующего визита
// пересчитается сам — он не хранится отдельно, а всегда считается по total_spent)
export async function accrueForCompletedVisit(
  clientTelegramId: number,
  price: number,
  serviceName: string
): Promise<{ cashback: number; newBalance: number }> {
  const { rows } = await db.query(
    `INSERT INTO loyalty_points (client_telegram_id, points_balance, total_spent)
     VALUES ($1, 0, 0)
     ON CONFLICT (client_telegram_id) DO UPDATE SET client_telegram_id = loyalty_points.client_telegram_id
     RETURNING points_balance, total_spent`,
    [clientTelegramId]
  );
  const totalSpentBefore = rows[0].total_spent as number;

  const tier = getTier(totalSpentBefore);
  const cashback = Math.round(price * tier.cashbackRate);

  const { rows: updated } = await db.query(
    `UPDATE loyalty_points SET points_balance = points_balance + $1, total_spent = total_spent + $2
     WHERE client_telegram_id = $3 RETURNING points_balance`,
    [cashback, price, clientTelegramId]
  );

  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + POINTS_EXPIRY_MONTHS);

  await db.query(
    `INSERT INTO loyalty_transactions (client_telegram_id, amount, reason, expires_at, service_name)
     VALUES ($1, $2, 'начисление за визит', $3, $4)`,
    [clientTelegramId, cashback, expiresAt, serviceName]
  );

  return { cashback, newBalance: updated[0].points_balance as number };
}

export interface LoyaltyStatus {
  pointsBalance: number;
  totalSpent: number;
  tierName: string;
  cashbackRate: number;
  nextTierName: string | null;
  amountToNextTier: number | null;
}

export async function getLoyaltyStatus(clientTelegramId: number): Promise<LoyaltyStatus> {
  const { rows } = await db.query(
    "SELECT points_balance, total_spent FROM loyalty_points WHERE client_telegram_id = $1",
    [clientTelegramId]
  );
  const pointsBalance = (rows[0]?.points_balance as number) ?? 0;
  const totalSpent = (rows[0]?.total_spent as number) ?? 0;
  const tier = getTier(totalSpent);
  const next = getNextTierProgress(totalSpent);
  return {
    pointsBalance,
    totalSpent,
    tierName: tier.name,
    cashbackRate: tier.cashbackRate,
    nextTierName: next?.nextTier.name ?? null,
    amountToNextTier: next?.remaining ?? null,
  };
}

export interface LoyaltyHistoryEntry {
  id: number;
  amount: number;
  reason: string;
  service_name: string | null;
  created_at: string;
}

export async function getLoyaltyHistory(clientTelegramId: number, limit = 10): Promise<LoyaltyHistoryEntry[]> {
  const { rows } = await db.query(
    `SELECT id, amount, reason, service_name, created_at FROM loyalty_transactions
     WHERE client_telegram_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [clientTelegramId, limit]
  );
  return rows as LoyaltyHistoryEntry[];
}

// Максимум баллов, которыми можно закрыть услугу с такой ценой — меньшее из
// баланса клиента и 30% от цены
export function maxRedeemable(pointsBalance: number, servicePrice: number): number {
  return Math.max(0, Math.min(pointsBalance, Math.floor(servicePrice * MAX_REDEEM_SHARE)));
}

// Списывает баллы при оплате визита. Условие points_balance >= points прямо в
// WHERE — защита от гонки, если баланс изменился между проверкой и списанием
// (например, два запроса одновременно). Проверка лимита 30% — на вызывающей
// стороне, до создания записи, здесь только сам факт списания
export async function commitRedeem(clientTelegramId: number, points: number): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE loyalty_points SET points_balance = points_balance - $1 WHERE client_telegram_id = $2 AND points_balance >= $1",
    [points, clientTelegramId]
  );
  if (!rowCount) return false;

  await db.query(
    `INSERT INTO loyalty_transactions (client_telegram_id, amount, reason) VALUES ($1, $2, 'списание при оплате')`,
    [clientTelegramId, -points]
  );
  return true;
}
