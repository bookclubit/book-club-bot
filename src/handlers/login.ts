// Вход на сайт через бота (см. lib/login.ts): диплинк /start login_<code>
// и кнопки «Войти» / «Отмена». Подтверждение — отдельной кнопкой, а не самим
// переходом по ссылке: ссылку могли прислать, чтобы войти от чужого имени.

import type { InlineKeyboardMarkup, TelegramCallbackQuery, TelegramMessage } from "../types";
import { esc } from "../lib/announce";
import { cancelLoginRequest, upsertUser } from "../lib/db";
import { confirmLogin, isLoginCode, loginPending } from "../lib/login";
import { getSubscriber, saveSubscriber } from "../lib/storage";
import { answerCallback, editMessageText, sendMessage } from "../lib/telegram";

const EXPIRED_TEXT =
	"Ссылка для входа устарела. Нажми «Войти через Telegram» на сайте ещё раз — придёт новая.";

export const loginConfirmData = (code: string) => `login:${code}`;
export const loginCancelData = (code: string) => `login_no:${code}`;

function confirmKeyboard(code: string): InlineKeyboardMarkup {
	return {
		inline_keyboard: [
			[{ text: "✅ Войти", callback_data: loginConfirmData(code) }],
			[{ text: "Отмена", callback_data: loginCancelData(code) }],
		],
	};
}

/** Как человека видно в Telegram — чтобы было ясно, под кем он войдёт. */
function displayName(user: { first_name?: string; last_name?: string; username?: string }): string {
	const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || "участник клуба";
	return user.username ? `${name} (@${user.username})` : name;
}

/** /start login_<code> — спрашиваем подтверждение. */
export async function handleLoginStart(env: Env, message: TelegramMessage, code: string): Promise<void> {
	const chatId = message.chat.id;
	if (!isLoginCode(code) || !(await loginPending(env.BOOK_CLUB_DB, code))) {
		await sendMessage(env.BOT_TOKEN, chatId, EXPIRED_TEXT);
		return;
	}
	await sendMessage(
		env.BOT_TOKEN,
		chatId,
		"🔐 <b>Вход на сайт Книжного клуба</b>\n\n" +
			`Войти как <b>${esc(displayName(message.from ?? {}))}</b>?\n\n` +
			"Подтверждай, только если сам сейчас входишь на сайте. " +
			"Если ссылку прислал кто-то другой — нажми «Отмена».",
		confirmKeyboard(code),
	);
}

/** Кнопки «Войти» (login:<code>) и «Отмена» (login_no:<code>). */
export async function handleLoginCallback(
	env: Env,
	cb: TelegramCallbackQuery,
	data: string,
): Promise<void> {
	const message = cb.message;
	if (!message) return void (await answerCallback(env.BOT_TOKEN, cb.id));
	const chatId = message.chat.id;

	if (data.startsWith("login_no:")) {
		const code = data.slice("login_no:".length);
		if (isLoginCode(code)) await cancelLoginRequest(env.BOOK_CLUB_DB, code);
		await editMessageText(env.BOT_TOKEN, chatId, message.message_id, "Вход отменён.");
		await answerCallback(env.BOT_TOKEN, cb.id);
		return;
	}

	const code = data.slice("login:".length);
	// Сначала — записи в D1: сайт ждёт именно их, сообщения Telegram вторичны.
	// Профиль — до подтверждения: сайт забирает сессию сразу после него, и
	// у новичка аккаунта к этому моменту ещё не было бы.
	await upsertUser(env.BOOK_CLUB_DB, {
		id: cb.from.id,
		username: cb.from.username ?? null,
		firstName: cb.from.first_name ?? null,
		lastName: cb.from.last_name ?? null,
	});
	const confirmed = isLoginCode(code) && (await confirmLogin(env.BOOK_CLUB_DB, code, cb.from.id));
	if (!confirmed) {
		await editMessageText(env.BOT_TOKEN, chatId, message.message_id, EXPIRED_TEXT);
		await answerCallback(env.BOT_TOKEN, cb.id);
		return;
	}
	// Вошедший через бота ждёт от него напоминаний — как после /start.
	const subscribed = await getSubscriber(env.BOOK_CLUB_KV, cb.from.id);
	if (!subscribed) {
		await saveSubscriber(env.BOOK_CLUB_KV, {
			chatId: cb.from.id,
			firstName: cb.from.first_name,
			username: cb.from.username,
			subscribedAt: Date.now(),
		});
	}

	await editMessageText(
		env.BOT_TOKEN,
		chatId,
		message.message_id,
		"✅ <b>Вход подтверждён.</b> Возвращайся на сайт — вход завершится сам.\n\n" +
			"Колода, прогресс и статистика теперь общие для сайта и приложения в Telegram. " +
			"Когда карточки из колоды пора повторить, я напомню в 10:00 МСК" +
			(subscribed ? "." : " — выключить: /stop."),
	);
	await answerCallback(env.BOT_TOKEN, cb.id, "Готово 👍");
}
