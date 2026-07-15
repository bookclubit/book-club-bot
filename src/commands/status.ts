// /status — статистика изучения.

import type { TelegramMessage } from "../types";
import { BOOK_ID } from "../types";
import { fetchFlashcards } from "../lib/api";
import { getProgressMap } from "../lib/storage";
import { sendMessage } from "../lib/telegram";

export async function handleStatus(env: Env, message: TelegramMessage): Promise<void> {
	const chatId = message.chat.id;

	const [cards, progress] = await Promise.all([
		fetchFlashcards(BOOK_ID),
		getProgressMap(env.BOOK_CLUB_KV, chatId),
	]);

	const now = Date.now();
	const total = cards.length;
	const started = progress.size;
	const fresh = total - started;

	// Просроченные среди начатых + новые = ждут повторения.
	let overdueStarted = 0;
	for (const p of progress.values()) {
		if (p.dueDate <= now) overdueStarted++;
	}
	const dueNow = overdueStarted + fresh;
	const scheduled = started - overdueStarted;

	const text =
		"📊 <b>Твоя статистика</b>\n" +
		"<i>Docker. Вводный курс</i>\n\n" +
		`📚 Всего карточек: <b>${total}</b>\n` +
		`✅ В работе: <b>${started}</b>\n` +
		`🆕 Новых: <b>${fresh}</b>\n` +
		`🔁 Ждут повторения: <b>${dueNow}</b>\n` +
		`💤 На потом: <b>${scheduled}</b>\n\n` +
		(dueNow > 0
			? "Готов повторять? Жми /today 👇"
			: "Всё повторено на сегодня — так держать! 🎉");

	await sendMessage(env.BOT_TOKEN, chatId, text);
}
