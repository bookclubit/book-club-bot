// /start — подписка на ежедневные карточки.

import type { TelegramMessage } from "../types";
import { saveSubscriber } from "../lib/storage";
import { sendMessage } from "../lib/telegram";

const WELCOME =
	"👋 Привет! Это <b>Книжный клуб</b> для фронтендеров.\n\n" +
	"Каждый день в 10:00 МСК я буду присылать тебе карточки для повторения по книге " +
	"<b>«Docker. Вводный курс»</b>. Отвечай на них и отмечай, насколько легко было вспомнить — " +
	"я подберу интервалы повторения по алгоритму SM-2.\n\n" +
	"Команды:\n" +
	"/today — 5 карточек прямо сейчас\n" +
	"/status — твоя статистика\n" +
	"/speaker — выступить с докладом (выбор темы из плана)\n" +
	"/cancel — прервать заявку на доклад\n" +
	"/stop — отписаться от карточек\n\n" +
	"Записаться на встречу и посмотреть план можно в приложении клуба — " +
	"кнопки «Пойду» и «Стать спикером» ведут сюда.\n\n" +
	"Подписка оформлена ✅";

export async function handleStart(env: Env, message: TelegramMessage): Promise<void> {
	const chatId = message.chat.id;

	await saveSubscriber(env.BOOK_CLUB_KV, {
		chatId,
		firstName: message.from?.first_name,
		username: message.from?.username,
		subscribedAt: Date.now(),
	});

	console.log(`Новый подписчик: ${chatId} (@${message.from?.username ?? "—"})`);
	await sendMessage(env.BOT_TOKEN, chatId, WELCOME);
}
