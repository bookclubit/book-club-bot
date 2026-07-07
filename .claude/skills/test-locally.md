# Skill: локальный запуск и тестирование

## Юнит-тесты

```
npm test              # vitest (@cloudflare/vitest-pool-workers)
npx tsc --noEmit      # проверка типов
```

Тесты SM-2 и health-check — в `test/index.spec.ts`.

## Локальный запуск воркера

```
npm run dev           # wrangler dev, по умолчанию http://localhost:8787
```

- `GET http://localhost:8787/` → health-check.
- Вебхук — это `POST /`. Можно эмулировать update от Telegram:

```bash
curl -s -X POST http://localhost:8787/ \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 1,
    "message": {
      "message_id": 1,
      "chat": {"id": 111, "type": "private"},
      "from": {"id": 111, "is_bot": false, "first_name": "Test"},
      "text": "/today"
    }
  }'
```

> Для реальной отправки сообщений локальному воркеру нужен `BOT_TOKEN`.
> Задай его в файле `.dev.vars` (он в .gitignore):
> ```
> BOT_TOKEN=123456:ABC...
> ```

## Проверка callback-кнопки

```bash
curl -s -X POST http://localhost:8787/ \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 2,
    "callback_query": {
      "id": "cb1",
      "from": {"id": 111, "is_bot": false},
      "message": {"message_id": 5, "chat": {"id": 111, "type": "private"}},
      "data": "show:docker-001"
    }
  }'
```

## Проверка cron (рассылки)

```
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+7+*+*+*"
```

## KV локально

`wrangler dev` использует локальный KV (в `.wrangler/`). Посмотреть ключи:
```
wrangler kv key list --binding CODEX_KV --local
```
