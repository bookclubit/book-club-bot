// Запись на встречи, заявки на участие в клубе и брони тем докладов.
//
// «Пойду» (диплинк /start join_<eventId>): запись в D1, сразу ссылки,
// напоминания — утром в день встречи и в начале встречи (cron). Открыто всем.
//
// «Стать спикером» (/speaker или диплинк /start speaker): темы берут только
// участники клуба (каталог спикеров или одобренная заявка — см. lib/members.ts).
// Новый человек отправляет заявку на участие: имя → рассказ о себе → фото.
// Модерация — в CMS (боту админ ничего не жмёт, только получает уведомление).

import type { InlineKeyboardMarkup, TelegramCallbackQuery, TelegramMessage } from "../types";
import {
	addRegistration,
	clearDialog,
	createSpeakerClaim,
	dialogDraft,
	getDialog,
	getSpeakerClaim,
	listSpeakerClaims,
	saveMembershipRequest,
	saveSpeakerIdentity,
	setDialog,
	updateSpeakerClaim,
	type MembershipRequest,
	type SpeakerClaim,
} from "../lib/db";
import { esc } from "../lib/announce";
import { fetchEventById, renderEventLinks } from "../lib/events";
import { speakerAccess, type SpeakerAccess } from "../lib/members";
import { fetchPlanTopics, type PlanTopic } from "../lib/plan";
import { answerCallback, editMessageText, sendMessage } from "../lib/telegram";

/**
 * Страница модерации заявок в CMS (уведомление админу ведёт сюда).
 * Перекрывается переменной env CMS_CLAIMS_URL; фолбэк — текущий адрес.
 */
export const DEFAULT_CMS_CLAIMS_URL = "https://book-club-cms.vercel.app/claims";

const cmsClaimsUrl = (env: Env): string => env.CMS_CLAIMS_URL || DEFAULT_CMS_CLAIMS_URL;

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

// ── Заявка на участие в клубе ────────────────────────────────────────────────

/** Кнопка заявки: у ждущей решения — «дополнить», у новой — «отправить». */
function applyKeyboard(request: MembershipRequest | null): InlineKeyboardMarkup {
	const text = request && request.status !== "approved" ? "✏️ Дополнить заявку" : "📝 Отправить заявку";
	return { inline_keyboard: [[{ text, callback_data: "mapply" }]] };
}

/** Текст для того, кто пока не участник: что дальше и почему темы закрыты. */
export function membershipPrompt(request: MembershipRequest | null): string {
	if (request?.status === "pending") {
		return (
			"⏳ <b>Заявка на участие уже у админа</b>\n\n" +
			"Как только её одобрят — напишу, и можно будет взять тему доклада.\n\n" +
			"Хочешь что-то добавить о себе — отправь заявку заново, она обновится."
		);
	}
	if (request?.status === "declined") {
		return (
			"Заявку на участие пока не одобрили 😔\n\n" +
			"Это не приговор: отправь её заново, добавив подробностей о себе и о том, " +
			"о чём хочешь рассказать клубу."
		);
	}
	return (
		"🎤 <b>Хочешь выступить — здорово!</b>\n\n" +
		"Темы докладов берут участники клуба, а тебя я пока не знаю. " +
		"Отправь заявку на участие: расскажи о себе — админ посмотрит и откроет доступ к темам.\n\n" +
		"А слушать и приходить на встречи можно уже сейчас: план — в приложении клуба."
	);
}

/** Уведомление админу о заявке на участие: решение принимается в CMS. */
export async function notifyAdminMembership(env: Env, request: MembershipRequest): Promise<void> {
	if (!env.ADMIN_CHAT_ID) {
		console.warn("ADMIN_CHAT_ID не задан — заявка на участие ждёт в CMS без уведомления");
		return;
	}
	// Имя и рассказ пишет человек — экранируем, иначе «<» сломает разбор HTML.
	const who = [request.full_name, request.username ? `@${request.username}` : null]
		.filter(Boolean)
		.map((s) => esc(String(s)))
		.join(", ");
	await sendMessage(
		env.BOT_TOKEN,
		Number(env.ADMIN_CHAT_ID),
		"🙋 <b>Новая заявка на участие в клубе</b>\n\n" +
			`Кто: ${who || `id ${request.chat_id}`}\n` +
			`Откуда: ${request.source === "miniapp" ? "приложение клуба" : "бот"}\n` +
			`Фото: ${request.photo_file_id ? "есть" : request.photo_url ? "аватар Telegram" : "нет"}\n\n` +
			`О себе: ${request.about ? esc(request.about) : "—"}\n\n` +
			`Принять или отклонить: ${cmsClaimsUrl(env)}`,
	);
}

/** Кнопка «Отправить заявку»: mapply — начинаем диалог знакомства. */
export async function handleApplyCallback(env: Env, cb: TelegramCallbackQuery): Promise<void> {
	const message = cb.message;
	if (!message) {
		await answerCallback(env.BOT_TOKEN, cb.id);
		return;
	}
	await answerCallback(env.BOT_TOKEN, cb.id);
	await startMembershipDialog(env, message.chat.id, cb.from.first_name, cb.from.last_name);
}

/** Первый шаг заявки: имя и фамилия (по умолчанию — как в Telegram). */
export async function startMembershipDialog(
	env: Env,
	chatId: number,
	firstName?: string,
	lastName?: string,
): Promise<void> {
	const telegramName = [firstName, lastName].filter(Boolean).join(" ");
	await setDialog(env.BOOK_CLUB_DB, chatId, "apply_name", null, telegramName ? { telegramName } : null);
	await sendMessage(
		env.BOT_TOKEN,
		chatId,
		"Давай знакомиться 👋\n\nНапиши имя и фамилию — так тебя объявят в программе." +
			(telegramName ? `\n\n/skip — оставить «${esc(telegramName)}» из Telegram.` : "") +
			"\n\nПрервать — /cancel",
	);
}

// ── Брони тем докладов ───────────────────────────────────────────────────────

// Свободные темы: не занятые заявкой D1 (единый источник занятости).
function freeTopics(topics: PlanTopic[], claims: SpeakerClaim[]): PlanTopic[] {
	const taken = new Set(claims.filter((c) => c.topic_id).map((c) => c.topic_id));
	return topics.filter((t) => !taken.has(t.topic.id));
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
		`Свободные темы ближайших докладов (${books}). Выбирай:`
	);
}

export async function handleSpeaker(env: Env, message: TelegramMessage): Promise<void> {
	const access = await speakerAccess(env, message.chat.id, message.from?.username);
	// Не участник клуба — темы не показываем, предлагаем заявку на участие.
	if (!access.registered) {
		await sendMessage(
			env.BOT_TOKEN,
			message.chat.id,
			membershipPrompt(access.request),
			applyKeyboard(access.request),
		);
		return;
	}

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
		.map((s) => esc(String(s)))
		.join(", ");
	await sendMessage(
		env.BOT_TOKEN,
		Number(env.ADMIN_CHAT_ID),
		`🎤 <b>Новая заявка на доклад</b>\n\n` +
			`Тема: <b>${esc(claim.topic_title)}</b>${claim.topic_id ? "" : " (своя, вне плана)"}\n` +
			`Спикер: ${from || `id ${claim.chat_id}`}${claim.speaker_id ? " · из каталога клуба ✓" : " · участник клуба"}\n` +
			`Фото: ${claim.photo_file_id ? "есть" : claim.speaker_id ? "из каталога" : "нет"}\n\n` +
			`Подтвердить или отклонить: ${cmsClaimsUrl(env)}`,
	);
}

/**
 * Дозаполняет заявку на тему тем, что уже известно об участнике (имя, каталожный
 * id, фото), запоминает личность и уведомляет админа. Спрашивать нечего: темы
 * берут только участники клуба, а их данные бот уже знает.
 */
export async function completeClaim(
	env: Env,
	claim: SpeakerClaim,
	access: SpeakerAccess,
	username?: string,
): Promise<void> {
	await updateSpeakerClaim(env.BOOK_CLUB_DB, claim.id, {
		...(access.fullName ? { fullName: access.fullName } : {}),
		...(access.speaker ? { speakerId: access.speaker.id } : {}),
		...(access.photoFileId ? { photoFileId: access.photoFileId } : {}),
	});
	if (claim.chat_id) {
		await saveSpeakerIdentity(env.BOOK_CLUB_DB, {
			chatId: claim.chat_id,
			fullName: access.fullName,
			speakerId: access.speaker?.id ?? null,
			photoFileId: access.photoFileId,
			username,
		});
	}
	await clearDialog(env.BOOK_CLUB_DB, claim.chat_id);
	const saved = await getSpeakerClaim(env.BOOK_CLUB_DB, claim.id);
	if (saved) await notifyAdmin(env, saved);
}

/** Нажатие на свободную тему плана: sclaim:<topicId>. */
export async function handleClaimCallback(env: Env, cb: TelegramCallbackQuery, data: string): Promise<void> {
	const message = cb.message;
	if (!message) {
		await answerCallback(env.BOT_TOKEN, cb.id);
		return;
	}
	const chatId = message.chat.id;
	const topicId = data.slice("sclaim:".length);

	// Клавиатура могла остаться от прошлой сессии — проверяем доступ ещё раз.
	const access = await speakerAccess(env, chatId, cb.from.username);
	if (!access.registered) {
		await answerCallback(env.BOT_TOKEN, cb.id, "Нужна заявка на участие");
		await editMessageText(
			env.BOT_TOKEN,
			chatId,
			message.message_id,
			membershipPrompt(access.request),
			applyKeyboard(access.request),
		);
		return;
	}

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
		chatId,
		username: cb.from.username,
	});

	if (!claim) {
		// Тему заняли между показом клавиатуры и нажатием — обновляем её.
		const claims = await listSpeakerClaims(env.BOOK_CLUB_DB);
		await editMessageText(
			env.BOT_TOKEN,
			chatId,
			message.message_id,
			"Эту тему только что заняли 🙈 Выбери другую:",
			speakerKeyboard(freeTopics(topics, claims)),
		);
		await answerCallback(env.BOT_TOKEN, cb.id, "Тему только что заняли");
		return;
	}

	await completeClaim(env, claim, access, cb.from.username);
	await editMessageText(
		env.BOT_TOKEN,
		chatId,
		message.message_id,
		`Тема «<b>${esc(plan.topic.title)}</b>» забронирована за тобой 🎉\n\n` +
			"Заявка ушла админу — как подтвердят, напишу и пришлю шаблон презентации.",
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
	const access = await speakerAccess(env, message.chat.id, cb.from.username);
	if (!access.registered) {
		await answerCallback(env.BOT_TOKEN, cb.id, "Нужна заявка на участие");
		await editMessageText(
			env.BOT_TOKEN,
			message.chat.id,
			message.message_id,
			membershipPrompt(access.request),
			applyKeyboard(access.request),
		);
		return;
	}
	await setDialog(env.BOOK_CLUB_DB, message.chat.id, "custom_topic", null);
	await answerCallback(env.BOT_TOKEN, cb.id);
	await sendMessage(env.BOT_TOKEN, message.chat.id, "Напиши тему доклада одним сообщением ✍️");
}

// ── Диалоги (своя тема; заявка на участие: имя → о себе → фото) ───────────────

/**
 * Сообщение пользователя, когда идёт диалог.
 * true — сообщение обработано, роутить дальше не нужно.
 */
export async function handleDialogMessage(env: Env, message: TelegramMessage): Promise<boolean> {
	const chatId = message.chat.id;
	const dialog = await getDialog(env.BOOK_CLUB_DB, chatId);
	if (!dialog) return false;

	const text = message.text?.trim();
	const draft = dialogDraft(dialog);

	if (dialog.step === "custom_topic") {
		if (!text) return false;
		const access = await speakerAccess(env, chatId, message.from?.username);
		if (!access.registered) {
			await clearDialog(env.BOOK_CLUB_DB, chatId);
			await sendMessage(env.BOT_TOKEN, chatId, membershipPrompt(access.request), applyKeyboard(access.request));
			return true;
		}
		const claim = await createSpeakerClaim(env.BOOK_CLUB_DB, {
			topicId: null,
			topicTitle: text,
			chatId,
			username: message.from?.username,
		});
		if (!claim) return true;

		await completeClaim(env, claim, access, message.from?.username);
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			`Тема «<b>${esc(text)}</b>» записана — заявка ушла админу 🎉 Как подтвердят, напишу!`,
		);
		return true;
	}

	// Заявка на участие: имя.
	if (dialog.step === "apply_name") {
		const fullName = text === "/skip" ? draft.telegramName : text;
		if (!fullName) {
			await sendMessage(env.BOT_TOKEN, chatId, "Напиши имя и фамилию текстом 🙏");
			return true;
		}
		await setDialog(env.BOOK_CLUB_DB, chatId, "apply_about", null, { ...draft, fullName });
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
				`Приятно познакомиться, <b>${esc(fullName)}</b>!\n\n` +
				"Расскажи о себе одним сообщением: чем занимаешься, какой опыт и о чём хотел бы " +
				"рассказать клубу. Это сообщение увидит админ.",
		);
		return true;
	}

	// Заявка на участие: рассказ о себе (сообщение для админа).
	if (dialog.step === "apply_about") {
		if (!text || text === "/skip") {
			await sendMessage(
				env.BOT_TOKEN,
				chatId,
				"Пары предложений достаточно — но без них заявку не отправить 🙂",
			);
			return true;
		}
		await setDialog(env.BOOK_CLUB_DB, chatId, "apply_photo", null, { ...draft, about: text });
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			"И последнее: пришли своё фото для аватарки 📸 (или /skip — добавим позже).",
		);
		return true;
	}

	// Заявка на участие: фото (или /skip) — и отправляем админу.
	if (dialog.step === "apply_photo") {
		const photo = message.photo?.at(-1);
		if (!photo && text !== "/skip") return false;
		const request = await saveMembershipRequest(env.BOOK_CLUB_DB, {
			chatId,
			username: message.from?.username,
			fullName: draft.fullName,
			about: draft.about,
			photoFileId: photo?.file_id,
			source: "bot",
		});
		await clearDialog(env.BOOK_CLUB_DB, chatId);
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			"Заявка отправлена админу 🎉 Как только её одобрят — напишу, и можно будет " +
				"выбрать тему доклада: /speaker\n\n" +
				"А пока приходи на встречи — план в приложении клуба.",
		);
		if (request) await notifyAdminMembership(env, request);
		return true;
	}

	// Шаг из старой версии бота — не мучаем человека, начинаем с чистого листа.
	await clearDialog(env.BOOK_CLUB_DB, chatId);
	return false;
}

/** /cancel — прервать диалог (своя тема или заявка на участие). */
export async function handleCancel(env: Env, message: TelegramMessage): Promise<void> {
	await clearDialog(env.BOOK_CLUB_DB, message.chat.id);
	await sendMessage(env.BOT_TOKEN, message.chat.id, "Ок, отменил. Начать заново — /speaker");
}
