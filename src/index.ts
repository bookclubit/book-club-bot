/**
 * «Книжный клуб» — телеграм-бот книжного клуба для фронтендеров.
 * Cloudflare Worker: вебхук Telegram + ежедневная рассылка по cron.
 */

import type { TelegramMessage, TelegramUpdate } from "./types";
import { fetchEventByPath, fetchIndex } from "./lib/api";
import { sendDueCards } from "./lib/cards";
import { listClaims, listRegistrations } from "./lib/db";
import { eventDateFromPath, renderEventLinks } from "./lib/events";
import { listSubscribers } from "./lib/storage";
import { sendMessage } from "./lib/telegram";
import { handleCallback } from "./handlers/callback";
import {
	handleFreeTopicText,
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
	"Доступно:\n/start — подписка\n/today — карточки сейчас\n/status — статистика\n/stop — отписка";

/** Извлекает имя команды из текста: «/today@bot arg» → «today». */
function parseCommand(text: string): string | null {
	if (!text.startsWith("/")) return null;
	const first = text.trim().split(/\s+/)[0];
	return first.slice(1).split("@")[0].toLowerCase();
}

async function routeMessage(env: Env, message: TelegramMessage): Promise<void> {
	const text = message.text?.trim();
	if (!text) return;

	const command = parseCommand(text);

	// Обычный текст: возможно, бот ждёт «свою тему» доклада.
	if (command === null) {
		if (await handleFreeTopicText(env, message)) return;
		await sendMessage(env.BOT_TOKEN, message.chat.id, UNKNOWN_COMMAND);
		return;
	}

	switch (command) {
		case "start": {
			// Диплинки: /start join_<eventId> — запись на встречу,
			// /start speaker_<eventId> — заявка на доклад.
			const payload = text.split(/\s+/)[1] ?? "";
			if (payload.startsWith("join_")) {
				return handleJoin(env, message, payload.slice("join_".length));
			}
			if (payload.startsWith("speaker_")) {
				return handleSpeaker(env, message, payload.slice("speaker_".length));
			}
			return handleStart(env, message);
		}
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

/**
 * Занятость тем для miniapp: GET /api/claims?event=<eventId>.
 * Публичные данные (какие темы заняты), CORS открыт.
 */
async function handleClaimsApi(env: Env, url: URL): Promise<Response> {
	const headers = {
		"content-type": "application/json; charset=utf-8",
		"access-control-allow-origin": "*",
	};
	const eventId = url.searchParams.get("event");
	if (!eventId) {
		return new Response(JSON.stringify({ error: "нужен параметр ?event=<eventId>" }), {
			status: 400,
			headers,
		});
	}
	const claims = await listClaims(env.BOOK_CLUB_DB, eventId);
	return new Response(
		JSON.stringify({
			event: eventId,
			claims: claims.map((c) => ({ topic_id: c.topic_id, status: c.status })),
		}),
		{ headers },
	);
}

/** Напоминания записавшимся: сегодня (МСК) день встречи → шлём ссылки. */
async function runEventReminders(env: Env): Promise<void> {
	const mskToday = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
	const index = await fetchIndex();

	for (const path of index.events) {
		if (eventDateFromPath(path) !== mskToday) continue;
		const event = await fetchEventByPath(path);
		if (!event) continue;
		const chatIds = await listRegistrations(env.BOOK_CLUB_DB, event.id);
		console.log(`Напоминание о ${event.id}: ${chatIds.length} записавшихся`);
		for (const chatId of chatIds) {
			try {
				await sendMessage(
					env.BOT_TOKEN,
					chatId,
					`⏰ Сегодня встреча клуба!\n\n${renderEventLinks(event)}`,
				);
			} catch (err) {
				console.error(`Не удалось напомнить ${chatId} о ${event.id}:`, err);
			}
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
		if (request.method === "GET") {
			const url = new URL(request.url);
			// Занятость тем докладов — для miniapp.
			if (url.pathname === "/api/claims") {
				return handleClaimsApi(env, url);
			}
			// Health-check / проверка вручную.
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
		ctx.waitUntil(
			runDailyBroadcast(env).catch((err) =>
				console.error("Ошибка ежедневной рассылки:", err),
			),
		);
		ctx.waitUntil(
			runEventReminders(env).catch((err) =>
				console.error("Ошибка напоминаний о встречах:", err),
			),
		);
	},
} satisfies ExportedHandler<Env>;
