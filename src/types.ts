// Общие типы бота «Книжного клуба».

// ── Данные книг ────────────────────────────────────────────────────────────

interface FlashcardBase {
	id: string;
	chapter: string;
	difficulty: "easy" | "medium" | "hard";
	/** Пример к ответу — необязателен: приходит под ответом отдельным блоком. */
	example?: string;
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

/**
 * Блок программы эфира: глава книги и темы из неё. Пустой `topic_ids` —
 * вся глава. Блоков может быть несколько: на одном стриме разбирают
 * несколько глав или даже книг.
 */
export interface ProgramBlock {
	book_id: string;
	chapter: string;
	topic_ids?: string[];
}

/** «Доклады» — чистовая запись докладов (стримы, без Meet). */
export interface LiveTalkEvent extends EventBase {
	type: "live-talk";
	talks: { title: string; speaker: string; speaker_id?: string; topic_id?: string }[];
	/**
	 * Программа эфира блоками. Старые встречи её не имеют — там книга и глава
	 * лежат прямо в событии (`book_id`/`chapter`/`topic_ids`), и это тот же
	 * единственный блок: разбирать оба вида должен `eventProgram()`.
	 */
	program?: ProgramBlock[];
	book_id?: string;
	chapter?: string;
	topic_ids?: string[];
}

export type ClubEvent = ClosedChapterEvent | LiveTalkEvent;

/**
 * Пост о встрече в группу клуба: анонс сразу после создания встречи, афиша
 * в день встречи (10:00 МСК) и напоминание за 5 минут до начала.
 */
export type AnnounceKind = "announce" | "day" | "soon";

/** Тема главы (объект внутри chapter.json) — бот берёт только id и название. */
export interface TopicRef {
	id: string;
	title: string;
}

/** Мета книги (meta.json) — для постов о встрече нужны название, авторы, ссылка. */
export interface BookMeta {
	id: string;
	title: string;
	authors?: { name: string }[];
	url?: string;
}

/** Глава (chapter.json) — бот использует только список тем. */
export interface Chapter {
	order: number;
	title: string;
	topics: TopicRef[];
}

/** Единый реестр контента (index.json в корне book-club-data). */
export interface ContentIndex {
	version: number;
	active_book: string;
	books: {
		folder: string;
		id: string;
		title: string;
		status?: string;
		/** Все главы книги: slug, порядок, название и число тем. */
		chapters: { slug: string; order: number; title: string; topics: number }[];
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
	last_name?: string;
	username?: string;
}

export interface TelegramChat {
	id: number;
	type: string;
	first_name?: string;
	username?: string;
	/** Название группы или канала (в личке отсутствует). */
	title?: string;
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
