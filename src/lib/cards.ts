// Рендеринг карточек и клавиатуры для диалогового повторения (по одной).

import type { Flashcard, Grade, InlineKeyboardMarkup } from "../types";

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

// ── callback_data (короткие — текущая карточка берётся из сессии в D1) ────────

export const STUDY_FLIP = "sf"; // показать ответ
export const studyGradeData = (grade: Grade) => `sg:${grade}`;

/** Клавиатура лицевой стороны — «Показать ответ». */
export function flipKeyboard(): InlineKeyboardMarkup {
	return { inline_keyboard: [[{ text: "👀 Показать ответ", callback_data: STUDY_FLIP }]] };
}

/** Клавиатура обратной стороны — оценка ответа. */
export function gradeKeyboard(): InlineKeyboardMarkup {
	return {
		inline_keyboard: [
			[
				{ text: GRADE_LABEL.again, callback_data: studyGradeData("again") },
				{ text: GRADE_LABEL.hard, callback_data: studyGradeData("hard") },
				{ text: GRADE_LABEL.easy, callback_data: studyGradeData("easy") },
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
