// /today — прислать карточки для повторения прямо сейчас.

import type { TelegramMessage } from "../types";
import { sendDueCards } from "../lib/cards";
import { sendMessage } from "../lib/telegram";

export async function handleToday(env: Env, message: TelegramMessage): Promise<void> {
	const chatId = message.chat.id;

	const sent = await sendDueCards(env, chatId);

	if (sent === 0) {
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			"🎉 На сейчас карточек для повторения нет. Все повторено — возвращайся позже!",
		);
		return;
	}

	console.log(`/today: отправлено ${sent} карточек пользователю ${chatId}`);
}
