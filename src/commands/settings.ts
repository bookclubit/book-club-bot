// /settings — настройки пользователя (пока: сколько карточек в день).

import type { InlineKeyboardMarkup, TelegramMessage } from "../types";
import { DAILY_CARD_OPTIONS, getDailyCards } from "../lib/db";
import { sendMessage } from "../lib/telegram";

function dailyKeyboard(current: number): InlineKeyboardMarkup {
	return {
		inline_keyboard: [
			DAILY_CARD_OPTIONS.map((n) => ({
				text: n === current ? `✅ ${n}` : String(n),
				callback_data: `set:${n}`,
			})),
		],
	};
}

export async function handleSettings(env: Env, message: TelegramMessage): Promise<void> {
	const chatId = message.chat.id;
	const daily = await getDailyCards(env.BOOK_CLUB_DB, chatId);
	await sendMessage(
		env.BOT_TOKEN,
		chatId,
		`⚙️ <b>Настройки</b>\n\nСколько карточек присылать в день?\nСейчас: <b>${daily}</b>`,
		dailyKeyboard(daily),
	);
}
