// D1: заявки спикеров, записи на встречи, шаги диалога, флаги напоминаний.
// Оперативное состояние клуба живёт здесь (мгновенность и атомарность),
// контент — в git (book-club-data).

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
];

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
