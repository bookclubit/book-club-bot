// Публикация постов о встрече в группу клуба. Рендер живёт в announce.ts,
// здесь — данные, отправка и план публикаций.
//
// Почему снимок встречи хранится в D1: анонс выходит сразу после нажатия
// «Создать pull request» в CMS, а в book-club-data встреча появится только
// после мержа. Всё остальное (книга, темы, спикеры) берётся свежим на момент
// каждого поста — поэтому дневная афиша уже знает подтверждённых спикеров.

import {
	buildTopics,
	CAPTION_LIMIT,
	renderAnnouncement,
	runAtFor,
	type AnnounceContext,
	type AnnounceEvent,
} from "./announce";
import { fetchBookMeta, fetchChapter, fetchIndex } from "./api";
import {
	getAnnounceChatId,
	getAnnouncement,
	listDueAnnouncements,
	listSpeakerClaims,
	markAnnouncementSent,
	planAnnouncement,
	setPosterFileId,
	type AnnouncementRow,
} from "./db";
import { sendPhotoByFileId, sendPhotoBytes, sendPost, type SentPost } from "./telegram";
import type { AnnounceKind } from "../types";

const KINDS: AnnounceKind[] = ["announce", "day", "soon"];

/** Чат для анонсов не назначен — это настройка, а не сбой отправки. */
export class AnnounceChatNotSet extends Error {
	constructor() {
		super("Чат для анонсов не задан: отправьте /anons_here в группе клуба от имени администратора");
		this.name = "AnnounceChatNotSet";
	}
}

/** Папка книги по id или имени папки (в событиях бывает и то, и то). */
async function resolveBookFolder(bookId?: string): Promise<string | null> {
	if (!bookId) return null;
	const index = await fetchIndex();
	return (
		index.books.find((b) => b.id === bookId)?.folder ??
		index.books.find((b) => b.folder === bookId)?.folder ??
		null
	);
}

/** Собирает данные для поста: книга, глава, темы со спикерами из заявок. */
export async function buildContext(env: Env, event: AnnounceEvent): Promise<AnnounceContext> {
	const folder = await resolveBookFolder(event.book_id);
	const meta = folder ? await fetchBookMeta(folder) : null;
	const chapter = folder && event.chapter ? await fetchChapter(folder, event.chapter) : null;

	const claims = chapter
		? (await listSpeakerClaims(env.BOOK_CLUB_DB)).map((c) => ({
				topicId: c.topic_id,
				username: c.username,
				fullName: c.full_name,
				status: c.status,
				slidesUrl: c.slides_url,
			}))
		: [];

	return {
		event,
		book: meta
			? {
					title: meta.title,
					url: meta.url,
					authors: (meta.authors ?? []).map((a) => a.name).filter(Boolean),
				}
			: undefined,
		chapterOrder: chapter?.order,
		chapterTitle: chapter?.title,
		topics: chapter ? buildTopics(chapter.topics, claims, chapter.order) : [],
	};
}

/**
 * Отправляет пост: с афишей, если она есть, иначе текстом. Подпись к фото
 * ограничена 1024 символами — длинный текст уходит отдельным сообщением,
 * чтобы ничего не обрезалось.
 */
async function deliver(
	env: Env,
	chatId: number,
	text: string,
	poster?: { fileId?: string | null; bytes?: Uint8Array },
): Promise<SentPost> {
	const hasPoster = Boolean(poster?.fileId || poster?.bytes);
	if (!hasPoster) return sendPost(env.BOT_TOKEN, chatId, text);

	const caption = text.length <= CAPTION_LIMIT ? text : undefined;
	const sent = poster?.bytes
		? await sendPhotoBytes(env.BOT_TOKEN, chatId, poster.bytes, "poster.jpg", caption)
		: await sendPhotoByFileId(env.BOT_TOKEN, chatId, poster?.fileId as string, caption);

	if (!caption) {
		// Афиша ушла картинкой, текст — следующим сообщением; id для отметки
		// берём от поста с афишей (он «главный»).
		await sendPost(env.BOT_TOKEN, chatId, text);
	}
	return sent;
}

/**
 * Планирует все три поста и сразу публикует анонс. Афиши приходят из CMS
 * байтами: анонсную отправляем сейчас, дневную — сохраняем в Telegram,
 * чтобы к дневному посту у неё уже был file_id.
 */
export async function announceEvent(
	env: Env,
	event: AnnounceEvent,
	posters: { announce?: Uint8Array; day?: Uint8Array },
	now = Date.now(),
): Promise<{ chatId: number; messageId: number | null; alreadySent: boolean }> {
	const chatId = await getAnnounceChatId(env.BOOK_CLUB_DB);
	if (chatId === null) throw new AnnounceChatNotSet();

	const snapshot = JSON.stringify(event);
	for (const kind of KINDS) {
		await planAnnouncement(env.BOOK_CLUB_DB, {
			eventId: event.id,
			kind,
			chatId,
			runAt: runAtFor(kind, event, now),
			event: snapshot,
		});
	}

	// Повторный вызов (правка встречи) обновляет план и афишу дня, но анонс
	// второй раз не постит.
	const already = await getAnnouncement(env.BOOK_CLUB_DB, event.id, "announce");
	const alreadySent = already?.sent_at != null;

	let sent: SentPost = { messageId: already?.message_id ?? null, photoFileId: null };
	if (!alreadySent) {
		const ctx = await buildContext(env, event);
		sent = await deliver(env, chatId, renderAnnouncement("announce", ctx), {
			bytes: posters.announce,
		});
		await markAnnouncementSent(env.BOOK_CLUB_DB, event.id, "announce", sent.messageId, now);
		if (sent.photoFileId) {
			await setPosterFileId(env.BOOK_CLUB_DB, event.id, "announce", sent.photoFileId);
		}
	}

	// Дневную афишу заранее загружаем в Telegram (отправкой в тот же чат её
	// пришлось бы показать раньше времени), поэтому просто держим байты до
	// дневного поста: сохраняем как file_id только то, что уже отправлено.
	if (posters.day) {
		await planAnnouncement(env.BOOK_CLUB_DB, {
			eventId: event.id,
			kind: "day",
			chatId,
			runAt: runAtFor("day", event, now),
			event: snapshot,
			posterFileId: null,
		});
		await stashDayPoster(env, event.id, posters.day);
	}

	return { chatId, messageId: sent.messageId, alreadySent };
}

/**
 * Дневная афиша до публикации живёт в KV (D1 — для строк, не для файлов):
 * ключ `poster:<eventId>`, значение — base64 картинки.
 */
export function dayPosterKey(eventId: string): string {
	return `poster:${eventId}`;
}

async function stashDayPoster(env: Env, eventId: string, bytes: Uint8Array): Promise<void> {
	await env.BOOK_CLUB_KV.put(dayPosterKey(eventId), bytes as unknown as ArrayBuffer, {
		// Афиша нужна только до дня встречи; месяц с запасом.
		expirationTtl: 60 * 60 * 24 * 31,
	});
}

async function takeDayPoster(env: Env, eventId: string): Promise<Uint8Array | undefined> {
	const stored = await env.BOOK_CLUB_KV.get(dayPosterKey(eventId), "arrayBuffer");
	if (!stored) return undefined;
	return new Uint8Array(stored);
}

/** Публикует один запланированный пост. */
async function publish(env: Env, row: AnnouncementRow): Promise<void> {
	const kind = row.kind as AnnounceKind;
	const event = JSON.parse(row.event) as AnnounceEvent;
	const ctx = await buildContext(env, event);

	// Дневной пост берёт свою афишу (если её загрузили), напоминание — уже
	// отправленную афишу по file_id: повторная загрузка файла не нужна.
	const bytes = kind === "day" ? await takeDayPoster(env, event.id) : undefined;
	const sent = await deliver(env, row.chat_id, renderAnnouncement(kind, ctx), {
		fileId: bytes ? null : row.poster_file_id,
		bytes,
	});

	const marked = await markAnnouncementSent(env.BOOK_CLUB_DB, event.id, kind, sent.messageId);
	if (!marked) {
		console.warn(`Пост ${kind} о ${event.id} уже был отмечен отправленным`);
		return;
	}
	if (sent.photoFileId) {
		await setPosterFileId(env.BOOK_CLUB_DB, event.id, kind, sent.photoFileId);
		// Напоминание переиспользует афишу дня.
		await setPosterFileId(env.BOOK_CLUB_DB, event.id, "soon", sent.photoFileId);
	}
	if (kind === "day" && bytes) {
		await env.BOOK_CLUB_KV.delete(dayPosterKey(event.id));
	}
}

/**
 * Cron: публикует посты, которым пришло время. Ошибка по одному посту не
 * останавливает остальные — при следующем запуске он попробует снова
 * (sent_at ставится только после успешной отправки).
 */
export async function runDueAnnouncements(env: Env, now = Date.now()): Promise<void> {
	const due = await listDueAnnouncements(env.BOOK_CLUB_DB, now);
	if (due.length === 0) return;
	console.log(`Посты о встречах к публикации: ${due.length}`);

	for (const row of due) {
		// Напоминание «за 5 минут» бессмысленно, если встреча давно началась:
		// отмечаем отправленным, чтобы не постить в пустоту после простоя cron.
		if (row.kind === "soon" && now > row.run_at + 30 * 60 * 1000) {
			await markAnnouncementSent(env.BOOK_CLUB_DB, row.event_id, row.kind, null, now);
			continue;
		}
		try {
			await publish(env, row);
		} catch (err) {
			console.error(`Не удалось опубликовать ${row.kind} о ${row.event_id}:`, err);
		}
	}
}
