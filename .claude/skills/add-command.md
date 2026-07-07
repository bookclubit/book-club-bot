# Skill: добавить команду боту

Как добавить новую команду (например, `/help`).

## Шаги

1. **Создай обработчик** `src/commands/<имя>.ts` по образцу существующих:

   ```ts
   import type { TelegramMessage } from "../types";
   import { sendMessage } from "../lib/telegram";

   export async function handleHelp(env: Env, message: TelegramMessage): Promise<void> {
     await sendMessage(env.BOT_TOKEN, message.chat.id, "Текст справки…");
   }
   ```

   - Весь текст — на русском.
   - Для inline-кнопок передавай `InlineKeyboardMarkup` четвёртым аргументом.
   - Значимые действия логируй через `console.log`.

2. **Подключи роутинг** в `src/index.ts`:
   - импортируй `handleHelp`;
   - добавь `case "help": return handleHelp(env, message);` в `routeMessage`;
   - при необходимости упомяни команду в `UNKNOWN_COMMAND` и в приветствии `start.ts`.

3. **Данные книги** бери через `lib/api.ts` (`fetchFlashcards`, `fetchBookMeta`),
   прогресс — через `lib/storage.ts`. Не обращайся к KV и fetch напрямую из команды.

4. **Тесты**: при наличии логики добавь проверку в `test/index.spec.ts`.

5. **Проверка**:
   ```
   npx tsc --noEmit
   npm test
   ```

6. **Меню команд** (необязательно) — обнови список у BotFather или через
   `setMyCommands`.

7. **Коммит**: `feat(commands): добавить команду /help`.
