// Данные для статистики и напоминаний: колода, прогресс и журнал из D1,
// карточки книг из book-club-data. Считает lib/stats.ts.

import type { ContentIndex, Flashcard } from "../types";
import { fetchFlashcards, fetchIndex } from "./api";
import { getCardProgressMap, getDeck, listReviews } from "./db";
import { deckFolders } from "./deck";
import { computeStats, type BookStats, type StatsBook, type UserStats } from "./stats";

/**
 * Реестр и карточки на один проход. Утренняя рассылка обходит многих людей
 * с одними и теми же книгами, а подзапросов у воркера на один вызов немного —
 * каждую книгу качаем один раз.
 */
export interface ContentCache {
	index?: Promise<ContentIndex>;
	cards: Map<string, Promise<Flashcard[]>>;
}

export const contentCache = (): ContentCache => ({ cards: new Map() });

/** Книга карточки — часть ключа прогресса «<book>:<cardId>» до двоеточия. */
const bookOfKey = (key: string): string => key.slice(0, key.indexOf(":"));

async function statsBooks(folders: Set<string>, cache: ContentCache): Promise<StatsBook[]> {
	if (folders.size === 0) return [];
	cache.index ??= fetchIndex();
	const index = await cache.index;
	return Promise.all(
		index.books
			.filter((b) => folders.has(b.folder))
			.map(async (b) => {
				let cards = cache.cards.get(b.folder);
				if (!cards) {
					// flashcards.json есть не у каждой книги — тогда карточек просто нет.
					cards = fetchFlashcards(b.folder).catch(() => []);
					cache.cards.set(b.folder, cards);
				}
				return { folder: b.folder, title: b.title, cards: await cards };
			}),
	);
}

/** Полная статистика пользователя — для /api/stats и /status. */
export async function loadUserStats(
	db: D1Database,
	userId: number,
	now = Date.now(),
): Promise<UserStats> {
	const [deck, progress, reviews] = await Promise.all([
		getDeck(db, userId),
		getCardProgressMap(db, userId),
		listReviews(db, userId),
	]);
	const folders = new Set([...deckFolders(deck), ...[...progress.keys()].map(bookOfKey)]);
	const books = await statsBooks(folders, contentCache());
	return computeStats({ books, deck, progress, reviews, now });
}

/**
 * Что пора повторить по колоде — для напоминаний. empty — колоды нет вовсе
 * (напоминать не о чем, в отличие от «всё повторено»).
 */
export async function loadDueBooks(
	db: D1Database,
	userId: number,
	cache: ContentCache = contentCache(),
	now = Date.now(),
): Promise<{ empty: boolean; due: BookStats[] }> {
	const deck = await getDeck(db, userId);
	const folders = new Set(deckFolders(deck));
	if (folders.size === 0) return { empty: true, due: [] };
	const [progress, books] = await Promise.all([
		getCardProgressMap(db, userId),
		statsBooks(folders, cache),
	]);
	const stats = computeStats({ books, deck, progress, reviews: [], now });
	return { empty: false, due: stats.books.filter((b) => b.due > 0) };
}
