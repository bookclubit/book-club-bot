# book-club-bot

Телеграм-бот **«Книжного клуба»** для фронтендеров. Присылает карточки для
повторения материала книг и ведёт интервальное повторение по алгоритму **SM-2**.
Работает на **Cloudflare Workers** (вебхук + cron) с хранением в **Workers KV**.

Бот: [@bookclubfrontbot](https://t.me/bookclubfrontbot)

## Команды

| Команда   | Действие                                             |
| --------- | ---------------------------------------------------- |
| `/start`  | Подписка на ежедневную рассылку карточек             |
| `/stop`   | Отписка (прогресс сохраняется)                       |
| `/today`  | Прислать до 5 карточек к повторению прямо сейчас     |
| `/status` | Статистика изучения                                  |

Ежедневная рассылка — в **10:00 МСК** (cron `0 7 * * *`). Карточка приходит с
кнопкой «Показать ответ», после ответа — оценка «Забыл / Сложно / Легко», по
которой пересчитывается интервал следующего повторения.

## Стек

- Cloudflare Workers (TypeScript)
- Workers KV — подписчики рассылки
- D1 — брони тем, записи на встречи, прогресс SM-2 (общий для бота и сайта)
- Cron Trigger — ежедневная рассылка
- Wrangler 4, Vitest

## Данные

Карточки берутся из репозитория
[`book-club-data`](https://github.com/bookclubit/book-club-data)
(папка `books/<bookId>`) — по **всем книгам клуба** из реестра `index.json`.

## Разработка

```bash
npm install
npm run dev          # локальный запуск (wrangler dev)
npm test             # тесты (vitest)
npx tsc --noEmit     # проверка типов
```

## Деплой

```bash
wrangler secret put BOT_TOKEN        # токен от BotFather
wrangler secret put WEBHOOK_SECRET   # обязателен: без него вебхук отвечает 500
npm run deploy
```

Секрет вебхука нужно передать и в `setWebhook` (`secret_token`) — проверка
fail-closed: запросы без верного `X-Telegram-Bot-Api-Secret-Token` отклоняются.

### Переменные (vars)

Внешние адреса вынесены в `vars` в `wrangler.jsonc` (в коде есть фолбэки
на эти же значения, деплой без переменных ничего не ломает):

| Переменная       | Назначение                                                        |
| ---------------- | ----------------------------------------------------------------- |
| `RAW_ROOT`       | Корень raw-контента `book-club-data`                              |
| `TALKS_REPO`     | Репозиторий презентаций `book-club-talks`                         |
| `MINIAPP_URL`    | Мини-приложение клуба (кнопка меню бота)                          |
| `CMS_CLAIMS_URL` | Страница модерации в CMS; её origin — CORS-домен для `/api/admin/*` |

Подробности — в [CLAUDE.md](./CLAUDE.md) и `.claude/skills/deploy.md`.

## Структура

```
src/
  index.ts               точка входа: вебхук (fetch) + рассылка (scheduled)
  types.ts               общие типы
  lib/                   api, spaced-repetition (SM-2), telegram, storage, cards
  commands/              start, stop, today, status
  handlers/callback.ts   обработка inline-кнопок
test/                    тесты SM-2 и health-check
```
