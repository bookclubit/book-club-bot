// Загрузка данных из репозитория book-club-data (GitHub raw).

import type { Chapter, ClubEvent, ContentIndex, DeckCard, Flashcard } from "../types";

/** Корень raw-контента по умолчанию (перекрывается переменной env RAW_ROOT). */
const DEFAULT_RAW_ROOT = "https://raw.githubusercontent.com/bookclubit/book-club-data/main";

// Настраивается один раз на изолят из env (configureApi в точке входа Worker);
// фолбэк на дефолт — чтобы деплой без новой переменной ничего не ломал.
let rawRoot = DEFAULT_RAW_ROOT;

/** Применяет переменные env к загрузчику контента (вызывать на входе Worker). */
export function configureApi(env: { RAW_ROOT?: string }): void {
	rawRoot = env.RAW_ROOT || DEFAULT_RAW_ROOT;
}

const dataBase = (): string => `${rawRoot}/books`;

/** GET c повторами при сетевых ошибках / 5xx. Экспоненциальная задержка. */
async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			const res = await fetch(url, {
				headers: { "User-Agent": "book-club-bot" },
				cf: { cacheTtl: 300, cacheEverything: true },
			});
			// 5xx — временная ошибка, повторяем; 4xx — нет смысла.
			if (res.ok) return res;
			if (res.status < 500) {
				throw new Error(`HTTP ${res.status} при запросе ${url}`);
			}
			lastError = new Error(`HTTP ${res.status} при запросе ${url}`);
		} catch (err) {
			lastError = err;
		}
		// Задержка перед следующей попыткой: 200ms, 400ms, ...
		if (attempt < retries - 1) {
			await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Загружает все карточки книги. */
export async function fetchFlashcards(bookId: string): Promise<Flashcard[]> {
	const res = await fetchWithRetry(`${dataBase()}/${bookId}/flashcards.json`);
	const data = (await res.json()) as Flashcard[];
	if (!Array.isArray(data)) {
		throw new Error(`Некорректный формат flashcards.json для ${bookId}`);
	}
	return data;
}

/**
 * Карточки по всем книгам клуба (из реестра). Книги без flashcards.json
 * (404) просто пропускаются. Каждая карточка помечена своей книгой.
 */
export async function fetchAllFlashcards(): Promise<DeckCard[]> {
	const index = await fetchIndex();
	const perBook = await Promise.all(
		index.books.map(async (b): Promise<DeckCard[]> => {
			try {
				const cards = await fetchFlashcards(b.folder);
				return cards.map((card) => ({ book: b.folder, card }));
			} catch {
				return [];
			}
		}),
	);
	return perBook.flat();
}

/** Загружает единый реестр контента (index.json). */
export async function fetchIndex(): Promise<ContentIndex> {
	const res = await fetchWithRetry(`${rawRoot}/index.json`);
	return (await res.json()) as ContentIndex;
}

/** Загружает событие по пути внутри events/ (например, live-talks/2026-….json). */
export async function fetchEventByPath(path: string): Promise<ClubEvent | null> {
	try {
		const res = await fetchWithRetry(`${rawRoot}/events/${path}`);
		return (await res.json()) as ClubEvent;
	} catch {
		return null;
	}
}

/** Загружает индекс главы (chapter.json) книги по имени папки. */
export async function fetchChapter(folder: string, chapterSlug: string): Promise<Chapter | null> {
	try {
		const res = await fetchWithRetry(`${dataBase()}/${folder}/chapters/${chapterSlug}/chapter.json`);
		return (await res.json()) as Chapter;
	} catch {
		return null;
	}
}
