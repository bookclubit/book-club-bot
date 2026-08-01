// Темы для докладов: главы будущих встреч-«докладов» (live-talks). Занятость
// тем считается отдельно по заявкам D1 (единый источник) — см. registration.ts.

import type { TopicRef } from "../types";
import { fetchEventByPath, fetchIndex } from "./api";
import { eventArchived, eventDateFromPath, fetchEventProgram, mskToday } from "./events";

export interface PlanTopic {
	topic: TopicRef;
	bookId: string;
	bookTitle: string;
	chapterSlug: string;
}

export async function fetchPlanTopics(): Promise<PlanTopic[]> {
	const index = await fetchIndex();
	// По дате отбираем с запасом на день: встреча вечера предыдущей даты может
	// идти после полуночи, а прошла она или нет — решает `eventArchived` ниже
	// (у пути есть только дата, времени в нём нет).
	const from = mskToday(Date.now() - 24 * 3600 * 1000);

	// Только «доклады» (live-talks): именно на них берут темы.
	const planPaths = index.events
		.filter((p) => p.startsWith("live-talks/"))
		.map((p) => ({ p, date: eventDateFromPath(p) ?? "" }))
		.filter((e) => e.date >= from)
		.sort((a, b) => a.date.localeCompare(b.date))
		.map((e) => e.p);
	if (planPaths.length === 0) return [];

	// Программа эфира — блоками: на одном стриме бывает несколько глав и книг.
	// Темы берём ровно те, что в программе (у блока может быть свой набор).
	const topics: PlanTopic[] = [];
	const seen = new Set<string>();
	for (const path of planPaths) {
		const event = await fetchEventByPath(path);
		if (!event) continue;
		// Прошедший эфир тем не даёт — то же правило, что в плане на сайте.
		if (eventArchived(event)) continue;
		for (const block of await fetchEventProgram(event)) {
			const book = index.books.find((b) => b.folder === block.folder);
			for (const topic of block.topics) {
				if (seen.has(topic.id)) continue;
				seen.add(topic.id);
				topics.push({
					topic,
					bookId: book?.id ?? block.bookId,
					bookTitle: book?.title ?? "",
					chapterSlug: block.chapterSlug,
				});
			}
		}
	}
	return topics;
}
