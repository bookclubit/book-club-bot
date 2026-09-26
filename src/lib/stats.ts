// Статистика изучения карточек. Одна на бота (/status, утреннее напоминание)
// и сайт (/api/stats): считается только здесь, остальные показывают.

import type { CardProgress, Flashcard } from "../types";
import { cardKey, type Deck, type ReviewEntry } from "./db";
import { bookScope, cardsInScope } from "./deck";
import { mskToday } from "./events";

/** С какого интервала карточка считается выученной (как «зрелые» в Anki). */
export const MATURE_DAYS = 21;
/** Сколько дней показывает календарь активности — 12 недель. */
export const ACTIVITY_DAYS = 84;
/** «Трудно» (q = 3) и выше — вспомнил; «Снова» — нет. */
const RECALLED_QUALITY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Книга с карточками — из реестра и flashcards.json. */
export interface StatsBook {
	folder: string;
	title: string;
	cards: Flashcard[];
}

export interface BookStats {
	folder: string;
	title: string;
	/** В колоде вся книга или хотя бы одна её глава. */
	in_deck: boolean;
	total: number;
	/** Ни разу не повторялись. */
	fresh: number;
	/** Повторялись, но интервал ещё меньше MATURE_DAYS. */
	learning: number;
	mature: number;
	/** К повторению — только карточки из колоды. */
	due: number;
	last_reviewed: number | null;
}

export interface UserStats {
	totals: { cards: number; fresh: number; learning: number; mature: number; due: number };
	reviews: { total: number; today: number; week: number; accuracy: number | null };
	streak: { current: number; best: number };
	/** Повторений по дням (МСК) за ACTIVITY_DAYS дней, от давних к сегодняшнему. */
	activity: { date: string; count: number }[];
	books: BookStats[];
}

/** К повторению: карточка новая или её срок подошёл. */
export function isDue(p: CardProgress | undefined, now: number): boolean {
	return !p || p.dueDate <= now;
}

const dayNumber = (date: string): number => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const dateOfDay = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/**
 * Серия — дни подряд с повторениями. Пока сегодня не занимался, серия
 * считается по вчерашний день: до вечера она ещё не прервалась.
 */
export function streaks(days: Iterable<string>, today: string): { current: number; best: number } {
	const nums = [...new Set([...days].map(dayNumber))].sort((a, b) => a - b);
	let best = 0;
	let run = 0;
	for (let i = 0; i < nums.length; i++) {
		run = i > 0 && nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
		best = Math.max(best, run);
	}
	const present = new Set(nums);
	let day = dayNumber(today);
	if (!present.has(day)) day -= 1;
	let current = 0;
	while (present.has(day)) {
		current++;
		day--;
	}
	return { current, best };
}

/**
 * Статистика по книгам колоды и по тем, что уже повторялись (прогресс
 * остаётся, даже если книгу из колоды убрали).
 */
export function computeStats(input: {
	books: StatsBook[];
	deck: Deck;
	progress: Map<string, CardProgress>;
	reviews: ReviewEntry[];
	now: number;
}): UserStats {
	const { deck, progress, reviews, now } = input;
	const studied = new Set([...progress.keys()].map((key) => key.slice(0, key.indexOf(":"))));

	const books: BookStats[] = [];
	for (const book of input.books) {
		const scope = bookScope(deck, book.folder);
		if (!scope && !studied.has(book.folder)) continue;
		const inDeck = new Set(cardsInScope(book.cards, scope).map((card) => card.id));
		const stat: BookStats = {
			folder: book.folder,
			title: book.title,
			in_deck: scope !== null,
			total: book.cards.length,
			fresh: 0,
			learning: 0,
			mature: 0,
			due: 0,
			last_reviewed: null,
		};
		for (const card of book.cards) {
			const p = progress.get(cardKey(book.folder, card.id));
			if (!p) stat.fresh++;
			else if (p.interval >= MATURE_DAYS) stat.mature++;
			else stat.learning++;
			if (p && p.lastReviewed > (stat.last_reviewed ?? 0)) stat.last_reviewed = p.lastReviewed;
			if (inDeck.has(card.id) && isDue(p, now)) stat.due++;
		}
		books.push(stat);
	}
	// Книги колоды — первыми, дальше те, что повторялись недавно.
	books.sort(
		(a, b) =>
			Number(b.in_deck) - Number(a.in_deck) ||
			(b.last_reviewed ?? 0) - (a.last_reviewed ?? 0) ||
			a.title.localeCompare(b.title, "ru"),
	);

	const totals = { cards: 0, fresh: 0, learning: 0, mature: 0, due: 0 };
	for (const b of books) {
		totals.cards += b.total;
		totals.fresh += b.fresh;
		totals.learning += b.learning;
		totals.mature += b.mature;
		totals.due += b.due;
	}

	const today = mskToday(now);
	const perDay = new Map<string, number>();
	let recalled = 0;
	for (const r of reviews) {
		const date = mskToday(r.at);
		perDay.set(date, (perDay.get(date) ?? 0) + 1);
		if (r.quality >= RECALLED_QUALITY) recalled++;
	}
	const todayNum = dayNumber(today);
	const activity: UserStats["activity"] = [];
	for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
		const date = dateOfDay(todayNum - i);
		activity.push({ date, count: perDay.get(date) ?? 0 });
	}

	return {
		totals,
		reviews: {
			total: reviews.length,
			today: perDay.get(today) ?? 0,
			week: activity.slice(-7).reduce((n, d) => n + d.count, 0),
			accuracy: reviews.length > 0 ? recalled / reviews.length : null,
		},
		streak: streaks(perDay.keys(), today),
		activity,
		books,
	};
}
