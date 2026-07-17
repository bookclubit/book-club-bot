// Дополняет автогенерируемый интерфейс Env (worker-configuration.d.ts)
// секретами, которые задаются через `wrangler secret put`.
// Файл — глобальный скрипт (без import/export), поэтому интерфейсы сливаются.

interface Env {
	/** Токен Telegram-бота. Задаётся секретом: `wrangler secret put BOT_TOKEN`. */
	BOT_TOKEN: string;
	/** Необязательный секрет для проверки заголовка вебхука Telegram. */
	WEBHOOK_SECRET?: string;
	/**
	 * chat_id админа клуба — сюда приходят заявки спикеров на модерацию.
	 * Задаётся секретом: `wrangler secret put ADMIN_CHAT_ID`. Без него
	 * заявки принимаются, но уведомления не отправляются.
	 */
	ADMIN_CHAT_ID?: string;
}
