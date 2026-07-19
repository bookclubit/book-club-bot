// Темы для докладов: главы будущих встреч-«докладов» (live-talks). Занятость
// тем считается отдельно по заявкам D1 (единый источник) — см. registration.ts.

import type { TopicRef } from "../types";
import { fetchChapter, fetchEventByPath, fetchIndex } from "./api";
import { eventDateFromPath, mskToday } from "./events";

export interface PlanTopic {
	topic: TopicRef;
	bookId: string;
	bookTitle: string;
	chapterSlug: string;
}

export async function fetchPlanTopics(): Promise<PlanTopic[]> {
	const index = await fetchIndex();
	const today = mskToday();

	// Только «доклады» (live-talks) в будущем: именно на них берут темы.
	const planPaths = index.events
		.filter((p) => p.startsWith("live-talks/"))
		.map((p) => ({ p, date: eventDateFromPath(p) ?? "" }))
		.filter((e) => e.date >= today)
		.sort((a, b) => a.date.localeCompare(b.date))
		.map((e) => e.p);
	if (planPaths.length === 0) return [];

	// Главы будущих докладов: (папка книги, slug главы) из событий.
	const chapters = new Map<string, { folder: string; bookId: string; bookTitle: string; slug: string }>();
	for (const path of planPaths) {
		const event = await fetchEventByPath(path);
		if (!event?.book_id || !event.chapter) continue;
		const book =
			index.books.find((b) => b.id === event.book_id) ??
			index.books.find((b) => b.folder === event.book_id);
		if (!book) continue;
		chapters.set(`${book.folder}/${event.chapter}`, {
			folder: book.folder,
			bookId: book.id,
			bookTitle: book.title,
			slug: event.chapter,
		});
	}

	const topics: PlanTopic[] = [];
	for (const ch of chapters.values()) {
		const chapter = await fetchChapter(ch.folder, ch.slug);
		for (const topic of chapter?.topics ?? []) {
			topics.push({ topic, bookId: ch.bookId, bookTitle: ch.bookTitle, chapterSlug: ch.slug });
		}
	}
	return topics;
}
