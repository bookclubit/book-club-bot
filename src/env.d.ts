// Дополняет автогенерируемый интерфейс Env (worker-configuration.d.ts)
// секретами, которые задаются через `wrangler secret put`.
// Файл — глобальный скрипт (без import/export), поэтому интерфейсы сливаются.

interface Env {
	/** Токен Telegram-бота. Задаётся секретом: `wrangler secret put BOT_TOKEN`. */
	BOT_TOKEN: string;
	/** Необязательный секрет для проверки заголовка вебхука Telegram. */
	WEBHOOK_SECRET?: string;
	/**
	 * chat_id админа клуба — сюда приходят уведомления о заявках спикеров
	 * (модерация — в CMS). Задаётся: `wrangler secret put ADMIN_CHAT_ID`.
	 */
	ADMIN_CHAT_ID?: string;
	/**
	 * Токен для админских эндпоинтов API (/api/admin/*) — его же админ
	 * вводит в CMS. Задаётся: `wrangler secret put ADMIN_API_TOKEN`.
	 */
	ADMIN_API_TOKEN?: string;
}
