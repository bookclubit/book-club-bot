// Общие типы бота «Книжного клуба».

/** Идентификатор книги в репозитории book-club-data (папка books/<id>). */
export const BOOK_ID = "docker-up-and-running";

// ── Данные книг ────────────────────────────────────────────────────────────

/** Метаданные книги (meta.json). */
export interface BookMeta {
	id: string;
	title: string;
	title_original?: string;
	edition?: number;
	authors: { name: string; avatar?: string }[];
	status?: string;
	cover?: string;
	tags?: string[];
	description?: string;
	total_chapters?: number;
}

interface FlashcardBase {
	id: string;
	chapter: string;
	difficulty: "easy" | "medium" | "hard";
}

/** Карточка «вопрос — ответ». */
export interface QaCard extends FlashcardBase {
	type: "qa";
	question: string;
	answer: string;
}

/** Карточка «команда — что делает». */
export interface CommandCard extends FlashcardBase {
	type: "command";
	command: string;
	result: string;
}

export type Flashcard = QaCard | CommandCard;

// ── Хранилище (KV) ───────────────────────────────────────────────────────────

/** Подписчик на ежедневную рассылку. Ключ KV: `sub:<chatId>`. */
export interface Subscriber {
	chatId: number;
	firstName?: string;
	username?: string;
	/** Время подписки, epoch ms. */
	subscribedAt: number;
}

/** Прогресс по карточке (SM-2). Ключ KV: `progress:<chatId>:<cardId>`. */
export interface CardProgress {
	cardId: string;
	/** Число успешных повторений подряд. */
	repetition: number;
	/** Текущий интервал в днях. */
	interval: number;
	/** Коэффициент лёгкости (easiness factor), минимум 1.3. */
	easiness: number;
	/** Когда карточка снова подлежит повторению, epoch ms. */
	dueDate: number;
	/** Последнее повторение, epoch ms. */
	lastReviewed: number;
}

/** Оценка ответа пользователем. */
export type Grade = "again" | "hard" | "easy";

// ── Telegram (минимально необходимые поля) ──────────────────────────────────

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name?: string;
	username?: string;
}

export interface TelegramChat {
	id: number;
	type: string;
	first_name?: string;
	username?: string;
}

export interface TelegramMessage {
	message_id: number;
	from?: TelegramUser;
	chat: TelegramChat;
	text?: string;
}

export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: TelegramMessage;
	data?: string;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

// ── Разметка кнопок ──────────────────────────────────────────────────────────

export interface InlineKeyboardButton {
	text: string;
	callback_data: string;
}

export interface InlineKeyboardMarkup {
	inline_keyboard: InlineKeyboardButton[][];
}
