// Посты о встрече: подготовка черновиков и публикация по команде из CMS.
// Рендер текста живёт в announce.ts, здесь — данные, черновики и отправка.
//
// Расписания нет намеренно: админ видит готовые тексты в CMS, при желании
// правит их и сам решает, когда и в какие группы публиковать.
//
// Почему снимок встречи хранится в D1: черновики готовятся сразу после нажатия
// «Создать pull request» в CMS, а в book-club-data встреча появится только
// после мержа. Книга, темы и спикеры берутся свежими при каждой пересборке
// текста — поэтому дневная афиша знает подтверждённых позже спикеров.

import {
	buildTopics,
	CAPTION_LIMIT,
	renderAnnouncement,
	type AnnounceContext,
	type AnnounceEvent,
	type AnnouncePerson,
} from "./announce";
import { fetchBookMeta, fetchChapter, fetchIndex } from "./api";
import { bookPageUrl } from "./urls";
import {
	getPostDraft,
	listAnnounceChats,
	listDuePostDrafts,
	listSpeakerClaims,
	markPostDraftFailed,
	markPostDraftSent,
	setPostDraftHasPoster,
	setPostDraftPoster,
	setPostDraftText,
	upsertPostDraft,
	type PostDraft,
} from "./db";
import { sendPhotoByFileId, sendPhotoBytes, sendPost } from "./telegram";
import type { AnnounceKind, ContentIndex } from "../types";

/** Три поста на встречу: анонс, афиша в день встречи, напоминание перед началом. */
export const POST_KINDS: AnnounceKind[] = ["announce", "day", "soon"];

/** В клубе не задана ни одна группа — постить некуда (нужен /anons_here). */
export class NoAnnounceChats extends Error {
	constructor() {
		super("Нет групп для постов: отправьте /anons_here в группе клуба от имени администратора");
		this.name = "NoAnnounceChats";
	}
}

/** Папка книги по id или имени папки (в событиях бывает и то, и то). */
function resolveBookFolder(index: ContentIndex | null, bookId?: string): string | null {
	if (!index || !bookId) return null;
	return (
		index.books.find((b) => b.id === bookId)?.folder ??
		index.books.find((b) => b.folder === bookId)?.folder ??
		null
	);
}

/** Собирает данные для поста: книга, глава, темы со спикерами из заявок. */
export async function buildContext(env: Env, event: AnnounceEvent): Promise<AnnounceContext> {
	// Реестр нужен и для папки книги, и для каталога спикеров (имена ведущих
	// в посте — ссылки на Telegram). Если книги у встречи нет, реестр берём
	// «по возможности»: без него имена просто останутся текстом, а падать
	// подготовке постов из-за недоступного GitHub не за что.
	let index: ContentIndex | null = null;
	if (event.book_id) {
		index = await fetchIndex();
	} else if ((event.moderators ?? []).length > 0) {
		index = await fetchIndex().catch((err) => {
			console.warn("Каталог спикеров недоступен — ведущие останутся без ссылок:", err);
			return null;
		});
	}

	const folder = resolveBookFolder(index, event.book_id);
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

	const directory: AnnouncePerson[] = (index?.speakers ?? []).map((s) => ({
		id: s.id,
		name: s.name,
		aliases: s.aliases,
		telegram: s.socials?.telegram,
	}));

	return {
		event,
		book: meta
			? {
					title: meta.title,
					// Ссылка на книгу в посте есть всегда: свой url книги (издатель),
					// иначе её страница в приложении клуба — там главы и карточки.
					url: meta.url || (folder ? bookPageUrl(env, folder) : undefined),
					authors: (meta.authors ?? []).map((a) => a.name).filter(Boolean),
				}
			: undefined,
		chapterOrder: chapter?.order,
		chapterTitle: chapter?.title,
		topics: chapter ? buildTopics(chapter.topics, claims, chapter.order, directory) : [],
		directory,
	};
}

/**
 * Афиша до публикации лежит в KV (D1 — для строк, не для файлов):
 * ключ `poster:<eventId>:<kind>`.
 */
export function posterKey(eventId: string, kind: string): string {
	return `poster:${eventId}:${kind}`;
}

async function stashPoster(env: Env, eventId: string, kind: string, bytes: Uint8Array): Promise<void> {
	await env.BOOK_CLUB_KV.put(posterKey(eventId, kind), bytes as unknown as ArrayBuffer, {
		// Афиша нужна до публикации; месяц с запасом.
		expirationTtl: 60 * 60 * 24 * 31,
	});
}

async function takePoster(env: Env, eventId: string, kind: string): Promise<Uint8Array | undefined> {
	const stored = await env.BOOK_CLUB_KV.get(posterKey(eventId, kind), "arrayBuffer");
	return stored ? new Uint8Array(stored) : undefined;
}

/**
 * Меняет афишу у отдельного поста (из раздела «Посты» в CMS): картинку можно
 * загрузить любому посту, включая напоминание, и заменить уже загруженную.
 * `bytes = null` — убрать афишу совсем.
 */
export async function setDraftPoster(
	env: Env,
	id: number,
	bytes: Uint8Array | null,
): Promise<PostDraft | null> {
	const draft = await getPostDraft(env.BOOK_CLUB_DB, id);
	if (!draft || draft.status === "sent") return null;

	if (bytes) {
		await stashPoster(env, draft.event_id, draft.kind, bytes);
	} else {
		await env.BOOK_CLUB_KV.delete(posterKey(draft.event_id, draft.kind));
	}
	// has_poster и сброс file_id — одной операцией: старое изображение Telegram
	// иначе переиспользовал бы вместо нового.
	return setPostDraftHasPoster(env.BOOK_CLUB_DB, id, Boolean(bytes));
}

/**
 * Афиша поста для превью в CMS: сначала загруженная (KV), иначе — файл из
 * Telegram по `file_id` (пост уже публиковали). У напоминания своей может не
 * быть — тогда показываем афишу дня, ту же, что уйдёт при публикации.
 */
export async function getDraftPoster(
	env: Env,
	draft: PostDraft,
): Promise<{ bytes: Uint8Array } | { fileId: string } | null> {
	const own = await takePoster(env, draft.event_id, draft.kind);
	if (own) return { bytes: own };
	if (draft.poster_file_id) return { fileId: draft.poster_file_id };
	if (draft.kind === "soon") {
		const day = await getDraftByKind(env, draft.event_id, "day");
		if (day) {
			const dayBytes = await takePoster(env, day.event_id, day.kind);
			if (dayBytes) return { bytes: dayBytes };
			if (day.poster_file_id) return { fileId: day.poster_file_id };
		}
	}
	return null;
}

/**
 * Готовит (или обновляет) черновики трёх постов о встрече. Ничего не публикует:
 * тексты ждут админа в CMS. Афиши складываем в KV — при публикации бот отправит
 * их файлом и дальше будет переиспользовать полученный file_id.
 */
export async function prepareDrafts(
	env: Env,
	event: AnnounceEvent,
	posters: { announce?: Uint8Array; day?: Uint8Array },
): Promise<{ drafts: number }> {
	const snapshot = JSON.stringify(event);
	const ctx = await buildContext(env, event);

	// Напоминание переиспользует афишу дня — своей у него нет.
	if (posters.announce) await stashPoster(env, event.id, "announce", posters.announce);
	if (posters.day) await stashPoster(env, event.id, "day", posters.day);

	let count = 0;
	for (const kind of POST_KINDS) {
		const fresh = kind === "announce" ? posters.announce : kind === "day" ? posters.day : undefined;
		const draft = await upsertPostDraft(env.BOOK_CLUB_DB, {
			eventId: event.id,
			kind,
			event: snapshot,
			text: renderAnnouncement(kind, ctx),
			hasPoster: Boolean(fresh),
		});
		// Новая афиша обязана вытеснить старый file_id, иначе Telegram отправит
		// прежнюю картинку — файл он берёт по id, а не из KV.
		if (draft && fresh) await setPostDraftPoster(env.BOOK_CLUB_DB, draft.id, null);
		if (draft) count++;
	}
	return { drafts: count };
}

/** Пересобирает текст черновика из свежих данных (после правок в репозитории). */
export async function refreshDraft(env: Env, id: number): Promise<PostDraft | null> {
	const draft = await getPostDraft(env.BOOK_CLUB_DB, id);
	if (!draft || draft.status === "sent") return draft;
	const event = JSON.parse(draft.event) as AnnounceEvent;
	const ctx = await buildContext(env, event);
	// edited = false: текст снова «как из данных», следующая правка встречи его обновит.
	return setPostDraftText(
		env.BOOK_CLUB_DB,
		id,
		renderAnnouncement(draft.kind as AnnounceKind, ctx),
		false,
	);
}

/**
 * Публикует черновик в выбранные группы (по умолчанию — во все).
 * Афишу первый раз отправляем файлом, дальше по file_id: Telegram не заставляет
 * загружать одну и ту же картинку в каждый чат.
 */
export async function publishDraft(
	env: Env,
	id: number,
	chatIds?: number[],
): Promise<{ sentTo: { chat_id: number; message_id: number | null }[]; errors: string[] }> {
	const draft = await getPostDraft(env.BOOK_CLUB_DB, id);
	if (!draft) throw new Error("Черновик не найден");

	const chats = await listAnnounceChats(env.BOOK_CLUB_DB);
	if (chats.length === 0) throw new NoAnnounceChats();
	const targets =
		chatIds && chatIds.length > 0
			? chats.filter((c) => chatIds.includes(c.chat_id))
			: chats;
	if (targets.length === 0) throw new Error("Ни одна из выбранных групп не подключена к боту");

	// Афиша: file_id (если уже публиковали) либо байты из KV. У напоминания
	// своей афиши нет — берём афишу дня, она к этому времени уже загружена.
	let fileId = draft.poster_file_id;
	let bytes: Uint8Array | undefined;
	if (!fileId && draft.has_poster) {
		bytes = await takePoster(env, draft.event_id, draft.kind);
	}
	if (!fileId && !bytes && draft.kind === "soon") {
		const day = await getDraftByKind(env, draft.event_id, "day");
		fileId = day?.poster_file_id ?? null;
	}

	const sentTo: { chat_id: number; message_id: number | null }[] = [];
	const errors: string[] = [];
	for (const chat of targets) {
		try {
			const caption = draft.text.length <= CAPTION_LIMIT ? draft.text : undefined;
			let messageId: number | null = null;

			if (fileId) {
				const sent = await sendPhotoByFileId(env.BOT_TOKEN, chat.chat_id, fileId, caption);
				messageId = sent.messageId;
			} else if (bytes) {
				const sent = await sendPhotoBytes(env.BOT_TOKEN, chat.chat_id, bytes, "poster.jpg", caption);
				messageId = sent.messageId;
				// Дальше переиспользуем file_id вместо повторной загрузки файла.
				if (sent.photoFileId) {
					fileId = sent.photoFileId;
					await setPostDraftPoster(env.BOOK_CLUB_DB, id, sent.photoFileId);
				}
			} else {
				const sent = await sendPost(env.BOT_TOKEN, chat.chat_id, draft.text);
				messageId = sent.messageId;
			}

			// Подпись к фото ограничена 1024 символами — длинный текст отдельным
			// сообщением, чтобы ничего не обрезалось.
			if ((fileId || bytes) && draft.text.length > CAPTION_LIMIT) {
				await sendPost(env.BOT_TOKEN, chat.chat_id, draft.text);
			}
			sentTo.push({ chat_id: chat.chat_id, message_id: messageId });
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`Пост ${draft.kind} о ${draft.event_id} не ушёл в ${chat.chat_id}:`, err);
			errors.push(`${chat.title ?? chat.chat_id}: ${reason}`);
		}
	}

	// Отправленным считаем, если ушло хотя бы в одну группу: иначе кнопка
	// «Опубликовать» должна остаться доступной.
	if (sentTo.length > 0) {
		await markPostDraftSent(env.BOOK_CLUB_DB, id, sentTo);
		if (fileId) await env.BOOK_CLUB_KV.delete(posterKey(draft.event_id, draft.kind));
	}
	return { sentTo, errors };
}

/**
 * Публикация одобренных постов, которым пришло время (cron каждые 5 минут).
 * Одобрение обязательно: расписание — это «опубликуй за меня то, что я уже
 * прочитал», а не автопостинг. Неудачи считаем, чтобы упавший пост не долбил
 * группу каждые 5 минут: после MAX_PUBLISH_ATTEMPTS попыток он ждёт админа.
 */
export async function runScheduledPosts(env: Env, now = Date.now()): Promise<{ sent: number }> {
	const due = await listDuePostDrafts(env.BOOK_CLUB_DB, now);
	let sent = 0;
	for (const draft of due) {
		const chatIds = draft.scheduled_chats
			? (JSON.parse(draft.scheduled_chats) as number[])
			: undefined;
		try {
			const result = await publishDraft(env, draft.id, chatIds);
			if (result.sentTo.length > 0) {
				sent++;
				if (result.errors.length > 0) {
					console.warn(`Пост ${draft.id} ушёл частично:`, result.errors.join("; "));
				}
			} else {
				await markPostDraftFailed(env.BOOK_CLUB_DB, draft.id, result.errors.join("; "));
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`Автопубликация поста ${draft.id} не удалась:`, err);
			await markPostDraftFailed(env.BOOK_CLUB_DB, draft.id, message);
		}
	}
	return { sent };
}

/**
 * Когда такой пост обычно публикуют — конкретным временем, чтобы CMS могла
 * подставить его в поле расписания. Анонс — сразу (ближайший тик cron), афиша
 * дня — утром в день встречи, напоминание — за 10 минут до начала.
 */
export function suggestedPublishAt(
	kind: AnnounceKind,
	event: { date: string; time: string },
	now = Date.now(),
): number | null {
	const start = Date.parse(`${event.date}T${event.time}:00+03:00`);
	if (!Number.isFinite(start)) return null;
	if (kind === "announce") return now;
	if (kind === "day") return Date.parse(`${event.date}T10:00:00+03:00`);
	return start - 10 * 60 * 1000;
}

/** Черновик встречи по виду поста (нужен напоминанию, чтобы взять афишу дня). */
async function getDraftByKind(env: Env, eventId: string, kind: string): Promise<PostDraft | null> {
	const { results } = await env.BOOK_CLUB_DB.prepare(
		"SELECT * FROM post_drafts WHERE event_id = ? AND kind = ?",
	)
		.bind(eventId, kind)
		.all<PostDraft>();
	return results?.[0] ?? null;
}
