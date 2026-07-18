// D1: заявки спикеров, записи на встречи, шаги диалога, флаги напоминаний,
// аккаунты платформы и единый прогресс карточек (SM-2) — общий для бота и сайта.
// Оперативное состояние клуба живёт здесь (мгновенность и атомарность),
// контент — в git (book-club-data).

import type { CardProgress } from "../types";

/** Аккаунт платформы = пользователь Telegram (id = chat_id в личке). */
export interface DbUser {
	id: number;
	username: string | null;
	first_name: string | null;
	last_name: string | null;
	photo_url: string | null;
	created_at: number;
	updated_at: number;
}

/** Заявка на доклад. topic_id = null — «своя тема» вне плана. */
export interface SpeakerClaim {
	id: number;
	topic_id: string | null;
	topic_title: string;
	book_id: string | null;
	chapter: string | null;
	chat_id: number;
	username: string | null;
	full_name: string | null;
	photo_file_id: string | null;
	status: "pending" | "confirmed";
	created_at: number;
}

/** Шаг диалога заявки: ждём текст своей темы, ФИО или фото. */
export interface SpeakerDialog {
	chat_id: number;
	step: "custom_topic" | "name" | "photo";
	claim_id: number | null;
	updated_at: number;
}

// Схема создаётся лениво один раз на изолят: для клуба <100 человек это
// проще и надёжнее, чем отдельная инфраструктура миграций.
let schemaReady = false;

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS speaker_claims (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		topic_id TEXT,
		topic_title TEXT NOT NULL,
		book_id TEXT,
		chapter TEXT,
		chat_id INTEGER NOT NULL,
		username TEXT,
		full_name TEXT,
		photo_file_id TEXT,
		status TEXT NOT NULL DEFAULT 'pending',
		created_at INTEGER NOT NULL
	)`,
	// Одна тема плана — один докладчик (частичный индекс: свои темы не ограничены).
	`CREATE UNIQUE INDEX IF NOT EXISTS speaker_claims_topic
		ON speaker_claims(topic_id) WHERE topic_id IS NOT NULL`,
	`CREATE TABLE IF NOT EXISTS speaker_dialog (
		chat_id INTEGER PRIMARY KEY,
		step TEXT NOT NULL,
		claim_id INTEGER,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS registrations (
		event_id TEXT NOT NULL,
		chat_id INTEGER NOT NULL,
		username TEXT,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (event_id, chat_id)
	)`,
	// Какие напоминания по событию уже отправлены (morning | hour | start).
	`CREATE TABLE IF NOT EXISTS reminders_sent (
		event_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		PRIMARY KEY (event_id, kind)
	)`,
	// Аккаунты платформы (Telegram-пользователи).
	`CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY,
		username TEXT,
		first_name TEXT,
		last_name TEXT,
		photo_url TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	// Единый прогресс карточек (SM-2): общий для бота и сайта, ключ — Telegram id.
	// card_id — композитный «<book>:<cardId>» (карточки по всем книгам клуба).
	`CREATE TABLE IF NOT EXISTS card_progress (
		user_id INTEGER NOT NULL,
		card_id TEXT NOT NULL,
		book_id TEXT,
		repetition INTEGER NOT NULL,
		interval INTEGER NOT NULL,
		easiness REAL NOT NULL,
		due_date INTEGER NOT NULL,
		last_reviewed INTEGER NOT NULL,
		PRIMARY KEY (user_id, card_id)
	)`,
	// Настройки пользователя (сколько карточек в день и т.п.).
	`CREATE TABLE IF NOT EXISTS user_settings (
		user_id INTEGER PRIMARY KEY,
		daily_cards INTEGER NOT NULL DEFAULT 5,
		updated_at INTEGER NOT NULL
	)`,
	// Активная сессия повторения в боте (карточки по одной): очередь оставшихся.
	`CREATE TABLE IF NOT EXISTS study_session (
		user_id INTEGER PRIMARY KEY,
		queue TEXT NOT NULL,
		reviewed INTEGER NOT NULL DEFAULT 0,
		updated_at INTEGER NOT NULL
	)`,
];

/** Композитный ключ прогресса карточки (уникален по всем книгам). */
export const cardKey = (book: string, cardId: string): string => `${book}:${cardId}`;

export async function ensureSchema(db: D1Database): Promise<void> {
	if (schemaReady) return;
	for (const sql of SCHEMA) {
		await db.prepare(sql).run();
	}
	schemaReady = true;
}

// ── Заявки спикеров ──────────────────────────────────────────────────────────

export async function listSpeakerClaims(db: D1Database): Promise<SpeakerClaim[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare("SELECT * FROM speaker_claims ORDER BY created_at DESC")
		.all<SpeakerClaim>();
	return results;
}

/** Создаёт заявку. null — тема уже занята (нарушение уникального индекса). */
export async function createSpeakerClaim(
	db: D1Database,
	claim: {
		topicId: string | null;
		topicTitle: string;
		bookId?: string;
		chapter?: string;
		chatId: number;
		username?: string;
	},
): Promise<SpeakerClaim | null> {
	await ensureSchema(db);
	try {
		const row = await db
			.prepare(
				`INSERT INTO speaker_claims
					(topic_id, topic_title, book_id, chapter, chat_id, username, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING *`,
			)
			.bind(
				claim.topicId,
				claim.topicTitle,
				claim.bookId ?? null,
				claim.chapter ?? null,
				claim.chatId,
				claim.username ?? null,
				Date.now(),
			)
			.first<SpeakerClaim>();
		return row;
	} catch (err) {
		if (String(err).includes("UNIQUE")) return null;
		throw err;
	}
}

export async function getSpeakerClaim(db: D1Database, id: number): Promise<SpeakerClaim | null> {
	await ensureSchema(db);
	return db.prepare("SELECT * FROM speaker_claims WHERE id = ?").bind(id).first<SpeakerClaim>();
}

export async function updateSpeakerClaim(
	db: D1Database,
	id: number,
	fields: { fullName?: string; photoFileId?: string; status?: "pending" | "confirmed" },
): Promise<void> {
	await ensureSchema(db);
	if (fields.fullName !== undefined) {
		await db.prepare("UPDATE speaker_claims SET full_name = ? WHERE id = ?").bind(fields.fullName, id).run();
	}
	if (fields.photoFileId !== undefined) {
		await db
			.prepare("UPDATE speaker_claims SET photo_file_id = ? WHERE id = ?")
			.bind(fields.photoFileId, id)
			.run();
	}
	if (fields.status !== undefined) {
		await db.prepare("UPDATE speaker_claims SET status = ? WHERE id = ?").bind(fields.status, id).run();
	}
}

/** Удаляет заявку (отклонение) — тема снова свободна. */
export async function deleteSpeakerClaim(db: D1Database, id: number): Promise<void> {
	await ensureSchema(db);
	await db.prepare("DELETE FROM speaker_claims WHERE id = ?").bind(id).run();
}

// ── Диалог заявки ────────────────────────────────────────────────────────────

export async function setDialog(
	db: D1Database,
	chatId: number,
	step: SpeakerDialog["step"],
	claimId: number | null,
): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare(
			`INSERT INTO speaker_dialog (chat_id, step, claim_id, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(chat_id) DO UPDATE SET step = excluded.step,
				claim_id = excluded.claim_id, updated_at = excluded.updated_at`,
		)
		.bind(chatId, step, claimId, Date.now())
		.run();
}

export async function getDialog(db: D1Database, chatId: number): Promise<SpeakerDialog | null> {
	await ensureSchema(db);
	return db.prepare("SELECT * FROM speaker_dialog WHERE chat_id = ?").bind(chatId).first<SpeakerDialog>();
}

export async function clearDialog(db: D1Database, chatId: number): Promise<void> {
	await ensureSchema(db);
	await db.prepare("DELETE FROM speaker_dialog WHERE chat_id = ?").bind(chatId).run();
}

// ── Записи на встречи ────────────────────────────────────────────────────────

export async function addRegistration(
	db: D1Database,
	eventId: string,
	chatId: number,
	username?: string,
): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare(
			`INSERT INTO registrations (event_id, chat_id, username, created_at)
			 VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
		)
		.bind(eventId, chatId, username ?? null, Date.now())
		.run();
}

export async function listRegistrations(db: D1Database, eventId: string): Promise<number[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare("SELECT chat_id FROM registrations WHERE event_id = ?")
		.bind(eventId)
		.all<{ chat_id: number }>();
	return results.map((r) => r.chat_id);
}

// ── Флаги напоминаний ────────────────────────────────────────────────────────

/** true — напоминание ещё не отправлялось (и теперь помечено отправленным). */
export async function markReminderSent(
	db: D1Database,
	eventId: string,
	kind: "morning" | "hour" | "start",
): Promise<boolean> {
	await ensureSchema(db);
	const result = await db
		.prepare("INSERT INTO reminders_sent (event_id, kind) VALUES (?, ?) ON CONFLICT DO NOTHING")
		.bind(eventId, kind)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

// ── Аккаунты платформы ───────────────────────────────────────────────────────

/** Создаёт/обновляет пользователя (профиль из Telegram). */
export async function upsertUser(
	db: D1Database,
	user: {
		id: number;
		username?: string | null;
		firstName?: string | null;
		lastName?: string | null;
		photoUrl?: string | null;
	},
): Promise<void> {
	await ensureSchema(db);
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO users (id, username, first_name, last_name, photo_url, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				username = excluded.username,
				first_name = excluded.first_name,
				last_name = excluded.last_name,
				photo_url = excluded.photo_url,
				updated_at = excluded.updated_at`,
		)
		.bind(
			user.id,
			user.username ?? null,
			user.firstName ?? null,
			user.lastName ?? null,
			user.photoUrl ?? null,
			now,
			now,
		)
		.run();
}

export async function getUser(db: D1Database, id: number): Promise<DbUser | null> {
	await ensureSchema(db);
	return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<DbUser>();
}

// ── Единый прогресс карточек (SM-2) ──────────────────────────────────────────

interface CardProgressRow {
	card_id: string;
	repetition: number;
	interval: number;
	easiness: number;
	due_date: number;
	last_reviewed: number;
}

const rowToProgress = (r: CardProgressRow): CardProgress => ({
	cardId: r.card_id,
	repetition: r.repetition,
	interval: r.interval,
	easiness: r.easiness,
	dueDate: r.due_date,
	lastReviewed: r.last_reviewed,
});

export async function getCardProgress(
	db: D1Database,
	userId: number,
	cardId: string,
): Promise<CardProgress | null> {
	await ensureSchema(db);
	const row = await db
		.prepare("SELECT * FROM card_progress WHERE user_id = ? AND card_id = ?")
		.bind(userId, cardId)
		.first<CardProgressRow>();
	return row ? rowToProgress(row) : null;
}

/** Весь прогресс пользователя: map cardId → прогресс. */
export async function getCardProgressMap(
	db: D1Database,
	userId: number,
): Promise<Map<string, CardProgress>> {
	await ensureSchema(db);
	const { results } = await db
		.prepare("SELECT * FROM card_progress WHERE user_id = ?")
		.bind(userId)
		.all<CardProgressRow>();
	const map = new Map<string, CardProgress>();
	for (const r of results) map.set(r.card_id, rowToProgress(r));
	return map;
}

export async function saveCardProgress(
	db: D1Database,
	userId: number,
	bookId: string,
	progress: CardProgress,
): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare(
			`INSERT INTO card_progress
				(user_id, card_id, book_id, repetition, interval, easiness, due_date, last_reviewed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, card_id) DO UPDATE SET
				book_id = excluded.book_id,
				repetition = excluded.repetition,
				interval = excluded.interval,
				easiness = excluded.easiness,
				due_date = excluded.due_date,
				last_reviewed = excluded.last_reviewed`,
		)
		.bind(
			userId,
			progress.cardId,
			bookId,
			progress.repetition,
			progress.interval,
			progress.easiness,
			progress.dueDate,
			progress.lastReviewed,
		)
		.run();
}

// ── Настройки пользователя ───────────────────────────────────────────────────

export const DEFAULT_DAILY_CARDS = 5;
/** Допустимые значения «карточек в день» (кнопки настроек в боте и miniapp). */
export const DAILY_CARD_OPTIONS = [3, 5, 10, 15, 20];

/** Сколько карточек в день выдавать пользователю (по умолчанию 5). */
export async function getDailyCards(db: D1Database, userId: number): Promise<number> {
	await ensureSchema(db);
	const row = await db
		.prepare("SELECT daily_cards FROM user_settings WHERE user_id = ?")
		.bind(userId)
		.first<{ daily_cards: number }>();
	return row?.daily_cards ?? DEFAULT_DAILY_CARDS;
}

export async function setDailyCards(db: D1Database, userId: number, n: number): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare(
			`INSERT INTO user_settings (user_id, daily_cards, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET daily_cards = excluded.daily_cards,
				updated_at = excluded.updated_at`,
		)
		.bind(userId, n, Date.now())
		.run();
}

// ── Сессия повторения (карточки по одной, диалог) ────────────────────────────

/** Элемент очереди повторения: книга + id карточки. */
export interface SessionCard {
	b: string;
	c: string;
}

export interface StudySession {
	queue: SessionCard[];
	reviewed: number;
}

export async function saveSession(
	db: D1Database,
	userId: number,
	queue: SessionCard[],
	reviewed: number,
): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare(
			`INSERT INTO study_session (user_id, queue, reviewed, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET queue = excluded.queue,
				reviewed = excluded.reviewed, updated_at = excluded.updated_at`,
		)
		.bind(userId, JSON.stringify(queue), reviewed, Date.now())
		.run();
}

export async function getSession(db: D1Database, userId: number): Promise<StudySession | null> {
	await ensureSchema(db);
	const row = await db
		.prepare("SELECT queue, reviewed FROM study_session WHERE user_id = ?")
		.bind(userId)
		.first<{ queue: string; reviewed: number }>();
	if (!row) return null;
	try {
		return { queue: JSON.parse(row.queue) as SessionCard[], reviewed: row.reviewed };
	} catch {
		return null;
	}
}

export async function clearSession(db: D1Database, userId: number): Promise<void> {
	await ensureSchema(db);
	await db.prepare("DELETE FROM study_session WHERE user_id = ?").bind(userId).run();
}
