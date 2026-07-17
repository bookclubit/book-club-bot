// Регистрации через диплинки /start и связанные callback-и:
//   join_<eventId>    — запись на встречу (сразу выдаём ссылки, напомним в день встречи)
//   speaker_<eventId> — заявка на доклад: выбор темы программы или своя тема
// Брони и записи — в D1; подтверждение заявок — за админом (ADMIN_CHAT_ID).

import type { ClubEvent, InlineKeyboardMarkup, TelegramCallbackQuery, TelegramMessage, TopicRef } from "../types";
import {
	addRegistration,
	confirmClaim,
	createClaim,
	deleteClaim,
	getClaim,
	listClaims,
	popPendingTopic,
	setPendingTopic,
	type Claim,
} from "../lib/db";
import { fetchEventById, fetchEventTopics, renderEventLinks } from "../lib/events";
import { answerCallback, editMessageText, sendMessage } from "../lib/telegram";

const EVENT_NOT_FOUND =
	"Не нашёл такую встречу 🤷 Возможно, ссылка устарела — загляни в приложение клуба.";

// ── Запись на встречу ────────────────────────────────────────────────────────

export async function handleJoin(env: Env, message: TelegramMessage, eventId: string): Promise<void> {
	const chatId = message.chat.id;
	const event = await fetchEventById(eventId);
	if (!event) {
		await sendMessage(env.BOT_TOKEN, chatId, EVENT_NOT_FOUND);
		return;
	}

	await addRegistration(env.BOOK_CLUB_DB, event.id, chatId, message.from?.username);
	await sendMessage(
		env.BOT_TOKEN,
		chatId,
		`Записал! Вот всё нужное для встречи 👇\n\n${renderEventLinks(event)}\n\n` +
			"Утром в день встречи пришлю напоминание с этими же ссылками.",
	);
	console.log(`Запись на ${event.id}: ${chatId}`);
}

// ── Заявка на доклад ─────────────────────────────────────────────────────────

/** Клавиатура тем: занятые — с замком (без действия), свободные — кликабельны. */
function topicsKeyboard(eventId: string, topics: TopicRef[], claims: Claim[]): InlineKeyboardMarkup {
	const takenIds = new Set(claims.filter((c) => c.topic_id).map((c) => c.topic_id));
	const rows = topics.map((t) => [
		takenIds.has(t.id)
			? { text: `🔒 ${t.title}`, callback_data: "noop" }
			: { text: t.title, callback_data: `claim:${eventId}:${t.id}` },
	]);
	rows.push([{ text: "💡 Предложить свою тему", callback_data: `freetopic:${eventId}` }]);
	return { inline_keyboard: rows };
}

export async function handleSpeaker(env: Env, message: TelegramMessage, eventId: string): Promise<void> {
	const chatId = message.chat.id;
	const event = await fetchEventById(eventId);
	if (!event) {
		await sendMessage(env.BOT_TOKEN, chatId, EVENT_NOT_FOUND);
		return;
	}
	if (event.type !== "live-talk") {
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			"Доклады бывают на открытых эфирах, а это разбор главы 🙂 Приходи слушать!",
		);
		return;
	}

	const [topics, claims] = await Promise.all([
		fetchEventTopics(event),
		listClaims(env.BOOK_CLUB_DB, event.id),
	]);

	const intro =
		`🎤 <b>${event.title}</b> — ${event.date}\n\n` +
		(topics.length > 0
			? "Выбери тему из программы (🔒 — уже занята) или предложи свою:"
			: "Программа этого эфира ещё не расписана — предложи свою тему:");
	await sendMessage(env.BOT_TOKEN, chatId, intro, topicsKeyboard(event.id, topics, claims));
}

/** Уведомление админу о новой заявке с кнопками подтверждения. */
async function notifyAdmin(env: Env, claim: Claim, event: ClubEvent): Promise<void> {
	if (!env.ADMIN_CHAT_ID) {
		console.warn("ADMIN_CHAT_ID не задан — заявка ждёт в D1 без уведомления");
		return;
	}
	const from = claim.username ? `@${claim.username}` : `id ${claim.chat_id}`;
	await sendMessage(
		env.BOT_TOKEN,
		Number(env.ADMIN_CHAT_ID),
		`🎤 <b>Заявка на доклад</b>\n\n` +
			`Эфир: ${event.title} (${event.date})\n` +
			`Тема: <b>${claim.topic_title}</b>${claim.topic_id ? "" : " (своя, вне программы)"}\n` +
			`Спикер: ${from}`,
		{
			inline_keyboard: [
				[
					{ text: "✅ Подтвердить", callback_data: `adm:ok:${claim.id}` },
					{ text: "❌ Отклонить", callback_data: `adm:no:${claim.id}` },
				],
			],
		},
	);
}

/** Текст после создания заявки. */
const CLAIM_ACCEPTED =
	"Заявка принята 🎉 Как только админ подтвердит тему — напишу. " +
	"После подтверждения жди деталей по оформлению презентации.";

/** Нажатие на свободную тему программы: claim:<eventId>:<topicId>. */
export async function handleClaimCallback(env: Env, cb: TelegramCallbackQuery, data: string): Promise<void> {
	const message = cb.message;
	if (!message) {
		await answerCallback(env.BOT_TOKEN, cb.id);
		return;
	}
	const [, eventId, topicId] = data.split(":");
	const event = await fetchEventById(eventId);
	if (!event) {
		await answerCallback(env.BOT_TOKEN, cb.id, "Встреча не найдена");
		return;
	}

	const topics = await fetchEventTopics(event);
	const topic = topics.find((t) => t.id === topicId);
	if (!topic) {
		await answerCallback(env.BOT_TOKEN, cb.id, "Тема не найдена");
		return;
	}

	const claim = await createClaim(env.BOOK_CLUB_DB, {
		eventId: event.id,
		topicId: topic.id,
		topicTitle: topic.title,
		chatId: message.chat.id,
		username: cb.from.username,
	});

	if (!claim) {
		// Слот заняли между показом клавиатуры и нажатием — обновляем её.
		const claims = await listClaims(env.BOOK_CLUB_DB, event.id);
		await editMessageText(
			env.BOT_TOKEN,
			message.chat.id,
			message.message_id,
			`🎤 <b>${event.title}</b> — ${event.date}\n\nЭту тему только что заняли 🙈 Выбери другую:`,
			topicsKeyboard(event.id, topics, claims),
		);
		await answerCallback(env.BOT_TOKEN, cb.id, "Тему только что заняли");
		return;
	}

	await editMessageText(
		env.BOT_TOKEN,
		message.chat.id,
		message.message_id,
		`Тема «<b>${topic.title}</b>» забронирована за тобой.\n\n${CLAIM_ACCEPTED}`,
	);
	await answerCallback(env.BOT_TOKEN, cb.id, "Тема забронирована 🎉");
	await notifyAdmin(env, claim, event);
	console.log(`Бронь темы ${topic.id} (${event.id}) от ${message.chat.id}`);
}

/** Кнопка «Предложить свою тему»: freetopic:<eventId>. */
export async function handleFreeTopicCallback(env: Env, cb: TelegramCallbackQuery, data: string): Promise<void> {
	const message = cb.message;
	if (!message) {
		await answerCallback(env.BOT_TOKEN, cb.id);
		return;
	}
	const eventId = data.slice("freetopic:".length);
	await setPendingTopic(env.BOOK_CLUB_DB, message.chat.id, eventId);
	await answerCallback(env.BOT_TOKEN, cb.id);
	await sendMessage(
		env.BOT_TOKEN,
		message.chat.id,
		"Напиши тему доклада одним сообщением — я передам её админу на подтверждение ✍️",
	);
}

/**
 * Текст от пользователя, когда бот ждёт «свою тему».
 * true — сообщение обработано как тема, роутить дальше не нужно.
 */
export async function handleFreeTopicText(env: Env, message: TelegramMessage): Promise<boolean> {
	const text = message.text?.trim();
	if (!text) return false;
	const eventId = await popPendingTopic(env.BOOK_CLUB_DB, message.chat.id);
	if (!eventId) return false;

	const event = await fetchEventById(eventId);
	if (!event) {
		await sendMessage(env.BOT_TOKEN, message.chat.id, EVENT_NOT_FOUND);
		return true;
	}

	const claim = await createClaim(env.BOOK_CLUB_DB, {
		eventId: event.id,
		topicId: null,
		topicTitle: text,
		chatId: message.chat.id,
		username: message.from?.username,
	});
	if (claim) {
		await sendMessage(env.BOT_TOKEN, message.chat.id, `Тема «<b>${text}</b>» записана.\n\n${CLAIM_ACCEPTED}`);
		await notifyAdmin(env, claim, event);
	}
	return true;
}

// ── Модерация админа ─────────────────────────────────────────────────────────

/** Кнопки в уведомлении админа: adm:ok:<claimId> / adm:no:<claimId>. */
export async function handleAdminCallback(env: Env, cb: TelegramCallbackQuery, data: string): Promise<void> {
	if (!env.ADMIN_CHAT_ID || cb.from.id !== Number(env.ADMIN_CHAT_ID)) {
		await answerCallback(env.BOT_TOKEN, cb.id, "Эта кнопка только для админа");
		return;
	}
	const [, action, rawId] = data.split(":");
	const claim = await getClaim(env.BOOK_CLUB_DB, Number(rawId));
	if (!claim) {
		await answerCallback(env.BOT_TOKEN, cb.id, "Заявка не найдена (уже обработана?)");
		return;
	}

	const approved = action === "ok";
	if (approved) {
		await confirmClaim(env.BOOK_CLUB_DB, claim.id);
		await sendMessage(
			env.BOT_TOKEN,
			claim.chat_id,
			`Тема «<b>${claim.topic_title}</b>» подтверждена — ты в программе! 🎉\n` +
				"Админ свяжется с тобой по деталям презентации.",
		);
	} else {
		await deleteClaim(env.BOOK_CLUB_DB, claim.id);
		await sendMessage(
			env.BOT_TOKEN,
			claim.chat_id,
			`Заявку на тему «<b>${claim.topic_title}</b>» не подтвердили 😔 ` +
				"Можно выбрать другую тему или уточнить детали у админа.",
		);
	}

	if (cb.message) {
		await editMessageText(
			env.BOT_TOKEN,
			cb.message.chat.id,
			cb.message.message_id,
			`${approved ? "✅ Подтверждена" : "❌ Отклонена"}: «${claim.topic_title}» ` +
				`(${claim.username ? `@${claim.username}` : claim.chat_id})`,
		);
	}
	await answerCallback(env.BOT_TOKEN, cb.id, approved ? "Подтверждено" : "Отклонено");
}
