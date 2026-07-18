// Алгоритм интервального повторения SM-2 (SuperMemo 2).
// https://super-memory.com/english/ol/sm2.htm

import type { CardProgress, Flashcard, Grade } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_EASINESS = 1.3;
const DEFAULT_EASINESS = 2.5;

/** Оценка пользователя → качество ответа q (0–5) в терминах SM-2. */
const GRADE_QUALITY: Record<Grade, number> = {
	again: 1, // Забыл
	hard: 3, // Сложно
	easy: 5, // Легко
};

/** Начальный прогресс для ещё не изучавшейся карточки (подлежит повторению сразу). */
export function initialProgress(cardId: string, now: number): CardProgress {
	return {
		cardId,
		repetition: 0,
		interval: 0,
		easiness: DEFAULT_EASINESS,
		dueDate: now,
		lastReviewed: 0,
	};
}

/**
 * Рассчитывает новое состояние карточки по SM-2 после оценки.
 * @param prev текущий прогресс (или undefined для новой карточки)
 * @param grade оценка пользователя
 * @param now текущее время, epoch ms
 */
export function calculateNextReview(
	prev: CardProgress | undefined,
	grade: Grade,
	now: number,
): CardProgress {
	return reviewFromQuality(prev, GRADE_QUALITY[grade], now);
}

/**
 * Расчёт SM-2 по числовому качеству ответа q (0–5) — общий для бота (3 оценки)
 * и сайта (4 оценки: again/hard/good/easy). Позволяет считать интервалы
 * одинаково независимо от источника оценки.
 */
export function reviewFromQuality(
	prev: CardProgress | undefined,
	quality: number,
	now: number,
): CardProgress {
	const cardId = prev?.cardId ?? "";
	const base = prev ?? initialProgress(cardId, now);

	// Обновление коэффициента лёгкости.
	let easiness =
		base.easiness + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
	if (easiness < MIN_EASINESS) easiness = MIN_EASINESS;

	let repetition: number;
	let interval: number;

	if (quality < 3) {
		// Ответ провален — начинаем повторения заново.
		repetition = 0;
		interval = 1;
	} else {
		repetition = base.repetition + 1;
		if (repetition === 1) {
			interval = 1;
		} else if (repetition === 2) {
			interval = 6;
		} else {
			interval = Math.round(base.interval * easiness);
		}
	}

	return {
		cardId: base.cardId,
		repetition,
		interval,
		easiness,
		dueDate: now + interval * DAY_MS,
		lastReviewed: now,
	};
}

/**
 * Выбирает карточки, подлежащие повторению.
 * Новые (без прогресса) и просроченные (dueDate <= now) — по возрастанию dueDate.
 * @param cards все карточки книги
 * @param progress map cardId → прогресс
 * @param now текущее время, epoch ms
 * @param limit максимум карточек
 */
export function getDueCards(
	cards: Flashcard[],
	progress: Map<string, CardProgress>,
	now: number,
	limit: number,
): Flashcard[] {
	const due = cards.filter((card) => {
		const p = progress.get(card.id);
		return !p || p.dueDate <= now;
	});

	// Сначала самые «просроченные» и новые карточки.
	due.sort((a, b) => {
		const da = progress.get(a.id)?.dueDate ?? 0;
		const db = progress.get(b.id)?.dueDate ?? 0;
		return da - db;
	});

	return due.slice(0, limit);
}
