// Обработка нажатий inline-кнопок: повторение карточек (по одной) и настройки.

import type { Grade, TelegramCallbackQuery } from "../types";
import { DAILY_CARD_OPTIONS, setDailyCards } from "../lib/db";
import { handleStudyFlip, handleStudyGrade } from "../lib/study";
import { answerCallback, editMessageText } from "../lib/telegram";
import {
	handleClaimCallback,
	handleCustomTopicCallback,
	handleExperienceCallback,
	handleSpeakerPickCallback,
	handleTakenCallback,
} from "./registration";

const VALID_GRADES: readonly Grade[] = ["again", "hard", "easy"];

export async function handleCallback(env: Env, cb: TelegramCallbackQuery): Promise<void> {
	const data = cb.data ?? "";
	const message = cb.message;

	// Без сообщения редактировать нечего.
	if (!message) {
		await answerCallback(env.BOT_TOKEN, cb.id);
		return;
	}

	// Заявки на доклады (см. handlers/registration.ts).
	if (data.startsWith("sclaim:")) return handleClaimCallback(env, cb, data);
	if (data.startsWith("staken:")) return handleTakenCallback(env, cb, data);
	if (data === "scustom") return handleCustomTopicCallback(env, cb);
	if (data === "sexp_y" || data === "sexp_n") return handleExperienceCallback(env, cb, data === "sexp_y");
	if (data.startsWith("spick:")) return handleSpeakerPickCallback(env, cb, data);

	// Повторение карточек (текущая карточка — из сессии в D1).
	if (data === "sf") return handleStudyFlip(env, cb);
	if (data.startsWith("sg:")) {
		const grade = data.slice("sg:".length) as Grade;
		if (!VALID_GRADES.includes(grade)) {
			await answerCallback(env.BOT_TOKEN, cb.id, "Неизвестная оценка");
			return;
		}
		return handleStudyGrade(env, cb, grade);
	}

	// Настройки: set:<n> — сколько карточек в день.
	if (data.startsWith("set:")) {
		const n = Number(data.slice("set:".length));
		if (!DAILY_CARD_OPTIONS.includes(n)) {
			await answerCallback(env.BOT_TOKEN, cb.id, "Недопустимое значение");
			return;
		}
		await setDailyCards(env.BOOK_CLUB_DB, message.chat.id, n);
		await editMessageText(
			env.BOT_TOKEN,
			message.chat.id,
			message.message_id,
			`⚙️ <b>Настройки</b>\n\nКарточек в день: <b>${n}</b>\n\nИзменить: /settings`,
		);
		await answerCallback(env.BOT_TOKEN, cb.id, "Сохранено 👍");
		return;
	}

	// Неизвестный callback — просто убираем «часики».
	await answerCallback(env.BOT_TOKEN, cb.id);
}
