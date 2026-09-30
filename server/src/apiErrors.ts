import type { Router, RequestHandler, ErrorRequestHandler } from "express";
import { t } from "./i18n.js";

// Express 4 не замечает ошибки внутри async-обработчиков: если запрос к базе
// упал (обрыв связи и т.п.), ошибка не доходит до общего обработчика ошибок
// (handleApiErrors ниже), и человек не получает вообще никакого ответа —
// приложение ждёт до бесконечности. Здесь каждый обработчик роутера один раз
// "оборачивается": если он вернул промис и тот упал — ошибка передаётся в
// next(err), и человек сразу получает понятный ответ.
// Вызывать сразу после создания роутера, до регистрации маршрутов
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function wrap(handler: unknown): unknown {
  // Обработчики ошибок (4 аргумента) и не-функции не трогаем
  if (typeof handler !== "function" || handler.length === 4) return handler;
  const fn = handler as RequestHandler;
  const wrapped: RequestHandler = (req, res, next) => {
    try {
      const result: unknown = fn(req, res, next);
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
  return wrapped;
}

export function forwardAsyncErrors(router: Router): void {
  for (const method of METHODS) {
    const original = router[method].bind(router) as (...args: unknown[]) => Router;
    (router as unknown as Record<string, unknown>)[method] = (path: unknown, ...handlers: unknown[]) =>
      original(path, ...handlers.map(wrap));
  }
}

// Общий обработчик ошибок запросов к /api. Сюда приходят и ошибки загрузки
// файлов (раньше слишком большой файл просто обрывал соединение — на телефоне
// это выглядело как загадочное "Load failed"), и любые неожиданные ошибки
// (обрыв связи с базой и т.п.). Человек получает понятный ответ на своём
// языке, а подробности остаются в журнале сервера
export const handleApiErrors: ErrorRequestHandler = (err, req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: t(req.lang, "errors.fileTooLarge") });
    return;
  }
  console.error(`Необработанная ошибка запроса ${req.method} ${req.originalUrl}:`, err);
  // Ответ уже ушёл (ошибка случилась после него) — второй раз отвечать нельзя
  if (res.headersSent) return;
  res.status(500).json({ error: t(req.lang, "errors.serverError") });
};
