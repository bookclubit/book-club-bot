// /start — знакомство и напоминания о карточках. Диплинки (/start join_…,
// speaker, login_…) разбирает index.ts.

import type { TelegramMessage } from "../types";
import { upsertUser } from "../lib/db";
import { saveSubscriber } from "../lib/storage";
import { sendMessage } from "../lib/telegram";
import { appKeyboard } from "../lib/urls";

const WELCOME =
	"👋 Привет! Это <b>Книжный клуб</b> для фронтендеров.\n\n" +
	"Карточки для повторения — в приложении клуба: добавь книги в колоду " +
	"и повторяй по алгоритму SM-2. А я напомню в 10:00 МСК, если в колоде " +
	"есть карточки к повторению.\n\n" +
	"Команды:\n" +
	"/today — что сейчас ждёт повторения\n" +
	"/status — твоя статистика\n" +
	"/speaker — выступить с докладом (выбор темы из плана)\n" +
	"/cancel — прервать заявку на доклад\n" +
	"/help — помощь и все команды\n" +
	"/stop — выключить напоминания\n\n" +
	"Записаться на встречу и посмотреть план можно в приложении клуба — " +
	"кнопки «Пойду» и «Стать спикером» ведут сюда.\n\n" +
	"Напоминания включены ✅";

/** Подписка на утренние напоминания о карточках (KV, см. lib/reminders.ts). */
export async function subscribeReminders(env: Env, message: TelegramMessage): Promise<void> {
	await saveSubscriber(env.BOOK_CLUB_KV, {
		chatId: message.chat.id,
		firstName: message.from?.first_name,
		username: message.from?.username,
		subscribedAt: Date.now(),
	});
}

export async function handleStart(env: Env, message: TelegramMessage): Promise<void> {
	const chatId = message.chat.id;

	await subscribeReminders(env, message);

	// Аккаунт платформы: колода, прогресс и статистика общие с сайтом.
	await upsertUser(env.BOOK_CLUB_DB, {
		id: chatId,
		username: message.from?.username ?? null,
		firstName: message.from?.first_name ?? null,
		lastName: message.from?.last_name ?? null,
	});

	console.log(`Новый подписчик: ${chatId} (@${message.from?.username ?? "—"})`);
	await sendMessage(env.BOT_TOKEN, chatId, WELCOME, appKeyboard(env, "🗂 Открыть приложение"));
}
