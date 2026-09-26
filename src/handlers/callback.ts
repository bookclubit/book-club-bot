// Обработка нажатий inline-кнопок: вход на сайт и заявки на доклады.

import type { TelegramCallbackQuery } from "../types";
import { answerCallback, sendMessage } from "../lib/telegram";
import { appKeyboard } from "../lib/urls";
import { handleLoginCallback } from "./login";
import { handleApplyCallback, handleClaimCallback, handleTakenCallback } from "./registration";

/**
 * Кнопки старых карточек в чате («Показать ответ», оценки, настройка
 * карт/день): повторение переехало в приложение, кнопки в истории остались.
 */
function isLegacyStudyButton(data: string): boolean {
	return data === "sf" || data.startsWith("sg:") || data.startsWith("set:");
}

export async function handleCallback(env: Env, cb: TelegramCallbackQuery): Promise<void> {
	const data = cb.data ?? "";
	const message = cb.message;

	// Без сообщения редактировать нечего.
	if (!message) {
		await answerCallback(env.BOT_TOKEN, cb.id);
		return;
	}

	// Вход на сайт через бота (см. handlers/login.ts).
	if (data.startsWith("login:") || data.startsWith("login_no:")) {
		return handleLoginCallback(env, cb, data);
	}

	// Заявки на доклады и на участие в клубе (см. handlers/registration.ts).
	if (data.startsWith("sclaim:")) return handleClaimCallback(env, cb, data);
	if (data.startsWith("staken:")) return handleTakenCallback(env, cb, data);
	if (data === "mapply") return handleApplyCallback(env, cb);

	if (isLegacyStudyButton(data)) {
		await answerCallback(env.BOT_TOKEN, cb.id, "Карточки теперь в приложении клуба");
		await sendMessage(
			env.BOT_TOKEN,
			message.chat.id,
			"Карточки теперь проходят в приложении клуба — там колода, прогресс и статистика. " +
				"Я напоминаю, когда их пора повторить.",
			appKeyboard(env, "🗂 Открыть карточки", "/study"),
		);
		return;
	}

	// Неизвестный callback — просто убираем «часики».
	await answerCallback(env.BOT_TOKEN, cb.id);
}
