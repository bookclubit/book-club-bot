// Дополняет автогенерируемый интерфейс Env (worker-configuration.d.ts)
// секретами, которые задаются через `wrangler secret put`.
// Файл — глобальный скрипт (без import/export), поэтому интерфейсы сливаются.

interface Env {
	/** Токен Telegram-бота. Задаётся секретом: `wrangler secret put BOT_TOKEN`. */
	BOT_TOKEN: string;
	/** Необязательный секрет для проверки заголовка вебхука Telegram. */
	WEBHOOK_SECRET?: string;
}
