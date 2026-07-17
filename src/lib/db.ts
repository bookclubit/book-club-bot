// D1: брони тем докладов и записи на встречи. Оперативное состояние клуба
// живёт здесь (мгновенность и атомарность), контент — в git (book-club-data).

/** Заявка на доклад. topic_id = null — «своя тема» вне программы главы. */
export interface Claim {
	id: number;
	event_id: string;
	topic_id: string | null;
	topic_title: string;
	chat_id: number;
	username: string | null;
	status: "pending" | "confirmed";
	created_at: number;
}

// Схема создаётся лениво один раз на изолят: для клуба <100 человек это
// проще и надёжнее, чем отдельная инфраструктура миграций.
let schemaReady = false;

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS claims (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		event_id TEXT NOT NULL,
		topic_id TEXT,
		topic_title TEXT NOT NULL,
		chat_id INTEGER NOT NULL,
		username TEXT,
		status TEXT NOT NULL DEFAULT 'pending',
		created_at INTEGER NOT NULL
	)`,
	// Одна тема программы — один докладчик (частичный индекс: свои темы не ограничены).
	`CREATE UNIQUE INDEX IF NOT EXISTS claims_slot
		ON claims(event_id, topic_id) WHERE topic_id IS NOT NULL`,
	`CREATE TABLE IF NOT EXISTS registrations (
		event_id TEXT NOT NULL,
		chat_id INTEGER NOT NULL,
		username TEXT,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (event_id, chat_id)
	)`,
	// Ожидание текста «своей темы» от пользователя (шаг диалога).
	`CREATE TABLE IF NOT EXISTS pending_topics (
		chat_id INTEGER PRIMARY KEY,
		event_id TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`,
];

export async function ensureSchema(db: D1Database): Promise<void> {
	if (schemaReady) return;
	for (const sql of SCHEMA) {
		await db.prepare(sql).run();
	}
	schemaReady = true;
}

// ── Заявки на доклады ────────────────────────────────────────────────────────

export async function listClaims(db: D1Database, eventId: string): Promise<Claim[]> {
	await ensureSchema(db);
	const { results } = await db
		.prepare("SELECT * FROM claims WHERE event_id = ?")
		.bind(eventId)
		.all<Claim>();
	return results;
}

/** Создаёт заявку. null — слот уже занят (нарушение уникального индекса). */
export async function createClaim(
	db: D1Database,
	claim: {
		eventId: string;
		topicId: string | null;
		topicTitle: string;
		chatId: number;
		username?: string;
	},
): Promise<Claim | null> {
	await ensureSchema(db);
	try {
		const row = await db
			.prepare(
				`INSERT INTO claims (event_id, topic_id, topic_title, chat_id, username, status, created_at)
				 VALUES (?, ?, ?, ?, ?, 'pending', ?) RETURNING *`,
			)
			.bind(
				claim.eventId,
				claim.topicId,
				claim.topicTitle,
				claim.chatId,
				claim.username ?? null,
				Date.now(),
			)
			.first<Claim>();
		return row;
	} catch (err) {
		if (String(err).includes("UNIQUE")) return null;
		throw err;
	}
}

export async function getClaim(db: D1Database, id: number): Promise<Claim | null> {
	await ensureSchema(db);
	return db.prepare("SELECT * FROM claims WHERE id = ?").bind(id).first<Claim>();
}

export async function confirmClaim(db: D1Database, id: number): Promise<void> {
	await ensureSchema(db);
	await db.prepare("UPDATE claims SET status = 'confirmed' WHERE id = ?").bind(id).run();
}

/** Удаляет заявку (отклонение админом) — слот снова свободен. */
export async function deleteClaim(db: D1Database, id: number): Promise<void> {
	await ensureSchema(db);
	await db.prepare("DELETE FROM claims WHERE id = ?").bind(id).run();
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

// ── Шаг диалога «своя тема» ──────────────────────────────────────────────────

export async function setPendingTopic(db: D1Database, chatId: number, eventId: string): Promise<void> {
	await ensureSchema(db);
	await db
		.prepare(
			`INSERT INTO pending_topics (chat_id, event_id, created_at) VALUES (?, ?, ?)
			 ON CONFLICT(chat_id) DO UPDATE SET event_id = excluded.event_id, created_at = excluded.created_at`,
		)
		.bind(chatId, eventId, Date.now())
		.run();
}

/** Забирает (и удаляет) ожидание темы для чата. null — бот текста не ждал. */
export async function popPendingTopic(db: D1Database, chatId: number): Promise<string | null> {
	await ensureSchema(db);
	const row = await db
		.prepare("DELETE FROM pending_topics WHERE chat_id = ? RETURNING event_id")
		.bind(chatId)
		.first<{ event_id: string }>();
	return row?.event_id ?? null;
}
