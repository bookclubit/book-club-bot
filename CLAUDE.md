# CLAUDE.md — book-club-bot

Телеграм-бот книжного клуба **«Codex»** для фронтендеров. Присылает карточки для
повторения материала книг и ведёт интервальное повторение по алгоритму **SM-2**.

## Назначение

- `/start` — подписка на ежедневную рассылку карточек
- `/stop` — отписка (прогресс сохраняется)
- `/today` — прислать до 5 карточек к повторению прямо сейчас
- `/status` — статистика изучения
- Ежедневная рассылка в **10:00 МСК** (cron `0 7 * * *`, т.е. 07:00 UTC)
- Карточки приходят с inline-кнопкой «Показать ответ», затем — оценка
  «Забыл / Сложно / Легко», по которой пересчитывается интервал.

## Стек

- **Cloudflare Workers** — рантайм (вебхук + cron)
- **Workers KV** (`CODEX_KV`) — подписчики и прогресс повторения
- **Cron Trigger** — ежедневная рассылка
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
