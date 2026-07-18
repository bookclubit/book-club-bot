// План тем для докладов: главы активных книг из будущих встреч,
// КРОМЕ ближайшей (на неё готовиться уже поздно — программа свёрстана).

import type { TopicRef } from "../types";
import { fetchChapter, fetchEventByPath, fetchIndex } from "./api";
import { eventDateFromPath, mskToday } from "./events";

export interface PlanTopic {
	topic: TopicRef;
	bookId: string;
	bookTitle: string;
	chapterSlug: string;
	/** Тема уже занята докладом, назначенным админом в CMS (event.talks). */
	takenByCms: boolean;
}

export async function fetchPlanTopics(): Promise<PlanTopic[]> {
	const index = await fetchIndex();
	const today = mskToday();

	// Будущие события по дате из имени файла, ближайшее — вне плана.
	const future = index.events
		.map((path) => ({ path, date: eventDateFromPath(path) ?? "" }))
		.filter((e) => e.date >= today)
		.sort((a, b) => a.date.localeCompare(b.date));
	const planPaths = future.slice(1).map((e) => e.path);
	if (planPaths.length === 0) return [];

	// Главы плана: (папка книги, slug главы) из событий, книги — только активные.
	// Заодно собираем темы, уже занятые докладами из CMS (по topic_id и названию).
	const chapters = new Map<string, { folder: string; bookId: string; bookTitle: string; slug: string }>();
	const takenIds = new Set<string>();
	const takenTitles = new Set<string>();
	for (const path of planPaths) {
		const event = await fetchEventByPath(path);
		if (event?.type === "live-talk") {
			for (const talk of event.talks ?? []) {
				if (talk.topic_id) takenIds.add(talk.topic_id);
				if (talk.title) takenTitles.add(talk.title);
			}
		}
		if (!event?.book_id || !event.chapter) continue;
		const book =
			index.books.find((b) => b.id === event.book_id) ??
			index.books.find((b) => b.folder === event.book_id);
		if (!book || book.status !== "reading") continue;
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
			topics.push({
				topic,
				bookId: ch.bookId,
				bookTitle: ch.bookTitle,
				chapterSlug: ch.slug,
				takenByCms: takenIds.has(topic.id) || takenTitles.has(topic.title),
			});
		}
	}
	return topics;
}
