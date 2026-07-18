/**
 * «Книжный клуб» — телеграм-бот книжного клуба для фронтендеров.
 * Cloudflare Worker: вебхук Telegram + cron (карточки и напоминания) +
 * небольшое HTTP API для miniapp (занятость тем) и CMS (модерация заявок).
 */

import type { TelegramMessage, TelegramUpdate } from "./types";
import { fetchEventByPath, fetchIndex } from "./lib/api";
import { sendDueCards } from "./lib/cards";
import {
	deleteSpeakerClaim,
	getSpeakerClaim,
	listRegistrations,
	listSpeakerClaims,
	markReminderSent,
	updateSpeakerClaim,
} from "./lib/db";
import { eventDateFromPath, eventStartMs, mskToday, renderEventLinks } from "./lib/events";
import { listSubscribers } from "./lib/storage";
import { getFileResponse, sendMessage, setMyCommands } from "./lib/telegram";
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

const MORNING_INTRO =
	"☀️ <b>Доброе утро!</b> Карточки на сегодня для повторения:";

const UNKNOWN_COMMAND =
	"Не знаю такой команды 🤔\n\n" +
	"Доступно:\n/start — подписка на карточки\n/today — карточки сейчас\n" +
	"/status — статистика\n/speaker — заявка на доклад\n/stop — отписка";

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
		})),
	});
}

/** Полный список заявок для CMS (админ). */
async function handleAdminClaims(env: Env): Promise<Response> {
	const claims = await listSpeakerClaims(env.BOOK_CLUB_DB);
	return json({ claims });
}

/**
 * Решение по заявке из CMS: POST /api/admin/claims
 * { id, action: "confirm" | "decline" }. Бот уведомляет спикера.
 */
async function handleAdminDecision(env: Env, request: Request): Promise<Response> {
	let body: { id?: number; action?: string };
	try {
		body = (await request.json()) as { id?: number; action?: string };
	} catch {
		return json({ error: "невалидный JSON" }, 400);
	}
	const claim = typeof body.id === "number" ? await getSpeakerClaim(env.BOOK_CLUB_DB, body.id) : null;
	if (!claim) return json({ error: "заявка не найдена" }, 404);

	if (body.action === "confirm") {
		await updateSpeakerClaim(env.BOOK_CLUB_DB, claim.id, { status: "confirmed" });
		await sendMessage(
			env.BOT_TOKEN,
			claim.chat_id,
			`Тема «<b>${claim.topic_title}</b>» подтверждена — ты в программе! 🎉\n` +
				"Админ свяжется с тобой по деталям презентации.",
		);
		return json({ ok: true });
	}
	if (body.action === "decline") {
		await deleteSpeakerClaim(env.BOOK_CLUB_DB, claim.id);
		await sendMessage(
			env.BOT_TOKEN,
			claim.chat_id,
			`Заявку на тему «<b>${claim.topic_title}</b>» не подтвердили 😔 ` +
				"Можно выбрать другую тему: /speaker",
		);
		return json({ ok: true });
	}
	return json({ error: "action: confirm | decline" }, 400);
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
	{ command: "today", description: "Карточки к повторению прямо сейчас" },
	{ command: "status", description: "Статистика изучения" },
	{ command: "speaker", description: "Выступить с докладом — выбрать тему" },
	{ command: "cancel", description: "Прервать заявку на доклад" },
	{ command: "start", description: "Подписка на ежедневные карточки" },
	{ command: "stop", description: "Отписаться от карточек" },
];

/** Регистрация команд в Telegram: POST /api/admin/setup (после их изменения). */
async function handleAdminSetup(env: Env): Promise<Response> {
	await setMyCommands(env.BOT_TOKEN, BOT_COMMANDS);
	return json({ ok: true, commands: BOT_COMMANDS.map((c) => c.command) });
}

async function handleApi(env: Env, request: Request, url: URL): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}
	if (url.pathname === "/api/claims" && request.method === "GET") {
		return handleClaimsApi(env);
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
			const sent = await sendDueCards(env, sub.chatId, { intro: MORNING_INTRO });
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
