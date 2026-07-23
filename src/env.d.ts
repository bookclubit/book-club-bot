// Дополняет автогенерируемый интерфейс Env (worker-configuration.d.ts)
// секретами, которые задаются через `wrangler secret put`.
// Файл — глобальный скрипт (без import/export), поэтому интерфейсы сливаются.

interface Env {
	/** Токен Telegram-бота. Задаётся секретом: `wrangler secret put BOT_TOKEN`. */
	BOT_TOKEN: string;
	/**
	 * Секрет проверки заголовка вебхука Telegram
	 * (`X-Telegram-Bot-Api-Secret-Token`). **Обязателен для работы вебхука**
	 * (fail-closed: без него POST-запросы отклоняются с 500).
	 * Задаётся: `wrangler secret put WEBHOOK_SECRET` + передаётся в setWebhook.
	 */
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

	// ── Необязательные переменные (vars) с фолбэком на текущие адреса ──────────
	// Дефолты см. в wrangler.jsonc; деплой без этих переменных ничего не ломает.

	/** Корень raw-контента book-club-data (raw.githubusercontent.com/...). */
	RAW_ROOT?: string;
	/** Репозиторий презентаций book-club-talks (GitHub). */
	TALKS_REPO?: string;
	/** Адрес мини-приложения клуба (кнопка меню бота). */
	MINIAPP_URL?: string;
	/** Страница модерации заявок в CMS; её origin — разрешённый CORS для /api/admin/*. */
	CMS_CLAIMS_URL?: string;
}
