// /stop — выключить утренние напоминания о карточках.

import type { TelegramMessage } from "../types";
import { deleteSubscriber } from "../lib/storage";
import { sendMessage } from "../lib/telegram";

const GOODBYE =
	"Готово, напоминания о карточках больше не приходят 👋\n\n" +
	"Колода и прогресс сохранены — повторять можно в приложении клуба. " +
	"Включить напоминания снова — /start.";

export async function handleStop(env: Env, message: TelegramMessage): Promise<void> {
	const chatId = message.chat.id;

	await deleteSubscriber(env.BOOK_CLUB_KV, chatId);

	console.log(`Отписка: ${chatId}`);
	await sendMessage(env.BOT_TOKEN, chatId, GOODBYE);
}
