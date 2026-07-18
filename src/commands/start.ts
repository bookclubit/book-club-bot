// /start — подписка на ежедневные карточки.

import type { TelegramMessage } from "../types";
import { upsertUser } from "../lib/db";
import { saveSubscriber } from "../lib/storage";
import { sendMessage } from "../lib/telegram";

const WELCOME =
	"👋 Привет! Это <b>Книжный клуб</b> для фронтендеров.\n\n" +
	"Каждый день в 10:00 МСК я присылаю карточки для повторения по всем книгам клуба — " +
	"по одной, как в диалоге. Отвечай и отмечай, насколько легко вспомнил: " +
	"я подберу интервалы повторения по алгоритму SM-2.\n\n" +
	"Команды:\n" +
	"/today — начать повторение прямо сейчас\n" +
	"/status — твоя статистика\n" +
	"/settings — сколько карточек в день\n" +
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

	// Аккаунт платформы (единый прогресс карточек на боте и на сайте).
	await upsertUser(env.BOOK_CLUB_DB, {
		id: chatId,
		username: message.from?.username ?? null,
		firstName: message.from?.first_name ?? null,
	});

	console.log(`Новый подписчик: ${chatId} (@${message.from?.username ?? "—"})`);
	await sendMessage(env.BOT_TOKEN, chatId, WELCOME);
}
