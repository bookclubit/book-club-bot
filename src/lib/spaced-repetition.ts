// Алгоритм интервального повторения SM-2 (SuperMemo 2).
// https://super-memory.com/english/ol/sm2.htm
// Карточки повторяют в приложении клуба, оценки приходят в POST /api/review —
// единый расчёт здесь, прогресс в D1.

import type { CardProgress } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_EASINESS = 1.3;
const DEFAULT_EASINESS = 2.5;

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
 * Расчёт SM-2 по качеству ответа q (0–5). Оценки сайта (again/hard/good/easy)
 * переводятся в q в POST /api/review.
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
