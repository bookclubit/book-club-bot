/**
 * «Книжный клуб» — телеграм-бот книжного клуба для фронтендеров.
 * Cloudflare Worker: вебхук Telegram + cron (карточки и напоминания) +
 * небольшое HTTP API для miniapp (занятость тем) и CMS (модерация заявок).
 */

import type { TelegramMessage, TelegramUpdate } from "./types";
import { configureApi, fetchEventByPath, fetchIndex } from "./lib/api";
import {
	mintSession,
	timingSafeEqual,
	verifyInitData,
	verifyLoginWidget,
	verifySession,
	type TgUser,
} from "./lib/auth";
import {
	addAnnounceChat,
	assignClaim,
	cardKey,
	createSpeakerClaim,
	deletePostDraft,
	DAILY_CARD_OPTIONS,
	deleteSpeakerClaim,
	getCardProgress,
	getCardProgressMap,
	getClaimByTopic,
	getDailyCards,
	getMembershipRequestById,
	getSpeakerClaim,
	getUser,
	listAnnounceChats,
	listMembershipRequests,
	listPostDrafts,
	listRegistrations,
	listSpeakerClaims,
	markReminderSent,
	releaseClaimByTopic,
	removeAnnounceChat,
	saveCardProgress,
	saveMembershipRequest,
	setClaimSlides,
	setDailyCards,
	setMembershipStatus,
	setPostDraftText,
	updateSpeakerClaim,
	upsertUser,
	wasReminderSent,
} from "./lib/db";
import { speakerAccess } from "./lib/members";
import { fetchPlanTopics } from "./lib/plan";
import { NoAnnounceChats, prepareDrafts, publishDraft, refreshDraft } from "./lib/announcer";
import { KIND_INFO, type AnnounceEvent } from "./lib/announce";
import { miniappUrl } from "./lib/urls";
import type { AnnounceKind } from "./types";
import { initialProgress, reviewFromQuality } from "./lib/spaced-repetition";
import { startStudy } from "./lib/study";
import { eventDateFromPath, eventStartMs, mskToday, renderEventLinks } from "./lib/events";
import { deleteSubscriber, listSubscribers } from "./lib/storage";
import {
	getFileResponse,
	isChatAdmin,
	sendMessage,
	setChatMenuButton,
	setMyCommands,
} from "./lib/telegram";
import { handleCallback } from "./handlers/callback";
import {
	completeClaim,
	DEFAULT_CMS_CLAIMS_URL,
	handleCancel,
	handleDialogMessage,
	handleJoin,
	handleSpeaker,
	notifyAdminMembership,
} from "./handlers/registration";
import { handleStart } from "./commands/start";
import { handleStop } from "./commands/stop";
import { handleToday } from "./commands/today";
import { handleStatus } from "./commands/status";
import { handleSettings } from "./commands/settings";
import { handleHelp } from "./commands/help";

const MORNING_INTRO =
	"☀️ <b>Доброе утро!</b> Карточки на сегодня для повторения:";

const UNKNOWN_COMMAND =
	"Не знаю такой команды 🤔\n\nСписок всех команд — /help";

/**
 * `/anons_here` и `/anons_stop` — подключить этот чат к постам о встречах или
 * отключить. Только в группе/канале и только от администратора чата: иначе
 * любой участник смог бы перенаправить посты клуба к себе.
 */
async function handleAnnounceHere(
	env: Env,
	message: TelegramMessage,
	action: "add" | "remove",
): Promise<void> {
	const chatId = message.chat.id;
	if (message.chat.type === "private") {
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			"Эту команду нужно отправить в группе или канале клуба — там, где бот будет постить о встречах.",
		);
		return;
	}

	const userId = message.from?.id;
	if (!userId || !(await isChatAdmin(env.BOT_TOKEN, chatId, userId))) {
		await sendMessage(env.BOT_TOKEN, chatId, "Подключить или отключить чат может только администратор.");
		return;
	}

	if (action === "remove") {
		const removed = await removeAnnounceChat(env.BOOK_CLUB_DB, chatId);
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			removed
				? "Готово: посты о встречах здесь больше не публикуются."
				: "Этот чат и не был подключён.",
		);
		return;
	}

	await addAnnounceChat(env.BOOK_CLUB_DB, chatId, message.chat.title ?? null);
	const chats = await listAnnounceChats(env.BOOK_CLUB_DB);
	await sendMessage(
		env.BOT_TOKEN,
		chatId,
		"✅ Чат подключён к постам о встречах" +
			(chats.length > 1 ? ` (всего групп: ${chats.length})` : "") +
			".\n\nПосты не выходят сами: создайте встречу в CMS — бот подготовит анонс, афишу дня " +
			"и напоминание, а вы посмотрите тексты в разделе «Посты» и опубликуете, куда нужно.\n\n" +
			"Отключить этот чат — /anons_stop",
	);
}

/** Извлекает имя команды из текста: «/today@bot arg» → «today». */
function parseCommand(text: string): string | null {
	if (!text.startsWith("/")) return null;
	const first = text.trim().split(/\s+/)[0];
	return first.slice(1).split("@")[0].toLowerCase();
}

/**
 * Команды, на которые бот отвечает в группе или канале. Всё остальное там
 * игнорируется молча: бот-администратор получает ВСЕ сообщения чата (Telegram
 * отключает для админов режим приватности), и реакция на них была бы спамом
 * в чате клуба. Личные диалоги, карточки и заявки живут только в личке.
 */
const GROUP_COMMANDS = new Set(["anons_here", "anons_stop"]);

/** Команда для группы, если сообщение — именно она. Иначе null (молчим). */
export function groupCommand(text?: string): string | null {
	const command = text?.trim().startsWith("/") ? parseCommand(text.trim()) : null;
	return command && GROUP_COMMANDS.has(command) ? command : null;
}

async function routeMessage(env: Env, message: TelegramMessage): Promise<void> {
	const text = message.text?.trim();

	// Группа или канал: только свои команды, на болтовню участников не реагируем.
	if (message.chat.type !== "private") {
		const command = groupCommand(text);
		if (command === "anons_here") await handleAnnounceHere(env, message, "add");
		if (command === "anons_stop") await handleAnnounceHere(env, message, "remove");
		return;
	}

	// Сообщение без текста: фото может быть шагом диалога заявки.
	if (!text) {
		if (message.photo) await handleDialogMessage(env, message);
		return;
	}

	const command = parseCommand(text);

	// Обычный текст и /skip — сперва пробуем как шаг диалога заявки.
	if (command === null || command === "skip") {
		if (await handleDialogMessage(env, message)) return;
		await sendMessage(env.BOT_TOKEN, message.chat.id, UNKNOWN_COMMAND);
		return;
	}

	switch (command) {
		case "start": {
			// Диплинки: /start join_<eventId> — запись на встречу,
			// /start speaker[_...] — заявка на доклад (глобальная).
			const payload = text.split(/\s+/)[1] ?? "";
			if (payload.startsWith("join_")) {
				return handleJoin(env, message, payload.slice("join_".length));
			}
			if (payload === "speaker" || payload.startsWith("speaker_")) {
				return handleSpeaker(env, message);
			}
			return handleStart(env, message);
		}
		case "speaker":
			return handleSpeaker(env, message);
		case "cancel":
			return handleCancel(env, message);
		case "stop":
			return handleStop(env, message);
		case "today":
			return handleToday(env, message);
		case "status":
			return handleStatus(env, message);
		case "settings":
			return handleSettings(env, message);
		case "help":
			return handleHelp(env, message);
		case "anons_here":
			return handleAnnounceHere(env, message, "add");
		case "anons_stop":
			return handleAnnounceHere(env, message, "remove");
		default:
			await sendMessage(env.BOT_TOKEN, message.chat.id, UNKNOWN_COMMAND);
	}
}

/** Обрабатывает один update от Telegram. */
async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
	if (update.callback_query) {
		return handleCallback(env, update.callback_query);
	}
	if (update.message) {
		return routeMessage(env, update.message);
	}
	// Пользователь заблокировал бота — убираем из рассылки, чтобы не копить
	// «мёртвых» подписчиков (прогресс в D1 сохраняется).
	if (update.my_chat_member) {
		const status = update.my_chat_member.new_chat_member.status;
		if (status === "kicked" || status === "banned") {
			const chatId = update.my_chat_member.chat.id;
			await deleteSubscriber(env.BOOK_CLUB_KV, chatId);
			console.log(`Бот заблокирован в чате ${chatId} — подписка на рассылку удалена`);
		}
	}
}

// ── HTTP API ─────────────────────────────────────────────────────────────────

// CORS публичных эндпоинтов (/api/claims, /api/progress, /api/auth/* и т.д.) —
// открыты любому origin. Админские маршруты ограничены доменом CMS (см. corsFor).
const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "authorization, content-type",
};

/** Origin-ы, которым разрешены кросс-доменные запросы к /api/admin/* (CMS). */
function adminAllowedOrigins(env: Env): string[] {
	try {
		return [new URL(env.CMS_CLAIMS_URL || DEFAULT_CMS_CLAIMS_URL).origin];
	} catch {
		return [new URL(DEFAULT_CMS_CLAIMS_URL).origin];
	}
}

/**
 * CORS-заголовки под запрос: публичные маршруты — «*», админские — только
 * origin из списка разрешённых. Неразрешённому origin заголовок
 * access-control-allow-origin не ставим вовсе — браузер такой ответ не отдаст.
 */
function corsFor(env: Env, request: Request, url: URL): Record<string, string> {
	if (!url.pathname.startsWith("/api/admin/")) return CORS_HEADERS;

	const headers: Record<string, string> = {
		"access-control-allow-methods": CORS_HEADERS["access-control-allow-methods"],
		"access-control-allow-headers": CORS_HEADERS["access-control-allow-headers"],
		vary: "origin",
	};
	const origin = request.headers.get("origin");
	if (origin && adminAllowedOrigins(env).includes(origin)) {
		headers["access-control-allow-origin"] = origin;
	}
	return headers;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
	});
}

function isAdmin(env: Env, request: Request): boolean {
	// Сравнение в постоянное время — токен нельзя подбирать по таймингу ответа.
	if (!env.ADMIN_API_TOKEN) return false;
	const header = request.headers.get("authorization") ?? "";
	return timingSafeEqual(header, `Bearer ${env.ADMIN_API_TOKEN}`);
}

/**
 * Публичная занятость тем (для miniapp): GET /api/claims.
 * Отдаём только то, что можно показывать всем: тема, статус, имя спикера.
 */
async function handleClaimsApi(env: Env): Promise<Response> {
	const claims = await listSpeakerClaims(env.BOOK_CLUB_DB);
	return json({
		claims: claims.map((c) => ({
			topic_id: c.topic_id,
			topic_title: c.topic_title,
			book_id: c.book_id,
			chapter: c.chapter,
			status: c.status,
			speaker: c.full_name ?? (c.username ? `@${c.username}` : "участник клуба"),
			speaker_id: c.speaker_id,
			slides_url: c.slides_url,
		})),
	});
}

/** Полный список заявок для CMS (админ). */
async function handleAdminClaims(env: Env): Promise<Response> {
	const claims = await listSpeakerClaims(env.BOOK_CLUB_DB);
	return json({ claims });
}

/** Репозиторий презентаций по умолчанию (перекрывается env TALKS_REPO). */
const DEFAULT_TALKS_REPO = "https://github.com/bookclubit/book-club-talks";

/** Сообщение спикеру о старте генерации презентации: PR + превью + инструкция. */
function talkReadyMessage(env: Env, slides: string): string {
	const talksRepo = env.TALKS_REPO || DEFAULT_TALKS_REPO;
	let branch = "";
	let previewUrl = "";
	try {
		const host = new URL(slides).hostname; // bc-114-ai-1-pomazkov.pages.dev
		branch = host.split(".")[0].toUpperCase();
		previewUrl = `https://preview.${host}`; // детерминированный адрес превью
	} catch {
		branch = "";
	}
	// is%3Aopen — только актуальный открытый PR ветки (закрытые дубли не путают).
	const prLink = branch ? `${talksRepo}/pulls?q=is%3Apr+is%3Aopen+head%3A${branch}` : `${talksRepo}/pulls`;
	const preview = previewUrl
		? `\n👀 <b>Живое превью</b> (для нового доклада поднимется за пару минут, дальше обновляется на каждый твой пуш):\n<a href="${previewUrl}">${previewUrl}</a>\n`
		: "";
	return (
		"🎤 <b>Ура, твоя тема в программе!</b>\n\n" +
		"Я уже собрал стартовый шаблон презентации — дальше он полностью твой. " +
		"Не переживай, ничего сложного, всё по шагам 👇\n\n" +
		`📄 <b>Черновик доклада</b> (pull request):\n<a href="${prLink}">открыть на GitHub</a>\n` +
		preview +
		"\n<b>Как собрать презентацию:</b>\n" +
		`1️⃣ Склонируй ветку черновика:\n<code>git clone -b ${branch} ${talksRepo}.git</code>\n` +
		`2️⃣ Правь слайды в <code>talks/${branch}/index.html</code>\n` +
		"3️⃣ <code>git push</code> — превью обновится само, можно сразу смотреть\n" +
		"4️⃣ Готово? Напиши админу — он смёржит, и доклад встанет на боевую ссылку:\n" +
		`<a href="${slides}">${slides}</a>\n\n` +
		`📚 Шаблон и подсказки: <a href="${talksRepo}#readme">README</a>\n\n` +
		"Если что-то непонятно — просто напиши, помогу 💛"
	);
}

/**
 * Управление заявками из CMS: POST /api/admin/claims. Единый источник занятости —
 * D1, поэтому CMS назначает/освобождает темы теми же заявками, что и бот.
 *   { action: "confirm"|"decline", id }                      — модерация (по id заявки)
 *   { action: "assign", topic_id, topic_title, book_id, chapter, speaker_id, speaker_name }
 *   { action: "release", topic_id }                          — освободить тему
 *   { action: "slides", topic_id, slides_url }               — ссылка на презентацию
 */
async function handleAdminDecision(env: Env, request: Request): Promise<Response> {
	let body: {
		id?: number;
		action?: string;
		topic_id?: string;
		topic_title?: string;
		book_id?: string;
		chapter?: string;
		speaker_id?: string;
		speaker_name?: string;
		slides_url?: string;
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "невалидный JSON" }, 400);
	}

	// Назначение/освобождение/слайды из CMS — по topic_id, без Telegram-уведомления.
	if (body.action === "assign") {
		if (!body.topic_id || !body.topic_title || !body.book_id || !body.chapter || !body.speaker_id || !body.speaker_name) {
			return json({ error: "нужны topic_id, topic_title, book_id, chapter, speaker_id, speaker_name" }, 400);
		}
		await assignClaim(env.BOOK_CLUB_DB, {
			topicId: body.topic_id,
			topicTitle: body.topic_title,
			bookId: body.book_id,
			chapter: body.chapter,
			speakerId: body.speaker_id,
			speakerName: body.speaker_name,
		});
		return json({ ok: true });
	}
	if (body.action === "release") {
		if (!body.topic_id) return json({ error: "нужен topic_id" }, 400);
		await releaseClaimByTopic(env.BOOK_CLUB_DB, body.topic_id);
		return json({ ok: true });
	}
	if (body.action === "slides") {
		if (!body.topic_id || !body.slides_url) return json({ error: "нужны topic_id и slides_url" }, 400);
		await setClaimSlides(env.BOOK_CLUB_DB, body.topic_id, body.slides_url);
		// Сообщаем спикеру: презентация генерируется — ссылка на PR + инструкция.
		const claim = await getClaimByTopic(env.BOOK_CLUB_DB, body.topic_id);
		if (claim?.chat_id) {
			await sendMessage(env.BOT_TOKEN, claim.chat_id, talkReadyMessage(env, body.slides_url));
		}
		return json({ ok: true });
	}

	// Модерация заявок бота — по id заявки, с уведомлением спикера.
	const claim = typeof body.id === "number" ? await getSpeakerClaim(env.BOOK_CLUB_DB, body.id) : null;
	if (!claim) return json({ error: "заявка не найдена" }, 404);

	if (body.action === "confirm") {
		await updateSpeakerClaim(env.BOOK_CLUB_DB, claim.id, { status: "confirmed" });
		if (claim.chat_id) {
			await sendMessage(
				env.BOT_TOKEN,
				claim.chat_id,
				`Тема «<b>${claim.topic_title}</b>» подтверждена — ты в программе! 🎉\n` +
					"Админ свяжется с тобой по деталям презентации.",
			);
		}
		return json({ ok: true });
	}
	if (body.action === "decline") {
		await deleteSpeakerClaim(env.BOOK_CLUB_DB, claim.id);
		if (claim.chat_id) {
			await sendMessage(
				env.BOT_TOKEN,
				claim.chat_id,
				`Заявку на тему «<b>${claim.topic_title}</b>» не подтвердили 😔 ` +
					"Можно выбрать другую тему: /speaker",
			);
		}
		return json({ ok: true });
	}
	return json({ error: "action: confirm | decline | assign | release | slides" }, 400);
}

/**
 * Фото из Telegram для CMS: GET /api/admin/photo?claim=<id> (заявка на доклад)
 * или ?member=<id> (заявка на участие в клубе).
 */
async function handleAdminPhoto(env: Env, url: URL): Promise<Response> {
	const claimId = Number(url.searchParams.get("claim"));
	const memberId = Number(url.searchParams.get("member"));

	let fileId: string | null = null;
	if (Number.isFinite(memberId) && memberId > 0) {
		fileId = (await getMembershipRequestById(env.BOOK_CLUB_DB, memberId))?.photo_file_id ?? null;
	} else if (Number.isFinite(claimId) && claimId > 0) {
		fileId = (await getSpeakerClaim(env.BOOK_CLUB_DB, claimId))?.photo_file_id ?? null;
	}
	if (!fileId) return json({ error: "у заявки нет фото" }, 404);

	const file = await getFileResponse(env.BOT_TOKEN, fileId);
	if (!file) return json({ error: "не удалось получить файл из Telegram" }, 502);
	return new Response(file.body, {
		headers: { "content-type": "image/jpeg", ...CORS_HEADERS },
	});
}

/** Команды бота для меню Telegram. Единственный источник списка. */
const BOT_COMMANDS = [
	{ command: "today", description: "Начать повторение карточек" },
	{ command: "status", description: "Статистика изучения" },
	{ command: "settings", description: "Сколько карточек в день" },
	{ command: "speaker", description: "Выступить с докладом или вступить в клуб" },
	{ command: "cancel", description: "Прервать заявку" },
	{ command: "help", description: "Помощь и список команд" },
	{ command: "anons_here", description: "Подключить этот чат к постам о встречах (админ)" },
	{ command: "anons_stop", description: "Отключить посты о встречах в этом чате (админ)" },
	{ command: "start", description: "Подписка на ежедневные карточки" },
	{ command: "stop", description: "Отписаться от карточек" },
];

/**
 * Настройка бота: POST /api/admin/setup — регистрирует команды меню и кнопку
 * «Открыть приложение» (Mini App). Вызывать после изменения набора команд.
 */
async function handleAdminSetup(env: Env): Promise<Response> {
	const url = miniappUrl(env);
	await setMyCommands(env.BOT_TOKEN, BOT_COMMANDS);
	await setChatMenuButton(env.BOT_TOKEN, "🗂 Приложение", url);
	return json({ ok: true, commands: BOT_COMMANDS.map((c) => c.command), menu_button: url });
}

/** Афиша из CMS приходит base64 — декодируем в байты для sendPhoto. */
function decodePoster(base64?: string | null): Uint8Array | undefined {
	if (!base64) return undefined;
	// CMS может прислать data-URL: отрезаем префикс.
	const clean = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
	try {
		const binary = atob(clean);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes.length > 0 ? bytes : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Подготовка постов о встрече: POST /api/admin/announce.
 * Тело — { event, posters: { announce?, day? } }, где event повторяет схему
 * events/*.json (CMS присылает поля формы: встречи ещё нет в book-club-data,
 * она в открытом PR). Бот только готовит черновики — публикует админ из CMS.
 */
async function handleAdminAnnounce(env: Env, request: Request): Promise<Response> {
	let body: { event?: AnnounceEvent; posters?: { announce?: string; day?: string } };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "ожидается JSON" }, 400);
	}

	const event = body.event;
	if (!event?.id || !event.date || !event.time || !event.title) {
		return json({ error: "в event нужны id, title, date и time" }, 400);
	}

	try {
		const result = await prepareDrafts(env, event, {
			announce: decodePoster(body.posters?.announce),
			day: decodePoster(body.posters?.day),
		});
		return json({ ok: true, ...result });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Не удалось подготовить посты о ${event.id}:`, err);
		return json({ error: message }, 502);
	}
}

/** Черновики постов и группы клуба для CMS: GET /api/admin/posts. */
async function handleAdminPosts(env: Env): Promise<Response> {
	const [posts, chats] = await Promise.all([
		listPostDrafts(env.BOOK_CLUB_DB),
		listAnnounceChats(env.BOOK_CLUB_DB),
	]);
	return json({
		posts: posts.map((p) => ({
			id: p.id,
			event_id: p.event_id,
			kind: p.kind,
			kind_title: KIND_INFO[p.kind as AnnounceKind]?.title ?? p.kind,
			kind_when: KIND_INFO[p.kind as AnnounceKind]?.when ?? "",
			// Заголовок и дата встречи — чтобы CMS не разбирала снимок сама.
			event_title: safeEventField(p.event, "title"),
			event_date: safeEventField(p.event, "date"),
			event_time: safeEventField(p.event, "time"),
			text: p.text,
			edited: p.edited === 1,
			has_poster: p.has_poster === 1 || Boolean(p.poster_file_id),
			status: p.status,
			sent_at: p.sent_at,
			sent_to: p.sent_to ? (JSON.parse(p.sent_to) as unknown) : null,
			updated_at: p.updated_at,
		})),
		chats,
	});
}

/** Поле из снимка встречи; снимок писали мы, но JSON мог устареть — не падаем. */
function safeEventField(snapshot: string, field: string): string | null {
	try {
		const parsed = JSON.parse(snapshot) as Record<string, unknown>;
		const value = parsed[field];
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

/**
 * Управление постами из CMS: POST /api/admin/posts.
 *   { action: "publish", id, chat_ids? } — опубликовать (по умолчанию во все группы)
 *   { action: "text", id, text }         — сохранить правку текста
 *   { action: "refresh", id }            — пересобрать текст из данных клуба
 *   { action: "delete", id }             — убрать черновик
 */
async function handleAdminPostAction(env: Env, request: Request): Promise<Response> {
	let body: { action?: string; id?: number; text?: string; chat_ids?: number[] };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "невалидный JSON" }, 400);
	}
	const id = Number(body.id);
	if (!Number.isFinite(id) || id <= 0) return json({ error: "нужен id черновика" }, 400);

	if (body.action === "text") {
		const text = (body.text ?? "").trim();
		if (!text) return json({ error: "текст поста не может быть пустым" }, 400);
		const draft = await setPostDraftText(env.BOOK_CLUB_DB, id, text);
		if (!draft) return json({ error: "черновик не найден или уже опубликован" }, 404);
		return json({ ok: true });
	}

	if (body.action === "refresh") {
		const draft = await refreshDraft(env, id);
		if (!draft) return json({ error: "черновик не найден" }, 404);
		return json({ ok: true, text: draft.text });
	}

	if (body.action === "delete") {
		await deletePostDraft(env.BOOK_CLUB_DB, id);
		return json({ ok: true });
	}

	if (body.action === "publish") {
		try {
			const result = await publishDraft(env, id, body.chat_ids);
			// Ни одна группа не приняла пост — это ошибка, кнопка должна остаться.
			if (result.sentTo.length === 0) {
				return json({ error: result.errors.join("; ") || "пост не ушёл ни в одну группу" }, 502);
			}
			return json({ ok: true, sent_to: result.sentTo, errors: result.errors });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Групп нет — это настройка, а не сбой отправки.
			return json({ error: message }, err instanceof NoAnnounceChats ? 409 : 502);
		}
	}

	return json({ error: "action: publish | text | refresh | delete" }, 400);
}

// ── Участие в клубе: заявки и брони тем (для miniapp и CMS) ───────────────────

/** Сколько текста ждём от заявителя: имя и рассказ о себе. */
const NAME_LIMITS = { min: 2, max: 80 };
const ABOUT_LIMITS = { min: 10, max: 2000 };

/**
 * Статус участия текущего пользователя: GET /api/membership.
 * Пока `registered` = false, темы докладов брать нельзя — miniapp показывает
 * форму заявки вместо списка тем.
 */
async function handleMembership(env: Env, userId: number): Promise<Response> {
	const user = await getUser(env.BOOK_CLUB_DB, userId);
	const access = await speakerAccess(env, userId, user?.username);
	return json({
		registered: access.registered,
		status: access.request?.status ?? (access.registered ? "approved" : "none"),
		full_name: access.fullName,
		about: access.request?.about ?? null,
		speaker: access.speaker ? { id: access.speaker.id, name: access.speaker.name } : null,
	});
}

/** Заявка на участие из miniapp: POST /api/membership { full_name, about }. */
async function handleApply(env: Env, userId: number, request: Request): Promise<Response> {
	let body: { full_name?: string; about?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "невалидный JSON" }, 400);
	}
	const fullName = (body.full_name ?? "").trim();
	const about = (body.about ?? "").trim();
	if (fullName.length < NAME_LIMITS.min || fullName.length > NAME_LIMITS.max) {
		return json({ error: "имя и фамилия: от 2 до 80 символов" }, 400);
	}
	if (about.length < ABOUT_LIMITS.min || about.length > ABOUT_LIMITS.max) {
		return json({ error: "расскажите о себе — от 10 до 2000 символов" }, 400);
	}

	const user = await getUser(env.BOOK_CLUB_DB, userId);
	const access = await speakerAccess(env, userId, user?.username);
	// Участник клуба заявку не подаёт — ему сразу доступны темы.
	if (access.registered) return json({ registered: true, status: "approved" });

	const saved = await saveMembershipRequest(env.BOOK_CLUB_DB, {
		chatId: userId,
		username: user?.username ?? null,
		fullName,
		about,
		photoUrl: user?.photo_url ?? null,
		source: "miniapp",
	});
	if (saved) await notifyAdminMembership(env, saved);
	return json({ registered: false, status: saved?.status ?? "pending" });
}

/**
 * Бронь темы доклада из miniapp: POST /api/claim { topic_id }.
 * Тот же путь, что и кнопка в боте: проверка участия → заявка в D1 → админу.
 */
async function handleClaimTopic(env: Env, userId: number, request: Request): Promise<Response> {
	let body: { topic_id?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "невалидный JSON" }, 400);
	}
	const topicId = (body.topic_id ?? "").trim();
	if (!topicId) return json({ error: "нужен topic_id" }, 400);

	const user = await getUser(env.BOOK_CLUB_DB, userId);
	const access = await speakerAccess(env, userId, user?.username);
	if (!access.registered) {
		return json(
			{
				error: "темы докладов берут участники клуба — сначала заявка на участие",
				status: access.request?.status ?? "none",
			},
			403,
		);
	}

	// План — источник истины по темам: бронировать можно только тему будущего эфира.
	const plan = (await fetchPlanTopics()).find((t) => t.topic.id === topicId);
	if (!plan) return json({ error: "этой темы нет в плане" }, 404);

	const claim = await createSpeakerClaim(env.BOOK_CLUB_DB, {
		topicId: plan.topic.id,
		topicTitle: plan.topic.title,
		bookId: plan.bookId,
		chapter: plan.chapterSlug,
		chatId: userId,
		username: user?.username ?? undefined,
	});
	if (!claim) return json({ error: "тему только что заняли" }, 409);

	await completeClaim(env, claim, access, user?.username ?? undefined);
	return json({ ok: true, topic_title: plan.topic.title, status: "pending" });
}

/** Заявки на участие для CMS: GET /api/admin/members. */
async function handleAdminMembers(env: Env): Promise<Response> {
	return json({ members: await listMembershipRequests(env.BOOK_CLUB_DB) });
}

/**
 * Решение по заявке на участие: POST /api/admin/members { id, action }.
 * approve — человек может брать темы; decline — заявку можно отправить заново.
 */
async function handleAdminMemberDecision(env: Env, request: Request): Promise<Response> {
	let body: { id?: number; action?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "невалидный JSON" }, 400);
	}
	if (body.action !== "approve" && body.action !== "decline") {
		return json({ error: "action: approve | decline" }, 400);
	}
	const id = Number(body.id);
	if (!Number.isFinite(id) || !(await getMembershipRequestById(env.BOOK_CLUB_DB, id))) {
		return json({ error: "заявка не найдена" }, 404);
	}

	const member = await setMembershipStatus(
		env.BOOK_CLUB_DB,
		id,
		body.action === "approve" ? "approved" : "declined",
	);
	// Заявку могли отправить из браузера, ни разу не написав боту — тогда
	// сообщение не доставить, и это не повод считать решение неудачным.
	if (member?.chat_id) {
		try {
			await sendMessage(
				env.BOT_TOKEN,
				member.chat_id,
				body.action === "approve"
					? "🎉 <b>Добро пожаловать в клуб!</b>\n\n" +
							"Заявку одобрили — теперь можно взять тему доклада: /speaker " +
							"или в приложении клуба на вкладке «Встречи»."
					: "Заявку на участие пока не одобрили 😔\n\n" +
							"Можно отправить её заново, добавив подробностей о себе: /speaker",
			);
		} catch (err) {
			console.warn(`Не удалось сообщить решение по заявке ${id}:`, err);
		}
	}
	return json({ ok: true, member });
}

// ── Платформа: вход через Telegram и единый прогресс карточек ─────────────────

/** Оценка сайта (4 варианта) и бота → качество ответа q (0–5) в SM-2. */
const PLATFORM_QUALITY: Record<string, number> = { again: 1, hard: 3, good: 4, easy: 5 };

function publicUser(u: TgUser): Record<string, unknown> {
	return {
		id: u.id,
		username: u.username ?? null,
		first_name: u.first_name ?? null,
		last_name: u.last_name ?? null,
		photo_url: u.photo_url ?? null,
	};
}

/** userId из подписанной сессии (заголовок Authorization: Bearer), иначе null. */
async function authUser(env: Env, request: Request): Promise<number | null> {
	const header = request.headers.get("authorization") ?? "";
	if (!header.startsWith("Bearer ")) return null;
	return verifySession(env.BOT_TOKEN, header.slice("Bearer ".length));
}

/**
 * Вход через Telegram: POST /api/auth/telegram
 * { initData } (Mini App) или { widget } (Login Widget). Проверяем подпись,
 * заводим/обновляем аккаунт и выдаём сессию.
 */
async function handleAuthTelegram(env: Env, request: Request): Promise<Response> {
	let body: { initData?: string; widget?: Record<string, string> };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "невалидный JSON" }, 400);
	}

	let user: TgUser | null = null;
	if (body.initData) user = await verifyInitData(env.BOT_TOKEN, body.initData);
	else if (body.widget) user = await verifyLoginWidget(env.BOT_TOKEN, body.widget);
	if (!user) return json({ error: "подпись Telegram не прошла проверку" }, 401);

	await upsertUser(env.BOOK_CLUB_DB, {
		id: user.id,
		username: user.username ?? null,
		firstName: user.first_name ?? null,
		lastName: user.last_name ?? null,
		photoUrl: user.photo_url ?? null,
	});
	const token = await mintSession(env.BOT_TOKEN, user.id);
	return json({ token, user: publicUser(user) });
}

/** Профиль текущего пользователя: GET /api/me. */
async function handleMe(env: Env, userId: number): Promise<Response> {
	const user = await getUser(env.BOOK_CLUB_DB, userId);
	if (!user) return json({ error: "аккаунт не найден" }, 404);
	return json({ user });
}

/** Весь прогресс пользователя (для сайта): GET /api/progress. */
async function handleProgress(env: Env, userId: number): Promise<Response> {
	const map = await getCardProgressMap(env.BOOK_CLUB_DB, userId);
	return json({ progress: [...map.values()] });
}

/** Настройки пользователя: GET /api/settings. */
async function handleGetSettings(env: Env, userId: number): Promise<Response> {
	const daily = await getDailyCards(env.BOOK_CLUB_DB, userId);
	return json({ daily_cards: daily, options: DAILY_CARD_OPTIONS });
}

/** Изменение настроек: POST /api/settings { daily_cards }. */
async function handleSetSettings(env: Env, userId: number, request: Request): Promise<Response> {
	let body: { daily_cards?: number };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "невалидный JSON" }, 400);
	}
	const n = Number(body.daily_cards);
	if (!DAILY_CARD_OPTIONS.includes(n)) {
		return json({ error: `daily_cards ∈ ${DAILY_CARD_OPTIONS.join(", ")}` }, 400);
	}
	await setDailyCards(env.BOOK_CLUB_DB, userId, n);
	return json({ daily_cards: n });
}

/** Оценка карточки: POST /api/review { card_id, book_id, grade }. */
async function handleReview(env: Env, userId: number, request: Request): Promise<Response> {
	let body: { card_id?: string; book_id?: string; grade?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: "невалидный JSON" }, 400);
	}
	const cardId = body.card_id;
	const bookId = body.book_id;
	const grade = body.grade;
	if (!cardId || !bookId || !grade || !(grade in PLATFORM_QUALITY)) {
		return json({ error: "нужны card_id, book_id и grade (again|hard|good|easy)" }, 400);
	}

	// Композитный ключ «<book>:<cardId>» — общий с ботом (карточки по всем книгам).
	const key = cardKey(bookId, cardId);
	const now = Date.now();
	const prev =
		(await getCardProgress(env.BOOK_CLUB_DB, userId, key)) ?? initialProgress(key, now);
	const next = reviewFromQuality(prev, PLATFORM_QUALITY[grade], now);
	await saveCardProgress(env.BOOK_CLUB_DB, userId, bookId, next);
	return json({ progress: next });
}

async function handleApi(env: Env, request: Request, url: URL): Promise<Response> {
	const cors = corsFor(env, request, url);
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: cors });
	}
	const response = await routeApi(env, request, url);
	// json() ставит открытый CORS по умолчанию — на админских маршрутах
	// заменяем его на ограниченный набор (origin только из списка разрешённых).
	if (url.pathname.startsWith("/api/admin/")) {
		response.headers.delete("access-control-allow-origin");
		for (const [name, value] of Object.entries(cors)) {
			response.headers.set(name, value);
		}
	}
	return response;
}

async function routeApi(env: Env, request: Request, url: URL): Promise<Response> {
	if (url.pathname === "/api/claims" && request.method === "GET") {
		return handleClaimsApi(env);
	}

	// Платформа: вход и единый прогресс карточек (сессия из Telegram-подписи).
	if (url.pathname === "/api/auth/telegram" && request.method === "POST") {
		return handleAuthTelegram(env, request);
	}
	if (
		url.pathname === "/api/me" ||
		url.pathname === "/api/progress" ||
		url.pathname === "/api/review" ||
		url.pathname === "/api/settings" ||
		url.pathname === "/api/membership" ||
		url.pathname === "/api/claim"
	) {
		const userId = await authUser(env, request);
		if (userId === null) return json({ error: "нужен вход через Telegram" }, 401);
		if (url.pathname === "/api/me" && request.method === "GET") return handleMe(env, userId);
		if (url.pathname === "/api/membership" && request.method === "GET") {
			return handleMembership(env, userId);
		}
		if (url.pathname === "/api/membership" && request.method === "POST") {
			return handleApply(env, userId, request);
		}
		if (url.pathname === "/api/claim" && request.method === "POST") {
			return handleClaimTopic(env, userId, request);
		}
		if (url.pathname === "/api/progress" && request.method === "GET") {
			return handleProgress(env, userId);
		}
		if (url.pathname === "/api/review" && request.method === "POST") {
			return handleReview(env, userId, request);
		}
		if (url.pathname === "/api/settings" && request.method === "GET") {
			return handleGetSettings(env, userId);
		}
		if (url.pathname === "/api/settings" && request.method === "POST") {
			return handleSetSettings(env, userId, request);
		}
	}

	if (url.pathname.startsWith("/api/admin/")) {
		if (!isAdmin(env, request)) return json({ error: "нужен админ-токен" }, 401);
		if (url.pathname === "/api/admin/claims" && request.method === "GET") {
			return handleAdminClaims(env);
		}
		if (url.pathname === "/api/admin/claims" && request.method === "POST") {
			return handleAdminDecision(env, request);
		}
		if (url.pathname === "/api/admin/photo" && request.method === "GET") {
			return handleAdminPhoto(env, url);
		}
		if (url.pathname === "/api/admin/members" && request.method === "GET") {
			return handleAdminMembers(env);
		}
		if (url.pathname === "/api/admin/members" && request.method === "POST") {
			return handleAdminMemberDecision(env, request);
		}
		if (url.pathname === "/api/admin/setup" && request.method === "POST") {
			return handleAdminSetup(env);
		}
		if (url.pathname === "/api/admin/announce" && request.method === "POST") {
			return handleAdminAnnounce(env, request);
		}
		if (url.pathname === "/api/admin/posts" && request.method === "GET") {
			return handleAdminPosts(env);
		}
		if (url.pathname === "/api/admin/posts" && request.method === "POST") {
			return handleAdminPostAction(env, request);
		}
	}
	return json({ error: "не найдено" }, 404);
}

// ── Напоминания и рассылка ───────────────────────────────────────────────────

type ReminderKind = "morning" | "start";

const REMINDER_TEXT: Record<ReminderKind, string> = {
	morning: "⏰ Сегодня встреча клуба!",
	start: "🚀 Встреча начинается — подключайся!",
};

/** Шлёт записавшимся напоминание нужного вида (если ещё не отправляли). */
async function sendEventReminder(env: Env, path: string, kind: ReminderKind): Promise<void> {
	const event = await fetchEventByPath(path);
	if (!event || event.finished) return;
	if (await wasReminderSent(env.BOOK_CLUB_DB, event.id, kind)) return;

	const chatIds = await listRegistrations(env.BOOK_CLUB_DB, event.id);
	console.log(`Напоминание (${kind}) о ${event.id}: ${chatIds.length} записавшихся`);
	let delivered = 0;
	for (const chatId of chatIds) {
		try {
			await sendMessage(env.BOT_TOKEN, chatId, `${REMINDER_TEXT[kind]}\n\n${renderEventLinks(event)}`);
			delivered++;
		} catch (err) {
			console.error(`Не удалось напомнить ${chatId} о ${event.id}:`, err);
		}
	}

	// Помечаем отправленным только после цикла и хотя бы одной успешной доставки
	// (либо когда напоминать некому) — разовый сбой сети не теряет напоминание:
	// следующий запуск cron попробует ещё раз.
	if (delivered > 0 || chatIds.length === 0) {
		await markReminderSent(env.BOOK_CLUB_DB, event.id, kind);
	}
}

/** Утренние напоминания — из ежедневного cron. */
async function runMorningReminders(env: Env): Promise<void> {
	const today = mskToday();
	const index = await fetchIndex();
	for (const path of index.events) {
		if (eventDateFromPath(path) === today) {
			await sendEventReminder(env, path, "morning");
		}
	}
}

/** «Встреча началась» — из cron каждые 15 минут. */
async function runTimedReminders(env: Env): Promise<void> {
	const now = Date.now();
	const today = mskToday(now);
	const index = await fetchIndex();

	for (const path of index.events) {
		if (eventDateFromPath(path) !== today) continue;
		const event = await fetchEventByPath(path);
		if (!event) continue;
		const start = eventStartMs(event);

		// Окно шире шага cron, дубли отсекает markReminderSent.
		if (now >= start && now < start + 20 * 60 * 1000) {
			await sendEventReminder(env, path, "start");
		}
	}
}

/** Пауза между подписчиками рассылки: держит темп ниже лимита ~30 msg/s. */
const BROADCAST_DELAY_MS = 75;

/** Ежедневная рассылка карточек всем подписчикам. */
async function runDailyBroadcast(env: Env): Promise<void> {
	const subscribers = await listSubscribers(env.BOOK_CLUB_KV);
	console.log(`Ежедневная рассылка: ${subscribers.length} подписчиков`);

	let delivered = 0;
	for (const sub of subscribers) {
		try {
			const sent = await startStudy(env, sub.chatId, { intro: MORNING_INTRO });
			if (sent > 0) delivered++;
		} catch (err) {
			// Ошибка по одному подписчику (например, бот заблокирован) не должна
			// прерывать рассылку остальным.
			console.error(`Не удалось отправить карточки ${sub.chatId}:`, err);
		}
		// Троттлинг: ожидание через setTimeout не тратит CPU-время воркера.
		await new Promise((r) => setTimeout(r, BROADCAST_DELAY_MS));
	}
	console.log(`Рассылка завершена: карточки получили ${delivered} подписчиков`);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		configureApi(env);
		const url = new URL(request.url);

		// API для miniapp и CMS.
		if (url.pathname.startsWith("/api/")) {
			return handleApi(env, request, url);
		}

		// Health-check / проверка вручную.
		if (request.method === "GET") {
			return new Response("Бот «Книжного клуба» работает 🤖", {
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		// Проверка секрета вебхука — fail-closed: без WEBHOOK_SECRET вебхук
		// не работает (иначе любой может слать боту поддельные update-ы).
		if (!env.WEBHOOK_SECRET) {
			console.error(
				"КРИТИЧНО: WEBHOOK_SECRET не задан — вебхук отключён. " +
					"Задай секрет (wrangler secret put WEBHOOK_SECRET) и перерегистрируй setWebhook.",
			);
			return new Response("Webhook is not configured", { status: 500 });
		}
		const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
		if (!timingSafeEqual(secretHeader, env.WEBHOOK_SECRET)) {
			console.warn("Отклонён вебхук с неверным секретом");
			return new Response("Forbidden", { status: 403 });
		}

		let update: TelegramUpdate;
		try {
			update = (await request.json()) as TelegramUpdate;
		} catch {
			return new Response("Bad Request", { status: 400 });
		}

		// Обрабатываем update в фоне, а Telegram сразу отвечаем 200,
		// чтобы не ловить таймауты и повторные доставки.
		ctx.waitUntil(
			handleUpdate(env, update).catch((err) =>
				console.error(`Ошибка обработки update ${update.update_id}:`, err),
			),
		);

		return new Response("OK");
	},

	async scheduled(controller, env, ctx): Promise<void> {
		configureApi(env);
		// Ежедневный cron (10:00 МСК): карточки + утренние напоминания.
		if (controller.cron === "0 7 * * *") {
			ctx.waitUntil(
				runDailyBroadcast(env).catch((err) =>
					console.error("Ошибка ежедневной рассылки:", err),
				),
			);
			ctx.waitUntil(
				runMorningReminders(env).catch((err) =>
					console.error("Ошибка утренних напоминаний:", err),
				),
			);
			return;
		}
		// Каждые 5 минут: «встреча началась» тем, кто записался. Посты в группы
		// по расписанию не выходят — их публикует админ из CMS.
		ctx.waitUntil(
			runTimedReminders(env).catch((err) =>
				console.error("Ошибка напоминаний о встречах:", err),
			),
		);
	},
} satisfies ExportedHandler<Env>;
