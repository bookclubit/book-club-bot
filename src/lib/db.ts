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
	/** id каталожного спикера (book-club-data), если заявитель узнан. */
	speaker_id: string | null;
	/** Ссылка на презентацию доклада (talks). */
	slides_url: string | null;
	status: "pending" | "confirmed";
	created_at: number;
}

/**
 * Заявка на участие в клубе. Без одобренной заявки (или профиля в каталоге)
 * темы докладов выбрать нельзя — новый человек сначала знакомится с клубом.
 */
export interface MembershipRequest {
	id: number;
	/** Telegram id = chat_id в личке = id аккаунта платформы. */
	chat_id: number;
	username: string | null;
	full_name: string | null;
	/** Сообщение от заявителя: о себе и о чём хочет рассказать. */
	about: string | null;
	/** Фото, присланное боту. */
	photo_file_id: string | null;
	/** Аватар Telegram (приходит со входом в miniapp). */
	photo_url: string | null;
	source: "bot" | "miniapp";
	status: "pending" | "approved" | "declined";
	created_at: number;
	decided_at: number | null;
}

/**
 * Шаг диалога заявки на участие: имя → о себе → фото. Черновик живёт
 * в `data` (JSON) — незаконченная заявка не попадает к админу.
 */
export interface SpeakerDialog {
	chat_id: number;
	step: "apply_name" | "apply_about" | "apply_photo";
	claim_id: number | null;
	data: string | null;
	updated_at: number;
}

// Схема создаётся лениво один раз на изолят: для клуба <100 человек это
// проще и надёжнее, чем отдельная инфраструктура миграций.
let schemaReady = false;

/**
 * Сбрасывает кэш «схема уже создана». Нужен только тестам: vitest-pool-workers
 * изолирует хранилище D1 между тестами, а состояние модуля — нет.
 */
export function resetSchemaCacheForTests(): void {
	schemaReady = false;
}

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
		speaker_id TEXT,
			slides_url TEXT,
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
		data TEXT,
		updated_at INTEGER NOT NULL
	)`,
	// Заявки на участие в клубе (из бота и из miniapp). Одна активная заявка
	// на человека: повторная отправка обновляет её, а не копит дубли у админа.
	`CREATE TABLE IF NOT EXISTS membership_requests (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		chat_id INTEGER NOT NULL UNIQUE,
		username TEXT,
		full_name TEXT,
		about TEXT,
		photo_file_id TEXT,
		photo_url TEXT,
		source TEXT NOT NULL DEFAULT 'bot',
		status TEXT NOT NULL DEFAULT 'pending',
		created_at INTEGER NOT NULL,
		decided_at INTEGER
	)`,
	// Устойчивая личность спикера: chat_id → имя/фото/каталожный id. Пишется при
	// узнавании и знакомстве, НЕ удаляется при отклонении темы (в отличие от
	// speaker_claims) — чтобы бот не «забывал» вернувшегося спикера.
	`CREATE TABLE IF NOT EXISTS speaker_identity (
		chat_id INTEGER PRIMARY KEY,
		speaker_id TEXT,
		full_name TEXT,
		photo_file_id TEXT,
		username TEXT,
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
	// План постов о встрече в группу клуба: анонс, афиша в день встречи и
	// напоминание за 5 минут. Поля встречи храним снимком (event JSON), потому
	// что в момент анонса встречи ещё нет в book-club-data — она в открытом PR.
	`CREATE TABLE IF NOT EXISTS announcements (
		event_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		chat_id INTEGER NOT NULL,
		run_at INTEGER NOT NULL,
		event TEXT NOT NULL,
		poster_file_id TEXT,
		message_id INTEGER,
		sent_at INTEGER,
		PRIMARY KEY (event_id, kind)
	)`,
	// Настройки бота, задаваемые из чата (например чат для анонсов).
	`CREATE TABLE IF NOT EXISTS bot_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
];

/** Композитный ключ прогресса карточки (уникален по всем книгам). */
export const cardKey = (book: string, cardId: string): string => `${book}:${cardId}`;

// Мягкие миграции для уже существующих таблиц: добавляем столбец, только если
// его ещё нет (проверка через PRAGMA table_info, а не по тексту ошибки ALTER).
const MIGRATIONS: { table: string; column: string; sql: string }[] = [
	{
		table: "speaker_claims",
		column: "speaker_id",
		sql: "ALTER TABLE speaker_claims ADD COLUMN speaker_id TEXT",
	},
	{
		table: "speaker_claims",
		column: "slides_url",
		sql: "ALTER TABLE speaker_claims ADD COLUMN slides_url TEXT",
	},
	{
		table: "speaker_dialog",
		column: "data",
		sql: "ALTER TABLE speaker_dialog ADD COLUMN data TEXT",
	},
];

/** Имена столбцов таблицы (PRAGMA table_info). */
async function tableColumns(db: D1Database, table: string): Promise<Set<string>> {
	const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
	return new Set(results.map((r) => r.name));
}

export async function ensureSchema(db: D1Database): Promise<void> {
	if (schemaReady) return;
	for (const sql of SCHEMA) {
		await db.prepare(sql).run();
	}
	const columnsByTable = new Map<string, Set<string>>();
	for (const m of MIGRATIONS) {
		let columns = columnsByTable.get(m.table);
		if (!columns) {
			columns = await tableColumns(db, m.table);
			columnsByTable.set(m.table, columns);
		}
		if (!columns.has(m.column)) {
			await db.prepare(m.sql).run();
			columns.add(m.column);
		}
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

/** Заявка по теме (topic_id уникален среди тем плана). */
export async function getClaimByTopic(db: D1Database, topicId: string): Promise<SpeakerClaim | null> {
	await ensureSchema(db);
	return db.prepare("SELECT * FROM speaker_claims WHERE topic_id = ?").bind(topicId).first<SpeakerClaim>();
}

/**
 * Запоминает личность спикера (устойчиво, переживает удаление заявок).
 * COALESCE — не затираем уже известное имя/фото/id, если в этот раз их нет.
 */
export async function saveSpeakerIdentity(
	db: D1Database,
	identity: {
		chatId: number;
		fullName?: string | null;
		photoFileId?: string | null;
		speakerId?: string | null;
		username?: string | null;
	},
): Promise<void> {
	if (!identity.chatId) return; // chat_id=0 — заявка не от Telegram (назначена в CMS).
	await ensureSchema(db);
	await db
		.prepare(
			`INSERT INTO speaker_identity (chat_id, speaker_id, full_name, photo_file_id, username, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(chat_id) DO UPDATE SET
				speaker_id = COALESCE(excluded.speaker_id, speaker_identity.speaker_id),
				full_name = COALESCE(excluded.full_name, speaker_identity.full_name),
				photo_file_id = COALESCE(excluded.photo_file_id, speaker_identity.photo_file_id),
				username = COALESCE(excluded.username, speaker_identity.username),
				updated_at = excluded.updated_at`,
		)
		.bind(
			identity.chatId,
			identity.speakerId ?? null,
			identity.fullName ?? null,
			identity.photoFileId ?? null,
			identity.username ?? null,
			Date.now(),
		)
		.run();
}

/**
 * Профиль вернувшегося спикера (имя, фото, id). Источник — устойчивая
 * таблица speaker_identity; фолбэк на прошлые заявки (легаси до её появления).
 */
export async function getSpeakerProfile(
	db: D1Database,
	chatId: number,
): Promise<{ fullName: string; photoFileId: string | null; speakerId: string | null } | null> {
	await ensureSchema(db);
	const id = await db
		.prepare(
			`SELECT full_name, photo_file_id, speaker_id FROM speaker_identity
			 WHERE chat_id = ? AND full_name IS NOT NULL AND full_name != ''`,
		)
		.bind(chatId)
		.first<{ full_name: string; photo_file_id: string | null; speaker_id: string | null }>();
	const row =
		id ??
		(await db
			.prepare(
				`SELECT full_name, photo_file_id, speaker_id FROM speaker_claims
				 WHERE chat_id = ? AND full_name IS NOT NULL AND full_name != ''
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.bind(chatId)
			.first<{ full_name: string; photo_file_id: string | null; speaker_id: string | null }>());
	if (!row) return null;
	return { fullName: row.full_name, photoFileId: row.photo_file_id, speakerId: row.speaker_id };
}

export async function updateSpeakerClaim(
	db: D1Database,
	id: number,
	fields: { fullName?: string; photoFileId?: string; speakerId?: string; status?: "pending" | "confirmed" },
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
	if (fields.speakerId !== undefined) {
		await db.prepare("UPDATE speaker_claims SET speaker_id = ? WHERE id = ?").bind(fields.speakerId, id).run();
	}
	if (fields.status !== undefined) {
		await db.prepare("UPDATE speaker_claims SET status = ? WHERE id = ?").bind(fields.status, id).run();
	}
}

/**
 * Админ назначает спикера на тему из CMS — создаёт/заменяет подтверждённую
 * заявку в D1 (единый источник занятости). chat_id=0: заявка не от Telegram.
 */
export async function assignClaim(
	db: D1Database,
	claim: {
		topicId: string;
		topicTitle: string;
		bookId: string;
		chapter: string;
		speakerId: string;
		speakerName: string;
	},
): Promise<void> {
	await ensureSchema(db);
	// Тема уникальна (частичный индекс по topic_id) — сначала освобождаем.
	await db.prepare("DELETE FROM speaker_claims WHERE topic_id = ?").bind(claim.topicId).run();
	await db
		.prepare(
			`INSERT INTO speaker_claims
				(topic_id, topic_title, book_id, chapter, chat_id, full_name, speaker_id, status, created_at)
			 VALUES (?, ?, ?, ?, 0, ?, ?, 'confirmed', ?)`,
		)
		.bind(
			claim.topicId,
			claim.topicTitle,
			claim.bookId,
			claim.chapter,
			claim.speakerName,
			claim.speakerId,
			Date.now(),
		)
		.run();
}

/** Освобождает тему — удаляет заявку по topic_id (единый рычаг для CMS/бота). */
export async function releaseClaimByTopic(db: D1Database, topicId: string): Promise<void> {
	await ensureSchema(db);
	await db.prepare("DELETE FROM speaker_claims WHERE topic_id = ?").bind(topicId).run();
}

/** Проставляет ссылку на презентацию у заявки темы. */
export async function setClaimSlides(db: D1Database, topicId: string, slidesUrl: string): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare("UPDATE speaker_claims SET slides_url = ? WHERE topic_id = ?")
		.bind(slidesUrl, topicId)
		.run();
}

/** Удаляет заявку (отклонение) — тема снова свободна. */
export async function deleteSpeakerClaim(db: D1Database, id: number): Promise<void> {
	await ensureSchema(db);
	await db.prepare("DELETE FROM speaker_claims WHERE id = ?").bind(id).run();
}

// ── Заявки на участие в клубе ────────────────────────────────────────────────

/**
 * Создаёт заявку на участие или обновляет свою же (одна на человека).
 * Уже принятого участника повторная отправка не сбрасывает в «на модерации»:
 * иначе случайный повтор лишил бы его доступа к темам.
 */
export async function saveMembershipRequest(
	db: D1Database,
	req: {
		chatId: number;
		username?: string | null;
		fullName?: string | null;
		about?: string | null;
		photoFileId?: string | null;
		photoUrl?: string | null;
		source: MembershipRequest["source"];
	},
): Promise<MembershipRequest | null> {
	await ensureSchema(db);
	return db
		.prepare(
			`INSERT INTO membership_requests
				(chat_id, username, full_name, about, photo_file_id, photo_url, source, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
			 ON CONFLICT(chat_id) DO UPDATE SET
				username = COALESCE(excluded.username, membership_requests.username),
				full_name = COALESCE(excluded.full_name, membership_requests.full_name),
				about = COALESCE(excluded.about, membership_requests.about),
				photo_file_id = COALESCE(excluded.photo_file_id, membership_requests.photo_file_id),
				photo_url = COALESCE(excluded.photo_url, membership_requests.photo_url),
				source = excluded.source,
				status = CASE WHEN membership_requests.status = 'approved' THEN 'approved' ELSE 'pending' END,
				created_at = excluded.created_at,
				decided_at = CASE WHEN membership_requests.status = 'approved'
					THEN membership_requests.decided_at ELSE NULL END
			 RETURNING *`,
		)
		.bind(
			req.chatId,
			req.username ?? null,
			req.fullName ?? null,
			req.about ?? null,
			req.photoFileId ?? null,
			req.photoUrl ?? null,
			req.source,
			Date.now(),
		)
		.first<MembershipRequest>();
}

export async function getMembershipRequest(
	db: D1Database,
	chatId: number,
): Promise<MembershipRequest | null> {
	await ensureSchema(db);
	return db
		.prepare("SELECT * FROM membership_requests WHERE chat_id = ?")
		.bind(chatId)
		.first<MembershipRequest>();
}

export async function getMembershipRequestById(
	db: D1Database,
	id: number,
): Promise<MembershipRequest | null> {
	await ensureSchema(db);
	return db.prepare("SELECT * FROM membership_requests WHERE id = ?").bind(id).first<MembershipRequest>();
}

/** Все заявки на участие: сначала ждущие решения, внутри — свежие сверху. */
export async function listMembershipRequests(db: D1Database): Promise<MembershipRequest[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(
			`SELECT * FROM membership_requests
			 ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC`,
		)
		.all<MembershipRequest>();
	return results ?? [];
}

/** Решение админа по заявке на участие. null — заявки уже нет. */
export async function setMembershipStatus(
	db: D1Database,
	id: number,
	status: MembershipRequest["status"],
): Promise<MembershipRequest | null> {
	await ensureSchema(db);
	return db
		.prepare("UPDATE membership_requests SET status = ?, decided_at = ? WHERE id = ? RETURNING *")
		.bind(status, Date.now(), id)
		.first<MembershipRequest>();
}

// ── Диалог заявки ────────────────────────────────────────────────────────────

export async function setDialog(
	db: D1Database,
	chatId: number,
	step: SpeakerDialog["step"],
	claimId: number | null,
	data?: Record<string, string> | null,
): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare(
			`INSERT INTO speaker_dialog (chat_id, step, claim_id, data, updated_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(chat_id) DO UPDATE SET step = excluded.step,
				claim_id = excluded.claim_id, data = excluded.data, updated_at = excluded.updated_at`,
		)
		.bind(chatId, step, claimId, data ? JSON.stringify(data) : null, Date.now())
		.run();
}

/** Черновик заявки из диалога (шаги имя → о себе → фото). */
export function dialogDraft(dialog: SpeakerDialog | null): Record<string, string> {
	if (!dialog?.data) return {};
	try {
		const parsed = JSON.parse(dialog.data) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
	} catch {
		return {};
	}
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

/** true — напоминание уже отправлялось (только проверка, без пометки). */
export async function wasReminderSent(
	db: D1Database,
	eventId: string,
	kind: "morning" | "hour" | "start",
): Promise<boolean> {
	await ensureSchema(db);
	const row = await db
		.prepare("SELECT 1 FROM reminders_sent WHERE event_id = ? AND kind = ?")
		.bind(eventId, kind)
		.first();
	return row !== null;
}

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

// ── Анонсы встреч в группу клуба ─────────────────────────────────────────────

export interface AnnouncementRow {
	event_id: string;
	kind: string;
	chat_id: number;
	run_at: number;
	event: string;
	poster_file_id: string | null;
	message_id: number | null;
	sent_at: number | null;
}

/**
 * Планирует пост (или перезаписывает план, если встречу правят). Уже
 * опубликованные посты не трогаем: sent_at сохраняется, повторной отправки
 * не будет.
 */
export async function planAnnouncement(
	db: D1Database,
	row: {
		eventId: string;
		kind: string;
		chatId: number;
		runAt: number;
		event: string;
		posterFileId?: string | null;
	},
): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare(
			`INSERT INTO announcements (event_id, kind, chat_id, run_at, event, poster_file_id)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(event_id, kind) DO UPDATE SET
				chat_id = excluded.chat_id,
				run_at = CASE WHEN announcements.sent_at IS NULL THEN excluded.run_at ELSE announcements.run_at END,
				event = excluded.event,
				poster_file_id = COALESCE(excluded.poster_file_id, announcements.poster_file_id)`,
		)
		.bind(row.eventId, row.kind, row.chatId, row.runAt, row.event, row.posterFileId ?? null)
		.run();
}

/** Посты, которым пора выходить: время наступило, отправки ещё не было. */
export async function listDueAnnouncements(
	db: D1Database,
	now: number,
): Promise<AnnouncementRow[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare(
			`SELECT * FROM announcements
			 WHERE sent_at IS NULL AND run_at <= ?
			 ORDER BY run_at`,
		)
		.bind(now)
		.all<AnnouncementRow>();
	return results ?? [];
}

/**
 * Отмечает пост отправленным. Возвращает false, если его уже отметил
 * параллельный запуск cron — тогда второй раз не публикуем.
 */
export async function markAnnouncementSent(
	db: D1Database,
	eventId: string,
	kind: string,
	messageId: number | null,
	sentAt = Date.now(),
): Promise<boolean> {
	await ensureSchema(db);
	const result = await db
		.prepare(
			`UPDATE announcements SET sent_at = ?, message_id = ?
			 WHERE event_id = ? AND kind = ? AND sent_at IS NULL`,
		)
		.bind(sentAt, messageId, eventId, kind)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

/** Афиша, загруженная для другого поста этой встречи (file_id переиспользуем). */
export async function findPosterFileId(
	db: D1Database,
	eventId: string,
	kind: string,
): Promise<string | null> {
	await ensureSchema(db);
	const row = await db
		.prepare("SELECT poster_file_id FROM announcements WHERE event_id = ? AND kind = ?")
		.bind(eventId, kind)
		.first<{ poster_file_id: string | null }>();
	return row?.poster_file_id ?? null;
}

export async function setPosterFileId(
	db: D1Database,
	eventId: string,
	kind: string,
	fileId: string,
): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare("UPDATE announcements SET poster_file_id = ? WHERE event_id = ? AND kind = ?")
		.bind(fileId, eventId, kind)
		.run();
}

// ── Настройки бота (задаются командами в чате) ───────────────────────────────

export async function getBotSetting(db: D1Database, key: string): Promise<string | null> {
	await ensureSchema(db);
	const row = await db
		.prepare("SELECT value FROM bot_settings WHERE key = ?")
		.bind(key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

export async function setBotSetting(db: D1Database, key: string, value: string): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare(
			`INSERT INTO bot_settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.bind(key, value, Date.now())
		.run();
}

/** Чат для анонсов встреч (ставится командой /anons_here в группе клуба). */
export const ANNOUNCE_CHAT_KEY = "announce_chat_id";

export async function getAnnounceChatId(db: D1Database): Promise<number | null> {
	const raw = await getBotSetting(db, ANNOUNCE_CHAT_KEY);
	const id = Number(raw);
	return raw !== null && Number.isFinite(id) ? id : null;
}

/** Строка плана публикации (или null, если такого поста не планировали). */
export async function getAnnouncement(
	db: D1Database,
	eventId: string,
	kind: string,
): Promise<AnnouncementRow | null> {
	await ensureSchema(db);
	return db
		.prepare("SELECT * FROM announcements WHERE event_id = ? AND kind = ?")
		.bind(eventId, kind)
		.first<AnnouncementRow>();
}
