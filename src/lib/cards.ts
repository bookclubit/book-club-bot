// Рендеринг карточек и отправка «к повторению» пользователю.

import type { Flashcard, Grade, InlineKeyboardMarkup } from "../types";
import { BOOK_ID } from "../types";
import { fetchFlashcards } from "./api";
import { getCardProgressMap } from "./db";
import { getDueCards } from "./spaced-repetition";
import { sendMessage } from "./telegram";

/** Сколько карточек отправляем за один заход. */
export const CARDS_PER_SESSION = 5;

const DIFFICULTY_RU: Record<string, string> = {
	easy: "лёгкая",
	medium: "средняя",
	hard: "сложная",
};

const GRADE_LABEL: Record<Grade, string> = {
	again: "🔴 Забыл",
	hard: "🟡 Сложно",
	easy: "🟢 Легко",
};

// ── callback_data ────────────────────────────────────────────────────────────

export const showAnswerData = (cardId: string) => `show:${cardId}`;
export const gradeData = (cardId: string, grade: Grade) => `grade:${cardId}:${grade}`;

/** Клавиатура лицевой стороны — одна кнопка «Показать ответ». */
export function frontKeyboard(cardId: string): InlineKeyboardMarkup {
	return {
		inline_keyboard: [[{ text: "👀 Показать ответ", callback_data: showAnswerData(cardId) }]],
	};
}

/** Клавиатура обратной стороны — оценка ответа. */
export function gradeKeyboard(cardId: string): InlineKeyboardMarkup {
	return {
		inline_keyboard: [
			[
				{ text: GRADE_LABEL.again, callback_data: gradeData(cardId, "again") },
				{ text: GRADE_LABEL.hard, callback_data: gradeData(cardId, "hard") },
				{ text: GRADE_LABEL.easy, callback_data: gradeData(cardId, "easy") },
			],
		],
	};
}

// ── Рендеринг ────────────────────────────────────────────────────────────────

/** Экранирование для parse_mode=HTML. */
function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function footer(card: Flashcard): string {
	const diff = DIFFICULTY_RU[card.difficulty] ?? card.difficulty;
	return `<i>Глава ${esc(card.chapter)} · ${esc(diff)}</i>`;
}

/** Лицевая сторона карточки (вопрос / команда). */
export function renderFront(card: Flashcard): string {
	if (card.type === "qa") {
		return `📖 <b>Вопрос</b>\n\n${esc(card.question)}\n\n${footer(card)}`;
	}
	return `⌨️ <b>Команда</b>\n\n<code>${esc(card.command)}</code>\n\nЧто делает эта команда?\n\n${footer(card)}`;
}

/** Обратная сторона карточки (с ответом). */
export function renderBack(card: Flashcard): string {
	if (card.type === "qa") {
		return (
			`📖 <b>Вопрос</b>\n\n${esc(card.question)}\n\n` +
			`💡 <b>Ответ:</b>\n${esc(card.answer)}\n\n${footer(card)}`
		);
	}
	return (
		`⌨️ <b>Команда</b>\n\n<code>${esc(card.command)}</code>\n\n` +
		`💡 <b>Что делает:</b>\n${esc(card.result)}\n\n${footer(card)}`
	);
}

// ── Отправка сессии повторения ───────────────────────────────────────────────

/**
 * Считает и отправляет пользователю карточки к повторению.
 * @param intro необязательное вступление, отправляется перед карточками, если они есть
 * @returns число отправленных карточек
 */
export async function sendDueCards(
	env: Env,
	chatId: number,
	opts: { limit?: number; intro?: string } = {},
): Promise<number> {
	const { limit = CARDS_PER_SESSION, intro } = opts;

	const [cards, progress] = await Promise.all([
		fetchFlashcards(BOOK_ID),
		getCardProgressMap(env.BOOK_CLUB_DB, chatId),
	]);

	const now = Date.now();
	const due = getDueCards(cards, progress, now, limit);

	if (due.length === 0) return 0;

	if (intro) {
		await sendMessage(env.BOT_TOKEN, chatId, intro);
	}
	for (const card of due) {
		await sendMessage(env.BOT_TOKEN, chatId, renderFront(card), frontKeyboard(card.id));
	}

	return due.length;
}
