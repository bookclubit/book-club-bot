// /today — что сейчас ждёт повторения. Сами карточки — в приложении клуба,
// бот показывает сводку по колоде и кнопку, открывающую повторение.

import type { TelegramMessage } from "../types";
import { loadDueBooks } from "../lib/learning";
import {
	ALL_DONE_TEXT,
	EMPTY_DECK_TEXT,
	renderDueCards,
	STUDY_BUTTON,
	STUDY_PATH,
} from "../lib/reminders";
import { sendMessage } from "../lib/telegram";
import { appKeyboard } from "../lib/urls";

export async function handleToday(env: Env, message: TelegramMessage): Promise<void> {
	const chatId = message.chat.id;
	const { empty, due } = await loadDueBooks(env.BOOK_CLUB_DB, chatId);

	if (empty) {
		await sendMessage(env.BOT_TOKEN, chatId, EMPTY_DECK_TEXT, appKeyboard(env, "📚 Выбрать книги", "/books"));
		return;
	}
	if (due.length === 0) {
		await sendMessage(env.BOT_TOKEN, chatId, ALL_DONE_TEXT, appKeyboard(env, "🗂 Открыть карточки", "/study"));
		return;
	}
	await sendMessage(env.BOT_TOKEN, chatId, renderDueCards(due), appKeyboard(env, STUDY_BUTTON, STUDY_PATH));
}
