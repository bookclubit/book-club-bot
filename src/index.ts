/**
 * Codex — телеграм-бот книжного клуба для фронтендеров.
 * Cloudflare Worker: вебхук Telegram + ежедневная рассылка по cron.
 */

import type { TelegramMessage, TelegramUpdate } from "./types";
import { sendDueCards } from "./lib/cards";
import { listSubscribers } from "./lib/storage";
import { sendMessage } from "./lib/telegram";
import { handleCallback } from "./handlers/callback";
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
	switch (command) {
		case "start":
			return handleStart(env, message);
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

/** Ежедневная рассылка карточек всем подписчикам. */
async function runDailyBroadcast(env: Env): Promise<void> {
	const subscribers = await listSubscribers(env.CODEX_KV);
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
		// Health-check / проверка вручную.
		if (request.method === "GET") {
			return new Response("Codex book club bot is running 🤖", {
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
	},
} satisfies ExportedHandler<Env>;
