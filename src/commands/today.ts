// /today — начать повторение карточек прямо сейчас (по одной, диалогом).

import type { TelegramMessage } from "../types";
import { startStudy } from "../lib/study";
import { sendMessage } from "../lib/telegram";

export async function handleToday(env: Env, message: TelegramMessage): Promise<void> {
	const chatId = message.chat.id;

	const count = await startStudy(env, chatId);

	if (count === 0) {
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			"🎉 Карточек к повторению сейчас нет. Всё повторено — возвращайся позже!",
		);
		return;
	}

	console.log(`/today: старт сессии на ${count} карточек для ${chatId}`);
}
