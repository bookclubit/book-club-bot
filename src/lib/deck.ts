// Колода: какие карточки книги в неё входят. Та же логика, что у сайта
// (miniapp lib/deck.ts): книга целиком или отдельные главы. Хранение — db.ts.

import type { Flashcard } from "../types";
import type { Deck } from "./db";

/** Карточки книги в колоде: все, набор номеров глав или ни одной. */
export type CardScope = "all" | Set<string> | null;

export function bookScope(deck: Deck, book: string): CardScope {
	if (deck.books.includes(book)) return "all";
	const chapters = deck.chapters
		.filter((key) => key.startsWith(`${book}::`))
		.map((key) => key.slice(book.length + 2));
	return chapters.length > 0 ? new Set(chapters) : null;
}

export function cardsInScope(cards: Flashcard[], scope: CardScope): Flashcard[] {
	if (scope === "all") return cards;
	if (!scope) return [];
	return cards.filter((card) => scope.has(String(card.chapter)));
}

/** Книги колоды — целиком и те, от которых в колоде отдельные главы. */
export function deckFolders(deck: Deck): string[] {
	return [...new Set([...deck.books, ...deck.chapters.map((key) => key.split("::")[0])])];
}

/** Имя папки книги в book-club-data — всё прочее в колоду не пускаем. */
export const FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;
/** Подписка на главу: `<папка>::<номер главы>`. */
const CHAPTER_KEY_RE = /^[a-z0-9][a-z0-9-]{0,199}::\d{1,4}$/;

/** Колода из запроса (слияние с устройства): мусор отбрасываем, размер ограничен. */
export function parseDeck(input: unknown, limit = 200): Deck {
	const body = (input ?? {}) as { books?: unknown; chapters?: unknown };
	const pick = (list: unknown, re: RegExp): string[] =>
		Array.isArray(list)
			? [...new Set(list.filter((x): x is string => typeof x === "string" && re.test(x)))].slice(0, limit)
			: [];
	return { books: pick(body.books, FOLDER_RE), chapters: pick(body.chapters, CHAPTER_KEY_RE) };
}
