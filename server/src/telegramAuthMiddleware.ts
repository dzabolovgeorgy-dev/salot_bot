import type { NextFunction, Request, Response } from "express";
import { verifyInitData } from "./telegramAuth.js";
import { INTERNAL_API_SECRET } from "./internalAuth.js";
import { PWA_SESSION_COOKIE, getPwaSessionTelegramId } from "./pwaAuth.js";

// Простой разбор заголовка Cookie — своя мини-функция вместо отдельного
// пакета cookie-parser, так как нужно прочитать всего одно значение
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

declare global {
  namespace Express {
    interface Request {
      // Telegram ID, чью подпись реально проверили (initData из заголовка) —
      // undefined, если заголовка не было или подпись не сошлась
      verifiedTelegramId?: number;
      // true — запрос пришёл не из браузера, а от самого сервера (диалог
      // записи в чате). Личность в этом случае уже подтвердил сам Telegram,
      // доставив сообщение боту — второй раз через initData её взять неоткуда
      internalTrusted?: boolean;
    }
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN ?? "";

// На каждый запрос смотрим: пришёл ли "подписанный конверт" от Telegram
// (значит это открыто Mini App), внутренний секрет сервера (диалог в чате
// обращается сам к себе) или cookie с PWA-сессией (вход по коду без
// Telegram — см. pwaAuth.ts). Ничего не блокируем здесь — просто
// записываем, что удалось подтвердить, а решение "пускать или нет" каждый
// эндпоинт принимает сам, сравнивая с тем telegram_id, который он получил
export async function attachTelegramIdentity(req: Request, _res: Response, next: NextFunction) {
  const internalSecret = req.header("X-Internal-Secret");
  if (internalSecret && internalSecret === INTERNAL_API_SECRET) {
    req.internalTrusted = true;
    next();
    return;
  }

  const initData = req.header("X-Telegram-Init-Data");
  if (initData && BOT_TOKEN) {
    const user = verifyInitData(initData, BOT_TOKEN);
    if (user) {
      req.verifiedTelegramId = user.id;
      next();
      return;
    }
  }

  const sessionToken = readCookie(req.header("Cookie"), PWA_SESSION_COOKIE);
  if (sessionToken) {
    const telegramId = await getPwaSessionTelegramId(sessionToken);
    if (telegramId != null) {
      req.verifiedTelegramId = telegramId;
    }
  }
  next();
}
