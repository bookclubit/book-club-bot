// Общие типы бота «Книжного клуба».

// ── Данные книг ────────────────────────────────────────────────────────────

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

/** Карточка с привязкой к книге (папке) — для колоды по всем книгам клуба. */
export interface DeckCard {
	book: string; // имя папки книги в book-club-data
	card: Flashcard;
}

// ── События клуба и реестр контента ─────────────────────────────────────────

/** Доп. материал встречи. */
export interface EventMaterial {
	title: string;
	url: string;
}

interface EventBase {
	id: string;
	title: string;
	/** YYYY-MM-DD */
	date: string;
	/** HH:MM */
	time: string;
	timezone: string;
	/** Ссылка на созвон (Google Meet) — только у открытых обсуждений. */
	call_url?: string;
	/** Трансляции YouTube/VK — есть у обоих типов встреч. */
	streams?: { youtube?: string; vk?: string };
	materials?: EventMaterial[];
	/** Админ отметил встречу завершённой — напоминания больше не шлём. */
	finished?: boolean;
}

/** «Открытое обсуждение» — разбор главы, прийти может любой (стримы + Meet). */
export interface ClosedChapterEvent extends EventBase {
	type: "closed-chapter";
	book_id: string;
	chapter: string;
	pages?: { from: number; to: number };
	notes_board_url?: string;
}

/** «Доклады» — чистовая запись докладов (стримы, без Meet). */
export interface LiveTalkEvent extends EventBase {
	type: "live-talk";
	talks: { title: string; speaker: string; speaker_id?: string; topic_id?: string }[];
	/** Книга и глава программы докладов. */
	book_id?: string;
	chapter?: string;
}

export type ClubEvent = ClosedChapterEvent | LiveTalkEvent;

/** Ссылка на тему в chapter.json. */
export interface TopicRef {
	id: string;
	title: string;
	file: string;
}

/** Индекс главы (chapter.json) — бот использует только список тем. */
export interface Chapter {
	order: number;
	title: string;
	topics: TopicRef[];
}

/** Единый реестр контента (index.json в корне book-club-data). */
export interface ContentIndex {
	version: 1;
	active_book: string;
	books: {
		folder: string;
		id: string;
		title: string;
		status?: string;
		chapters: string[];
	}[];
	events: string[];
	speakers?: {
		id: string;
		name: string;
		avatar?: string;
		aliases?: string[];
		socials?: Partial<Record<"telegram" | "github" | "linkedin" | "website", string>>;
	}[];
}

// ── Хранилище (KV) ───────────────────────────────────────────────────────────

/** Подписчик на ежедневную рассылку. Ключ KV: `sub:<chatId>`. */
export interface Subscriber {
	chatId: number;
	firstName?: string;
	username?: string;
	/** Время подписки, epoch ms. */
	subscribedAt: number;
}

/**
 * Прогресс по карточке (SM-2). Хранится в D1 (таблица `card_progress`,
 * см. lib/db.ts); cardId — композитный ключ «<book>:<cardId>».
 */
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
	/** Варианты размеров присланного фото (берём последний — самый крупный). */
	photo?: { file_id: string }[];
}

export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: TelegramMessage;
	data?: string;
}

/**
 * Изменение статуса бота в чате (my_chat_member): по нему узнаём,
 * что пользователь заблокировал бота (status = kicked/banned).
 */
export interface TelegramChatMemberUpdated {
	chat: TelegramChat;
	from?: TelegramUser;
	new_chat_member: { status: string };
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
	my_chat_member?: TelegramChatMemberUpdated;
}

// ── Разметка кнопок ──────────────────────────────────────────────────────────

export interface InlineKeyboardButton {
	text: string;
	callback_data: string;
}

export interface InlineKeyboardMarkup {
	inline_keyboard: InlineKeyboardButton[][];
}
