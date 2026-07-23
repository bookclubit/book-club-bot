// Диалоговое повторение: карточки по всем книгам клуба выдаются по одной.
// Текущая карточка и очередь хранятся в D1 (study_session), поэтому кнопки
// несут короткий callback_data, а не id карточки.

import type { Flashcard, Grade, TelegramCallbackQuery } from "../types";
import { fetchAllFlashcards, fetchFlashcards } from "./api";
import { flipKeyboard, gradeKeyboard, renderBack, renderFront } from "./cards";
import {
	cardKey,
	clearSession,
	getCardProgress,
	getCardProgressMap,
	getDailyCards,
	getSession,
	saveCardProgress,
	saveSession,
} from "./db";
import { calculateNextReview, initialProgress, selectDue } from "./spaced-repetition";
import { answerCallback, editMessageText, sendMessage } from "./telegram";

/** Русское склонение слова «день». */
function pluralDays(n: number): string {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod10 === 1 && mod100 !== 11) return "день";
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
	return "дней";
}

async function findCard(book: string, cardId: string): Promise<Flashcard | null> {
	try {
		const cards = await fetchFlashcards(book);
		return cards.find((c) => c.id === cardId) ?? null;
	} catch {
		return null;
	}
}

/** Отправляет лицевую сторону текущей карточки с кнопкой «Показать ответ». */
async function sendFront(env: Env, chatId: number, card: Flashcard, remaining: number): Promise<void> {
	const header = `🗂 <b>Повторение</b> · осталось ${remaining}\n\n`;
	await sendMessage(env.BOT_TOKEN, chatId, header + renderFront(card), flipKeyboard());
}

/**
 * Стартует сессию повторения: набирает карточки к повторению (лимит — из настроек
 * пользователя), сохраняет очередь и отправляет первую. Возвращает число карточек.
 */
export async function startStudy(
	env: Env,
	chatId: number,
	opts: { intro?: string } = {},
): Promise<number> {
	const [deck, progress, limit] = await Promise.all([
		fetchAllFlashcards(),
		getCardProgressMap(env.BOOK_CLUB_DB, chatId),
		getDailyCards(env.BOOK_CLUB_DB, chatId),
	]);

	// Карточки к повторению по всем книгам: новые и просроченные, самые «старые» вперёд.
	const due = selectDue(deck, (d) => cardKey(d.book, d.card.id), progress, Date.now(), limit);
	if (due.length === 0) return 0;

	await saveSession(
		env.BOOK_CLUB_DB,
		chatId,
		due.map((d) => ({ b: d.book, c: d.card.id })),
		0,
	);
	if (opts.intro) await sendMessage(env.BOT_TOKEN, chatId, opts.intro);
	await sendFront(env, chatId, due[0].card, due.length);
	return due.length;
}

/** Нажата «Показать ответ» — раскрываем текущую карточку и показываем оценки. */
export async function handleStudyFlip(env: Env, cb: TelegramCallbackQuery): Promise<void> {
	const message = cb.message;
	if (!message) return answerCallback(env.BOT_TOKEN, cb.id).then(() => undefined);
	const chatId = message.chat.id;

	const session = await getSession(env.BOOK_CLUB_DB, chatId);
	if (!session || session.queue.length === 0) {
		await answerCallback(env.BOT_TOKEN, cb.id, "Сессия уже завершена");
		return;
	}
	const { b, c } = session.queue[0];
	const card = await findCard(b, c);
	if (!card) {
		await answerCallback(env.BOT_TOKEN, cb.id, "Карточка не найдена 🤷");
		return;
	}
	await editMessageText(env.BOT_TOKEN, chatId, message.message_id, renderBack(card), gradeKeyboard());
	await answerCallback(env.BOT_TOKEN, cb.id);
}

/** Оценка текущей карточки — сохраняем прогресс и выдаём следующую. */
export async function handleStudyGrade(
	env: Env,
	cb: TelegramCallbackQuery,
	grade: Grade,
): Promise<void> {
	const message = cb.message;
	if (!message) return answerCallback(env.BOT_TOKEN, cb.id).then(() => undefined);
	const chatId = message.chat.id;

	const session = await getSession(env.BOOK_CLUB_DB, chatId);
	if (!session || session.queue.length === 0) {
		await answerCallback(env.BOT_TOKEN, cb.id, "Сессия уже завершена");
		return;
	}

	const { b, c } = session.queue[0];
	const card = await findCard(b, c);
	const key = cardKey(b, c);
	const now = Date.now();
	const prev =
		(await getCardProgress(env.BOOK_CLUB_DB, chatId, key)) ?? initialProgress(key, now);
	const next = calculateNextReview(prev, grade, now);
	await saveCardProgress(env.BOOK_CLUB_DB, chatId, b, next);

	const rest = session.queue.slice(1);
	const reviewed = session.reviewed + 1;

	// Финализируем текущее сообщение: ответ + когда следующее повторение.
	if (card) {
		const days = next.interval;
		const doneLine = `\n\n✅ <i>Записал. Следующее повторение через ${days} ${pluralDays(days)}.</i>`;
		await editMessageText(env.BOT_TOKEN, chatId, message.message_id, renderBack(card) + doneLine);
	}
	await answerCallback(env.BOT_TOKEN, cb.id, "Готово 👍");

	if (rest.length === 0) {
		await clearSession(env.BOOK_CLUB_DB, chatId);
		await sendMessage(
			env.BOT_TOKEN,
			chatId,
			`🎉 На сегодня всё! Повторено карточек: <b>${reviewed}</b>.`,
		);
		return;
	}

	await saveSession(env.BOOK_CLUB_DB, chatId, rest, reviewed);
	const nextCard = await findCard(rest[0].b, rest[0].c);
	if (nextCard) await sendFront(env, chatId, nextCard, rest.length);
}
