// Обработка нажатий inline-кнопок: «Показать ответ» и оценка (Забыл/Сложно/Легко).

import type { Grade, TelegramCallbackQuery } from "../types";
import { BOOK_ID } from "../types";
import { fetchFlashcards } from "../lib/api";
import { gradeKeyboard, renderBack } from "../lib/cards";
import { getCardProgress, saveCardProgress } from "../lib/db";
import { calculateNextReview } from "../lib/spaced-repetition";
import { answerCallback, editMessageText } from "../lib/telegram";
import {
	handleClaimCallback,
	handleCustomTopicCallback,
	handleTakenCallback,
} from "./registration";

const VALID_GRADES: readonly Grade[] = ["again", "hard", "easy"];

/** Русское склонение слова «день». */
function pluralizeDays(n: number): string {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod10 === 1 && mod100 !== 11) return "день";
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
	return "дней";
}

export async function handleCallback(env: Env, cb: TelegramCallbackQuery): Promise<void> {
	const data = cb.data ?? "";
	const message = cb.message;

	// Без сообщения редактировать нечего (например, старый инлайн-режим).
	if (!message) {
		await answerCallback(env.BOT_TOKEN, cb.id);
		return;
	}

	// Заявки на доклады (см. handlers/registration.ts).
	if (data.startsWith("sclaim:")) return handleClaimCallback(env, cb, data);
	if (data.startsWith("staken:")) return handleTakenCallback(env, cb, data);
	if (data === "scustom") return handleCustomTopicCallback(env, cb);

	const chatId = message.chat.id;
	const messageId = message.message_id;

	// show:<cardId> — раскрыть ответ.
	if (data.startsWith("show:")) {
		const cardId = data.slice("show:".length);
		const cards = await fetchFlashcards(BOOK_ID);
		const card = cards.find((c) => c.id === cardId);

		if (!card) {
			await answerCallback(env.BOT_TOKEN, cb.id, "Карточка не найдена 🤷");
			return;
		}

		await editMessageText(
			env.BOT_TOKEN,
			chatId,
			messageId,
			renderBack(card),
			gradeKeyboard(cardId),
		);
		await answerCallback(env.BOT_TOKEN, cb.id);
		return;
	}

	// grade:<cardId>:<grade> — оценить и пересчитать интервал (SM-2).
	if (data.startsWith("grade:")) {
		const rest = data.slice("grade:".length);
		const sep = rest.lastIndexOf(":");
		const cardId = rest.slice(0, sep);
		const grade = rest.slice(sep + 1) as Grade;

		if (!VALID_GRADES.includes(grade)) {
			await answerCallback(env.BOT_TOKEN, cb.id, "Неизвестная оценка");
			return;
		}

		const cards = await fetchFlashcards(BOOK_ID);
		const card = cards.find((c) => c.id === cardId);
		if (!card) {
			await answerCallback(env.BOT_TOKEN, cb.id, "Карточка не найдена 🤷");
			return;
		}

		const now = Date.now();
		const prev = (await getCardProgress(env.BOOK_CLUB_DB, chatId, cardId)) ?? undefined;
		const prevWithId = prev ?? {
			cardId,
			repetition: 0,
			interval: 0,
			easiness: 2.5,
			dueDate: now,
			lastReviewed: 0,
		};
		const next = calculateNextReview(prevWithId, grade, now);
		await saveCardProgress(env.BOOK_CLUB_DB, chatId, BOOK_ID, next);

		const days = next.interval;
		const nextLine = `\n\n✅ <i>Оценка сохранена. Следующее повторение через ${days} ${pluralizeDays(days)}.</i>`;

		// Убираем кнопки, оставляем ответ и подпись о следующем повторении.
		await editMessageText(env.BOT_TOKEN, chatId, messageId, renderBack(card) + nextLine);
		await answerCallback(env.BOT_TOKEN, cb.id, "Записал 👍");

		console.log(`Оценка ${grade} по ${cardId} от ${chatId}; след. интервал ${days} дн.`);
		return;
	}

	// Неизвестный callback — просто подтверждаем, чтобы убрать «часики».
	await answerCallback(env.BOT_TOKEN, cb.id);
}
