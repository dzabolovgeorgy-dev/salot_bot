import type { NextFunction, Request, Response } from "express";
import { verifyInitData } from "./telegramAuth.js";
import { INTERNAL_API_SECRET } from "./internalAuth.js";

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
// (значит это открыто Mini App) или внутренний секрет сервера (значит это
// диалог в чате обращается сам к себе). Ничего не блокируем здесь — просто
// записываем, что удалось подтвердить, а решение "пускать или нет" каждый
// эндпоинт принимает сам, сравнивая с тем telegram_id, который он получил
export function attachTelegramIdentity(req: Request, _res: Response, next: NextFunction) {
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
    }
  }
  next();
}
