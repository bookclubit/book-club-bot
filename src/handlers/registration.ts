// Запись на встречи и заявки спикеров.
//
// «Пойду» (диплинк /start join_<eventId>): запись в D1, сразу ссылки,
// напоминания — утром в день встречи и в начале встречи (cron).
//
// «Стать спикером» (/speaker или диплинк /start speaker): НЕ привязан
// к встрече. Темы — из плана (главы активных книг будущих встреч, кроме
// ближайшей), занятые помечены. Диалог: тема → ФИО → фото. Модерация —
// в CMS (боту админ ничего не жмёт, только получает уведомление со ссылкой).

import type { InlineKeyboardMarkup, TelegramCallbackQuery, TelegramMessage } from "../types";
import {
	addRegistration,
	clearDialog,
	createSpeakerClaim,
	getDialog,
	getSpeakerClaim,
	listSpeakerClaims,
	setDialog,
	updateSpeakerClaim,
	type SpeakerClaim,
} from "../lib/db";
import { fetchEventById, renderEventLinks } from "../lib/events";
import { fetchPlanTopics, type PlanTopic } from "../lib/plan";
import { answerCallback, editMessageText, sendMessage } from "../lib/telegram";

/** Страница модерации заявок в CMS (уведомление админу ведёт сюда). */
const CMS_CLAIMS_URL = "https://book-club-cms.vercel.app/claims";

// ── Запись на встречу ────────────────────────────────────────────────────────

export async function handleJoin(env: Env, message: TelegramMessage, eventId: string): Promise<void> {
	const chatId = message.chat.id;
	const event = await fetchEventById(eventId);
	if (!event) {
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			"Не нашёл такую встречу 🤷 Возможно, ссылка устарела — загляни в приложение клуба.",
		);
		return;
	}

	await addRegistration(env.BOOK_CLUB_DB, event.id, chatId, message.from?.username);
	await sendMessage(
		env.BOT_TOKEN,
		chatId,
		`Записал! Вот всё нужное для встречи 👇\n\n${renderEventLinks(event)}\n\n` +
			"Напомню утром в день встречи и когда начнётся.",
	);
	console.log(`Запись на ${event.id}: ${chatId}`);
}

// ── Заявка спикера: выбор темы ───────────────────────────────────────────────

// Свободные темы: не занятые заявкой (D1) и не назначенные админом в CMS.
function freeTopics(topics: PlanTopic[], claims: SpeakerClaim[]): PlanTopic[] {
	const taken = new Set(claims.filter((c) => c.topic_id).map((c) => c.topic_id));
	return topics.filter((t) => !t.takenByCms && !taken.has(t.topic.id));
}

function speakerKeyboard(free: PlanTopic[]): InlineKeyboardMarkup {
	const rows = free.map((t) => [{ text: t.topic.title, callback_data: `sclaim:${t.topic.id}` }]);
	rows.push([{ text: "💡 Предложить свою тему", callback_data: "scustom" }]);
	return { inline_keyboard: rows };
}

function speakerIntro(free: PlanTopic[]): string {
	if (free.length === 0) {
		return (
			"🎤 Хочешь выступить — отлично!\n\n" +
			"Свободных тем в плане сейчас нет — предложи свою:"
		);
	}
	const books = [...new Set(free.map((t) => t.bookTitle))].join(", ");
	return (
		"🎤 Хочешь выступить — отлично!\n\n" +
		`Свободные темы из плана (${books}). На ближайшую встречу темы не выдаются — программа свёрстана.`
	);
}

export async function handleSpeaker(env: Env, message: TelegramMessage): Promise<void> {
	const [topics, claims] = await Promise.all([
		fetchPlanTopics(),
		listSpeakerClaims(env.BOOK_CLUB_DB),
	]);
	const free = freeTopics(topics, claims);
	await sendMessage(env.BOT_TOKEN, message.chat.id, speakerIntro(free), speakerKeyboard(free));
}

/** Уведомление админу: только информирование + ссылка на модерацию в CMS. */
async function notifyAdmin(env: Env, claim: SpeakerClaim): Promise<void> {
	if (!env.ADMIN_CHAT_ID) {
		console.warn("ADMIN_CHAT_ID не задан — заявка ждёт в CMS без уведомления");
		return;
	}
	const from = [claim.full_name, claim.username ? `@${claim.username}` : null]
		.filter(Boolean)
		.join(", ");
	await sendMessage(
		env.BOT_TOKEN,
		Number(env.ADMIN_CHAT_ID),
		`🎤 <b>Новая заявка на доклад</b>\n\n` +
			`Тема: <b>${claim.topic_title}</b>${claim.topic_id ? "" : " (своя, вне плана)"}\n` +
			`Спикер: ${from || `id ${claim.chat_id}`}\n` +
			`Фото: ${claim.photo_file_id ? "есть" : "нет"}\n\n` +
			`Подтвердить или отклонить: ${CMS_CLAIMS_URL}`,
	);
}

/** Нажатие на свободную тему плана: sclaim:<topicId>. */
export async function handleClaimCallback(env: Env, cb: TelegramCallbackQuery, data: string): Promise<void> {
	const message = cb.message;
	if (!message) {
		await answerCallback(env.BOT_TOKEN, cb.id);
		return;
	}
	const topicId = data.slice("sclaim:".length);
	const topics = await fetchPlanTopics();
	const plan = topics.find((t) => t.topic.id === topicId);
	if (!plan) {
		await answerCallback(env.BOT_TOKEN, cb.id, "Тема уже не в плане");
		return;
	}

	const claim = await createSpeakerClaim(env.BOOK_CLUB_DB, {
		topicId: plan.topic.id,
		topicTitle: plan.topic.title,
		bookId: plan.bookId,
		chapter: plan.chapterSlug,
		chatId: message.chat.id,
		username: cb.from.username,
	});

	if (!claim) {
		// Тему заняли между показом клавиатуры и нажатием — обновляем её.
		const claims = await listSpeakerClaims(env.BOOK_CLUB_DB);
		await editMessageText(
			env.BOT_TOKEN,
			message.chat.id,
			message.message_id,
			"Эту тему только что заняли 🙈 Выбери другую:",
			speakerKeyboard(freeTopics(topics, claims)),
		);
		await answerCallback(env.BOT_TOKEN, cb.id, "Тему только что заняли");
		return;
	}

	await setDialog(env.BOOK_CLUB_DB, message.chat.id, "name", claim.id);
	await editMessageText(
		env.BOT_TOKEN,
		message.chat.id,
		message.message_id,
		`Тема «<b>${plan.topic.title}</b>» забронирована за тобой 🎉\n\n` +
			"Теперь напиши имя и фамилию — так тебя объявим в программе:",
	);
	await answerCallback(env.BOT_TOKEN, cb.id, "Тема забронирована");
}

/** Нажатие на занятую тему: staken:<topicId> — показываем, кем занята. */
export async function handleTakenCallback(env: Env, cb: TelegramCallbackQuery, data: string): Promise<void> {
	const topicId = data.slice("staken:".length);
	const claims = await listSpeakerClaims(env.BOOK_CLUB_DB);
	const claim = claims.find((c) => c.topic_id === topicId);
	const who = claim ? (claim.full_name ?? (claim.username ? `@${claim.username}` : "участник клуба")) : "";
	await answerCallback(
		env.BOT_TOKEN,
		cb.id,
		claim
			? `Тема занята: ${who}${claim.status === "pending" ? " (заявка на модерации)" : ""}`
			: "Тема свободна — обнови клавиатуру командой /speaker",
	);
}

/** Кнопка «Предложить свою тему»: scustom. */
export async function handleCustomTopicCallback(env: Env, cb: TelegramCallbackQuery): Promise<void> {
	const message = cb.message;
	if (!message) {
		await answerCallback(env.BOT_TOKEN, cb.id);
		return;
	}
	await setDialog(env.BOOK_CLUB_DB, message.chat.id, "custom_topic", null);
	await answerCallback(env.BOT_TOKEN, cb.id);
	await sendMessage(env.BOT_TOKEN, message.chat.id, "Напиши тему доклада одним сообщением ✍️");
}

// ── Диалог заявки (тема → ФИО → фото) ────────────────────────────────────────

/**
 * Сообщение пользователя, когда идёт диалог заявки.
 * true — сообщение обработано, роутить дальше не нужно.
 */
export async function handleDialogMessage(env: Env, message: TelegramMessage): Promise<boolean> {
	const chatId = message.chat.id;
	const dialog = await getDialog(env.BOOK_CLUB_DB, chatId);
	if (!dialog) return false;

	const text = message.text?.trim();

	if (dialog.step === "custom_topic") {
		if (!text) return false;
		const claim = await createSpeakerClaim(env.BOOK_CLUB_DB, {
			topicId: null,
			topicTitle: text,
			chatId,
			username: message.from?.username,
		});
		if (!claim) return true;
		await setDialog(env.BOOK_CLUB_DB, chatId, "name", claim.id);
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			`Тема «<b>${text}</b>» записана.\n\nТеперь напиши имя и фамилию:`,
		);
		return true;
	}

	if (dialog.step === "name") {
		if (!text) return false;
		if (dialog.claim_id !== null) {
			await updateSpeakerClaim(env.BOOK_CLUB_DB, dialog.claim_id, { fullName: text });
		}
		await setDialog(env.BOOK_CLUB_DB, chatId, "photo", dialog.claim_id);
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			"И последнее: пришли своё фото для аватарки 📸 (или напиши /skip — добавим позже).",
		);
		return true;
	}

	// step === "photo": ждём фото или /skip.
	const photo = message.photo?.at(-1);
	if (!photo && text !== "/skip") return false;
	if (photo && dialog.claim_id !== null) {
		await updateSpeakerClaim(env.BOOK_CLUB_DB, dialog.claim_id, { photoFileId: photo.file_id });
	}
	await clearDialog(env.BOOK_CLUB_DB, chatId);

	const claim = dialog.claim_id !== null ? await getSpeakerClaim(env.BOOK_CLUB_DB, dialog.claim_id) : null;
	await sendMessage(
		env.BOT_TOKEN,
		chatId,
		"Заявка отправлена админу 🎉 Как только её подтвердят — напишу. Спасибо, что выступаешь!",
	);
	if (claim) await notifyAdmin(env, claim);
	return true;
}

/** /cancel — прервать диалог заявки. */
export async function handleCancel(env: Env, message: TelegramMessage): Promise<void> {
	await clearDialog(env.BOOK_CLUB_DB, message.chat.id);
	await sendMessage(env.BOT_TOKEN, message.chat.id, "Ок, отменил. Начать заново — /speaker");
}
