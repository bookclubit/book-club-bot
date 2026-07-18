# CLAUDE.md — book-club-bot

Телеграм-бот **«Книжного клуба»** для фронтендеров. Присылает карточки для
повторения материала книг и ведёт интервальное повторение по алгоритму **SM-2**.

## Назначение

- `/start` — подписка на ежедневную рассылку карточек
- `/stop` — отписка (прогресс сохраняется)
- `/today` — прислать до 5 карточек к повторению прямо сейчас
- `/status` — статистика изучения
- Ежедневная рассылка в **10:00 МСК** (cron `0 7 * * *`, т.е. 07:00 UTC)
- Карточки приходят с inline-кнопкой «Показать ответ», затем — оценка
  «Забыл / Сложно / Легко», по которой пересчитывается интервал.

### Регистрации (состояние в D1)

- `/start join_<eventId>` (кнопка «Пойду» в miniapp) — запись на встречу:
  бот сразу присылает ссылки (Meet, стримы, доска, материалы) и напоминает
  утром (ежедневный cron) и в начале встречи (cron `*/15 * * * *`,
  дубли отсекает таблица `reminders_sent`).
- `/speaker` (или `/start speaker`) — заявка на доклад, **не привязана
  к встрече**: темы из плана (главы активных книг будущих встреч, КРОМЕ
  ближайшей — см. `src/lib/plan.ts`), занятые с 🔒 (уникальность брони —
  индекс D1). Диалог: тема → ФИО → фото (или /skip), `/cancel` — прервать.
  Админ получает в TG только уведомление со ссылкой на CMS — **модерация
  в CMS**, бот сам сообщает спикеру решение.

### HTTP API (для miniapp и CMS)

- `GET /api/claims` — публичная занятость тем (CORS `*`).
- `GET/POST /api/admin/claims`, `GET /api/admin/photo?claim=<id>` — модерация
  и фото спикера; auth: `Authorization: Bearer <ADMIN_API_TOKEN>`.

Принцип: **контент — в git (book-club-data), оперативное состояние
(брони, записи, диалоги) — в D1.** Обработчики — `src/handlers/registration.ts`,
слой D1 — `src/lib/db.ts` (схема создаётся лениво).

## Стек

- **Cloudflare Workers** — рантайм (вебхук + cron)
- **Workers KV** (`BOOK_CLUB_KV`) — подписчики и прогресс повторения
- **D1** (`BOOK_CLUB_DB`, база `book-club-bot`) — брони тем и записи на встречи
- **Cron Trigger** — ежедневная рассылка + напоминания о встречах
- **TypeScript**, Wrangler 4, Vitest (`@cloudflare/vitest-pool-workers`)

## Данные

Карточки и метаданные книг берутся из репозитория `book-club-data` (GitHub raw):

```
https://raw.githubusercontent.com/bookclubit/book-club-data/main/books/<bookId>/flashcards.json
https://raw.githubusercontent.com/bookclubit/book-club-data/main/books/<bookId>/meta.json
```

Пока используется только книга `docker-up-and-running` (константа `BOOK_ID` в `src/types.ts`).
Типы карточек: `qa` (вопрос/ответ) и `command` (команда/что делает).

## Структура

```
src/
  index.ts                 — точка входа: fetch (вебхук) + scheduled (cron), роутинг
  types.ts                 — типы (Flashcard, Subscriber, CardProgress, Telegram*)
  env.d.ts                 — дополнение интерфейса Env секретами (BOT_TOKEN)
  lib/
    api.ts                 — fetchFlashcards, fetchBookMeta (GitHub raw, с retry)
    spaced-repetition.ts   — calculateNextReview, getDueCards (SM-2)
    telegram.ts            — sendMessage, editMessageText, answerCallback (с retry)
    storage.ts             — работа с KV (подписчики, прогресс)
    cards.ts               — рендеринг карточек, клавиатуры, sendDueCards
  commands/
    start.ts stop.ts today.ts status.ts
  handlers/
    callback.ts            — обработка кнопок (показать ответ / оценка)
test/
  index.spec.ts            — тесты health-check и SM-2
```

## Хранилище (ключи KV)

- `sub:<chatId>` → `Subscriber`
- `progress:<chatId>:<cardId>` → `CardProgress`

## Секреты и переменные

- `BOT_TOKEN` — токен Telegram-бота. Задаётся: `wrangler secret put BOT_TOKEN`.
  **Никогда не коммитить токен в код или конфиг.**
- `WEBHOOK_SECRET` (необязательно) — секрет для проверки заголовка
  `X-Telegram-Bot-Api-Secret-Token` вебхука.
- `ADMIN_CHAT_ID` — chat_id админа для уведомлений о заявках
  (`wrangler secret put ADMIN_CHAT_ID`).
- `ADMIN_API_TOKEN` — токен админских эндпоинтов API; его же админ вводит
  в CMS на странице входа (`wrangler secret put ADMIN_API_TOKEN`).

## Команды разработки

```
npm run dev         # локальный запуск (wrangler dev)
npm test            # vitest
npm run deploy      # wrangler deploy
npm run cf-typegen  # регенерация типов Env после правок wrangler.jsonc
```

После деплоя вебхук ставится через Telegram API `setWebhook` (см. `.claude/skills/deploy.md`).

## Правила

- Весь пользовательский текст — **на русском**.
- Кнопки — только **inline** (не reply-клавиатура).
- Все внешние запросы (GitHub, Telegram) — **с retry** на сетевые ошибки и 5xx/429.
- Update обрабатывается в `ctx.waitUntil`, Telegram сразу отвечаем `200 OK`.
- Секреты — только в env vars, не в коде.

### Коммиты (Conventional Commits)

Формат: `тип(область): описание`. Типы: `feat`, `fix`, `docs`, `style`,
`refactor`, `test`, `chore`. **Описание — на русском языке.**

Примеры:

```
feat(commands): добавить команду /today
fix(telegram): повторять запрос при ошибке 429
docs(readme): описать процесс деплоя
```
