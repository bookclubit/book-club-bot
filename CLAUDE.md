# CLAUDE.md — book-club-bot

Телеграм-бот **«Книжного клуба»** для фронтендеров. Присылает карточки для
повторения материала книг и ведёт интервальное повторение по алгоритму **SM-2**.

## Назначение

- `/start` — подписка на ежедневную рассылку карточек
- `/stop` — отписка (прогресс сохраняется)
- `/today` — прислать до 5 карточек к повторению прямо сейчас
- `/status` — статистика изучения
- `/speaker` — выступить с докладом (участникам) или заявка на участие (новым)
- `/anons_here` — (в группе, от админа) постить сюда анонсы встреч
- Ежедневная рассылка в **10:00 МСК** (cron `0 7 * * *`, т.е. 07:00 UTC)
- Карточки приходят с inline-кнопкой «Показать ответ», затем — оценка
  «Забыл / Сложно / Легко», по которой пересчитывается интервал.

### Регистрации (состояние в D1)

- `/start join_<eventId>` (кнопка «Пойду» в miniapp) — запись на встречу:
  бот сразу присылает ссылки (Meet, стримы, доска, материалы) и напоминает
  утром (ежедневный cron) и в начале встречи (cron `*/5 * * * *`,
  дубли отсекает таблица `reminders_sent`).
- `/speaker` (или `/start speaker`) — **две ветки, зависят от участия**
  (`src/lib/members.ts`, `speakerAccess`):
  - **участник клуба** (есть в каталоге `speakers.json` по Telegram-нику, или
    одобрена заявка на участие, или бот уже сопоставлял его с каталогом) —
    свободные темы плана кнопками (`src/lib/plan.ts`, уникальность брони —
    индекс D1). Имя, фото и каталожный id бот уже знает: диалога нет, заявка
    сразу уходит админу;
  - **новый человек** — темы недоступны. Диалог заявки на участие:
    имя → рассказ о себе (это сообщение видит админ) → фото (или /skip).
    Черновик живёт в `speaker_dialog.data`, готовая заявка — в
    `membership_requests` (одна на человека, повторная отправка обновляет её).
    Одобрение админа открывает темы; принятого участника повторная заявка
    не сбрасывает.
  - «Предложить свою тему» — тоже только участникам; `/cancel` — прервать.
  Админ получает в TG только уведомление со ссылкой на CMS — **модерация
  в CMS**, бот сам сообщает решение (заявку могли отправить из браузера, ни разу
  не написав боту, — ошибка доставки не отменяет решение).
- Запись на встречу и карточки — **всем**, без заявки: гейт только на темах.

### Посты о встречах в группу клуба

Три поста на встречу (`src/lib/announce.ts` — тексты, `src/lib/announcer.ts` —
отправка и план, таблица `announcements` в D1):

- **анонс** — сразу после создания встречи в CMS;
- **афиша дня** — в 10:00 МСК в день встречи;
- **напоминание** — за 5 минут до начала (поэтому cron `*/5 * * * *`).

Чат задаётся командой `/anons_here` в самой группе — только от админа чата
(`bot_settings.announce_chat_id`). Бот должен быть админом группы.

**Поля встречи приходят из CMS снимком** (`POST /api/admin/announce`): в момент
анонса встречи ещё нет в book-club-data — она в открытом pull request-е. Всё
остальное берётся свежим на каждый пост: книга и глава из book-club-data,
спикеры (`@username`) из подтверждённых заявок в D1, презентации из
`speaker_claims.slides_url`. Повторный вызов (правка встречи) обновляет план и
афишу дня, но анонс второй раз не публикует.

Афиши **не идут через репозиторий** (raw-URL появился бы только после мержа):
CMS присылает картинку base64, бот отправляет её `sendPhoto` и переиспользует
полученный `file_id`. Афиша дня до публикации лежит в KV (`poster:<eventId>`).
Подпись к фото у Telegram ограничена 1024 символами — длинный пост уходит
двумя сообщениями.

### HTTP API (для miniapp и CMS)

- `GET /api/claims` — публичная занятость тем (CORS `*`).
- `GET/POST /api/membership` — участие текущего пользователя и заявка из
  miniapp (`{ full_name, about }`); `POST /api/claim` — бронь темы из miniapp
  (403 без участия, 404 темы нет в плане, 409 тему заняли). Auth — сессия
  Telegram (`Authorization: Bearer <session>`), тот же путь, что у бота.
- `GET/POST /api/admin/claims`, `GET/POST /api/admin/members`,
  `GET /api/admin/photo?claim=<id>|?member=<id>` — модерация заявок на доклад
  и на участие, фото из Telegram; auth: `Authorization: Bearer <ADMIN_API_TOKEN>`.
- `POST /api/admin/announce` — анонс встречи в группу: `{ event, posters }`.
  409 — чат для анонсов не задан (нужен `/anons_here`).

Принцип: **контент — в git (book-club-data), оперативное состояние
(брони, записи, диалоги) — в D1.** Обработчики — `src/handlers/registration.ts`,
слой D1 — `src/lib/db.ts` (схема создаётся лениво).

## Стек

- **Cloudflare Workers** — рантайм (вебхук + cron)
- **Workers KV** (`BOOK_CLUB_KV`) — подписчики рассылки
- **D1** (`BOOK_CLUB_DB`, база `book-club-bot`) — брони тем, записи на встречи,
  единый прогресс SM-2 (общий для бота и сайта)
- **Cron Trigger** — ежедневная рассылка + напоминания о встречах
- **TypeScript**, Wrangler 4, Vitest (`@cloudflare/vitest-pool-workers`)

## Данные

Карточки и метаданные книг берутся из репозитория `book-club-data` (GitHub raw):

```
https://raw.githubusercontent.com/bookclubit/book-club-data/main/books/<bookId>/flashcards.json
https://raw.githubusercontent.com/bookclubit/book-club-data/main/books/<bookId>/meta.json
```

Карточки берутся по **всем книгам клуба** (обход `index.json`, `fetchAllFlashcards`),
не только Docker. Повторение — по одной, диалогом: очередь в D1 (`study_session`),
кнопки с коротким `callback_data` (`sf`/`sg:<grade>`). Лимит карт/день — `/settings`
(`user_settings`). Прогресс SM-2 — в D1, ключ `<book>:<cardId>`.
Типы карточек: `qa` (вопрос/ответ) и `command` (команда/что делает).

## Структура

```
src/
  index.ts                 — точка входа: fetch (вебхук) + scheduled (cron), роутинг
  types.ts                 — типы (Flashcard, Subscriber, CardProgress, Telegram*)
  env.d.ts                 — дополнение интерфейса Env секретами (BOT_TOKEN)
  lib/
    api.ts                 — fetchFlashcards, fetchIndex, fetchAllFlashcards (GitHub raw, с retry)
    spaced-repetition.ts   — calculateNextReview, reviewFromQuality, selectDue (SM-2)
    telegram.ts            — sendMessage, sendPost, sendPhoto*, isChatAdmin, answerCallback (с retry)
    announce.ts            — тексты постов о встрече (анонс, афиша дня, напоминание)
    announcer.ts           — отправка постов, план публикаций, cron-раннер
    members.ts             — кто участник клуба (speakerAccess): гейт на темы
    plan.ts                — темы будущих эфиров-«докладов» (слоты)
    storage.ts             — работа с KV (подписчики рассылки)
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

Прогресс карточек живёт **не в KV, а в D1** (таблица `card_progress`,
ключ `<book>:<cardId>`) — общий для бота и сайта.

## Секреты и переменные

- `BOT_TOKEN` — токен Telegram-бота. Задаётся: `wrangler secret put BOT_TOKEN`.
  **Никогда не коммитить токен в код или конфиг.**
- `WEBHOOK_SECRET` (**обязателен**) — секрет для проверки заголовка
  `X-Telegram-Bot-Api-Secret-Token` вебхука. Проверка fail-closed: без него
  вебхук отвечает 500. Тот же секрет передаётся в `setWebhook` (`secret_token`).
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
