// /status — статистика изучения по всем книгам клуба.

import type { TelegramMessage } from "../types";
import { fetchAllFlashcards } from "../lib/api";
import { cardKey, getCardProgressMap } from "../lib/db";
import { sendMessage } from "../lib/telegram";

export async function handleStatus(env: Env, message: TelegramMessage): Promise<void> {
	const chatId = message.chat.id;

	const [deck, progress] = await Promise.all([
		fetchAllFlashcards(),
		getCardProgressMap(env.BOOK_CLUB_DB, chatId),
	]);

	const now = Date.now();
	const total = deck.length;

	let started = 0;
	let overdue = 0;
	for (const d of deck) {
		const p = progress.get(cardKey(d.book, d.card.id));
		if (!p) continue;
		started++;
		if (p.dueDate <= now) overdue++;
	}
	const fresh = total - started;
	const dueNow = overdue + fresh; // просроченные среди начатых + новые
	const scheduled = started - overdue;

	const text =
		"📊 <b>Твоя статистика</b>\n" +
		"<i>Все книги клуба</i>\n\n" +
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
