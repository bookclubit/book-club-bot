/**
 * «Книжный клуб» — телеграм-бот книжного клуба для фронтендеров.
 * Cloudflare Worker: вебхук Telegram + cron (карточки и напоминания) +
 * небольшое HTTP API для miniapp (занятость тем) и CMS (модерация заявок).
 */

import type { TelegramMessage, TelegramUpdate } from "./types";
import { fetchEventByPath, fetchIndex } from "./lib/api";
import {
	mintSession,
	verifyInitData,
	verifyLoginWidget,
	verifySession,
	type TgUser,
} from "./lib/auth";
import {
	assignClaim,
	cardKey,
	DAILY_CARD_OPTIONS,
	deleteSpeakerClaim,
	getCardProgress,
	getCardProgressMap,
	getClaimByTopic,
	getDailyCards,
	getSpeakerClaim,
	getUser,
	listRegistrations,
	listSpeakerClaims,
	markReminderSent,
	releaseClaimByTopic,
	saveCardProgress,
	setClaimSlides,
	setDailyCards,
	updateSpeakerClaim,
	upsertUser,
} from "./lib/db";
import { reviewFromQuality } from "./lib/spaced-repetition";
import { startStudy } from "./lib/study";
import { eventDateFromPath, eventStartMs, mskToday, renderEventLinks } from "./lib/events";
import { listSubscribers } from "./lib/storage";
import { getFileResponse, sendMessage, setChatMenuButton, setMyCommands } from "./lib/telegram";
import { handleCallback } from "./handlers/callback";
import {
	handleCancel,
	handleDialogMessage,
	handleJoin,
	handleSpeaker,
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

/** Извлекает имя команды из текста: «/today@bot arg» → «today». */
function parseCommand(text: string): string | null {
	if (!text.startsWith("/")) return null;
	const first = text.trim().split(/\s+/)[0];
	return first.slice(1).split("@")[0].toLowerCase();
}

async function routeMessage(env: Env, message: TelegramMessage): Promise<void> {
	const text = message.text?.trim();

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
}

// ── HTTP API ─────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "authorization, content-type",
};

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
	});
}

function isAdmin(env: Env, request: Request): boolean {
	const header = request.headers.get("authorization") ?? "";
	return Boolean(env.ADMIN_API_TOKEN) && header === `Bearer ${env.ADMIN_API_TOKEN}`;
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

const TALKS_REPO = "https://github.com/bookclubit/book-club-talks";

/** Сообщение спикеру о старте генерации презентации: PR-ветка + инструкция. */
function talkReadyMessage(slides: string): string {
	let branch = "";
	try {
		branch = new URL(slides).hostname.split(".")[0].toUpperCase();
	} catch {
		branch = "";
	}
	// is%3Aopen — только актуальный открытый PR ветки (закрытые дубли не путают).
	const prLink = branch ? `${TALKS_REPO}/pulls?q=is%3Apr+is%3Aopen+head%3A${branch}` : `${TALKS_REPO}/pulls`;
	return (
		"🎤 Готовлю твою презентацию!\n\n" +
		"Через минуту здесь появится черновик — pull request с шаблоном по твоей теме:\n" +
		`${prLink}\n\n` +
		"<b>Как сделать презентацию:</b>\n" +
		`1. Открой PR по ссылке выше и склонируй его ветку:\n` +
		`<code>git clone -b ${branch} ${TALKS_REPO}.git</code>\n` +
		`2. Правь слайды в папке <code>talks/${branch}/</code> — файл <code>index.html</code>.\n` +
		"3. <code>git push</code> — превью в PR обновится само.\n" +
		"4. Готово? Напиши админу — он смёржит, и слайды откроются на:\n" +
		`${slides}\n\n` +
		`Шаблон и подробности: ${TALKS_REPO}#readme`
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
			await sendMessage(env.BOT_TOKEN, claim.chat_id, talkReadyMessage(body.slides_url));
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

/** Фото спикера из Telegram для CMS: GET /api/admin/photo?claim=<id>. */
async function handleAdminPhoto(env: Env, url: URL): Promise<Response> {
	const id = Number(url.searchParams.get("claim"));
	const claim = Number.isFinite(id) ? await getSpeakerClaim(env.BOOK_CLUB_DB, id) : null;
	if (!claim?.photo_file_id) return json({ error: "у заявки нет фото" }, 404);

	const file = await getFileResponse(env.BOT_TOKEN, claim.photo_file_id);
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
	{ command: "speaker", description: "Выступить с докладом — выбрать тему" },
	{ command: "cancel", description: "Прервать заявку на доклад" },
	{ command: "help", description: "Помощь и список команд" },
	{ command: "start", description: "Подписка на ежедневные карточки" },
	{ command: "stop", description: "Отписаться от карточек" },
];

/** Мини-приложение клуба (Telegram Mini App / сайт). */
const MINIAPP_URL = "https://book-club-miniapp.vercel.app";

/**
 * Настройка бота: POST /api/admin/setup — регистрирует команды меню и кнопку
 * «Открыть приложение» (Mini App). Вызывать после изменения набора команд.
 */
async function handleAdminSetup(env: Env): Promise<Response> {
	await setMyCommands(env.BOT_TOKEN, BOT_COMMANDS);
	await setChatMenuButton(env.BOT_TOKEN, "🗂 Приложение", MINIAPP_URL);
	return json({ ok: true, commands: BOT_COMMANDS.map((c) => c.command), menu_button: MINIAPP_URL });
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
	const prev = (await getCardProgress(env.BOOK_CLUB_DB, userId, key)) ?? {
		cardId: key,
		repetition: 0,
		interval: 0,
		easiness: 2.5,
		dueDate: now,
		lastReviewed: 0,
	};
	const next = reviewFromQuality(prev, PLATFORM_QUALITY[grade], now);
	await saveCardProgress(env.BOOK_CLUB_DB, userId, bookId, next);
	return json({ progress: next });
}

async function handleApi(env: Env, request: Request, url: URL): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}
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
		url.pathname === "/api/settings"
	) {
		const userId = await authUser(env, request);
		if (userId === null) return json({ error: "нужен вход через Telegram" }, 401);
		if (url.pathname === "/api/me" && request.method === "GET") return handleMe(env, userId);
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
		if (url.pathname === "/api/admin/setup" && request.method === "POST") {
			return handleAdminSetup(env);
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
	const fresh = await markReminderSent(env.BOOK_CLUB_DB, event.id, kind);
	if (!fresh) return;

	const chatIds = await listRegistrations(env.BOOK_CLUB_DB, event.id);
	console.log(`Напоминание (${kind}) о ${event.id}: ${chatIds.length} записавшихся`);
	for (const chatId of chatIds) {
		try {
			await sendMessage(env.BOT_TOKEN, chatId, `${REMINDER_TEXT[kind]}\n\n${renderEventLinks(event)}`);
		} catch (err) {
			console.error(`Не удалось напомнить ${chatId} о ${event.id}:`, err);
		}
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
	}
	console.log(`Рассылка завершена: карточки получили ${delivered} подписчиков`);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
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

		// Проверка секрета вебхука (если задан WEBHOOK_SECRET).
		if (env.WEBHOOK_SECRET) {
			const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
			if (header !== env.WEBHOOK_SECRET) {
				console.warn("Отклонён вебхук с неверным секретом");
				return new Response("Forbidden", { status: 403 });
			}
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
		// Каждые 15 минут: «встреча началась».
		ctx.waitUntil(
			runTimedReminders(env).catch((err) =>
				console.error("Ошибка напоминаний о встречах:", err),
			),
		);
	},
} satisfies ExportedHandler<Env>;
