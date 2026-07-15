// Загрузка данных книг из репозитория book-club-data (GitHub raw).

import type { BookMeta, Flashcard } from "../types";

const DATA_BASE = "https://raw.githubusercontent.com/bookclubit/book-club-data/main/books";

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
	const res = await fetchWithRetry(`${DATA_BASE}/${bookId}/flashcards.json`);
	const data = (await res.json()) as Flashcard[];
	if (!Array.isArray(data)) {
		throw new Error(`Некорректный формат flashcards.json для ${bookId}`);
	}
	return data;
}

/** Загружает метаданные книги. */
export async function fetchBookMeta(bookId: string): Promise<BookMeta> {
	const res = await fetchWithRetry(`${DATA_BASE}/${bookId}/meta.json`);
	return (await res.json()) as BookMeta;
}
