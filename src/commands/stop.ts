// /stop — отписка от ежедневной рассылки.

import type { TelegramMessage } from "../types";
import { deleteSubscriber } from "../lib/storage";
import { sendMessage } from "../lib/telegram";

const GOODBYE =
	"Готово, ежедневные карточки больше не приходят 👋\n\n" +
	"Твой прогресс сохранён. Вернуться можно в любой момент командой /start, " +
	"а получить карточки вручную — /today.";

export async function handleStop(env: Env, message: TelegramMessage): Promise<void> {
	const chatId = message.chat.id;

	await deleteSubscriber(env.CODEX_KV, chatId);

	console.log(`Отписка: ${chatId}`);
	await sendMessage(env.BOT_TOKEN, chatId, GOODBYE);
}
