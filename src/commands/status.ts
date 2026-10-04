// /status — сводка статистики изучения. Считает lib/stats.ts — та же, что
// показывает сайт; подробности (календарь, книги) — в приложении.

import type { TelegramMessage } from "../types";
import { loadUserStats } from "../lib/learning";
import { renderStatus } from "../lib/reminders";
import { sendMessage } from "../lib/telegram";
import { appKeyboard } from "../lib/urls";

export async function handleStatus(env: Env, message: TelegramMessage): Promise<void> {
	const chatId = message.chat.id;
	const stats = await loadUserStats(env.BOOK_CLUB_DB, chatId);
	await sendMessage(
		env.BOT_TOKEN,
		chatId,
		renderStatus(stats),
		appKeyboard(env, "📊 Подробная статистика", "/study"),
	);
}
