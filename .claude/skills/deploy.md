# Skill: деплой и настройка вебхука

Деплой воркера на Cloudflare и подключение вебхука Telegram.

## Предпосылки

- Wrangler авторизован (`wrangler whoami`).
- Секрет токена задан:
  ```
  wrangler secret put BOT_TOKEN
  ```
  (значение — токен от BotFather; в код/конфиг не коммитить).

## Деплой

```
npm test            # прогнать тесты
npx tsc --noEmit    # типы
npm run deploy      # = wrangler deploy
```

После деплоя wrangler покажет URL воркера, например:
`https://book-club-bot.<subdomain>.workers.dev`

## Настройка вебхука Telegram

Замени `<TOKEN>` и `<WORKER_URL>`:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"<WORKER_URL>","allowed_updates":["message","callback_query"]}'
```

Если используешь `WEBHOOK_SECRET`, добавь в тело `"secret_token":"<SECRET>"`
(и задай тот же секрет: `wrangler secret put WEBHOOK_SECRET`).

Проверка:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

`url` должен совпадать, `pending_update_count` — уменьшаться, `last_error_message`
— отсутствовать.

## Проверка работы

- Открой `<WORKER_URL>` в браузере — должно вернуться
  `Бот «Книжного клуба» работает 🤖`.
- Напиши боту `/start` — придёт приветствие.
- Логи в реальном времени: `wrangler tail`.

## Cron

Расписание задаётся в `wrangler.jsonc` → `triggers.crons`. Текущее:
`0 7 * * *` (07:00 UTC = 10:00 МСК). Проверить срабатывание локально:
`wrangler dev --test-scheduled`, затем `curl "http://localhost:8787/__scheduled"`.
