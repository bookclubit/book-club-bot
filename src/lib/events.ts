// Работа с событиями клуба: id ↔ путь файла, загрузка, рендер ссылок.

import type { ClubEvent, ContentIndex, TopicRef } from "../types";
import { fetchChapter, fetchEventByPath, fetchIndex } from "./api";

/**
 * id события кодирует путь файла: `<prefix>-<date>-<slug>` →
 * `<dir>/<date>-<slug>.json` (prefix: closed → closed-chapters, live → live-talks).
 * Так их генерирует CMS.
 */
export function eventPathById(eventId: string): string | null {
	const match = eventId.match(/^(closed|live)-(\d{4}-\d{2}-\d{2}-.+)$/);
	if (!match) return null;
	const dir = match[1] === "closed" ? "closed-chapters" : "live-talks";
	return `${dir}/${match[2]}.json`;
}

export async function fetchEventById(eventId: string): Promise<ClubEvent | null> {
	// Быстрый путь: id по конвенции CMS кодирует имя файла.
	const path = eventPathById(eventId);
	if (path) {
		const event = await fetchEventByPath(path);
		if (event && event.id === eventId) return event;
	}

	// Фолбэк: у событий, созданных вручную, id может не совпадать с именем
	// файла — ищем перебором по реестру (событий немного).
	const index = await fetchIndex();
	for (const p of index.events) {
		const event = await fetchEventByPath(p);
		if (event?.id === eventId) return event;
	}
	return null;
}

/**
 * Темы программы события: у эфира указаны book_id и chapter, темы берутся
 * из chapter.json. book_id может быть и id из meta, и именем папки —
 * резолвим через реестр.
 */
export async function fetchEventTopics(event: ClubEvent): Promise<TopicRef[]> {
	if (event.type !== "live-talk" || !event.book_id || !event.chapter) return [];
	const index: ContentIndex = await fetchIndex();
	const folder =
		index.books.find((b) => b.id === event.book_id)?.folder ??
		index.books.find((b) => b.folder === event.book_id)?.folder;
	if (!folder) return [];
	const chapter = await fetchChapter(folder, event.chapter);
	return chapter?.topics ?? [];
}

/** Дата (YYYY-MM-DD) из пути события `<dir>/<date>-<slug>.json`. */
export function eventDateFromPath(path: string): string | null {
	return path.match(/\/(\d{4}-\d{2}-\d{2})-/)?.[1] ?? null;
}

/** Сегодняшняя дата по МСК (UTC+3, без переходов). */
export function mskToday(now = Date.now()): string {
	return new Date(now + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Момент начала события в epoch ms (время события — московское). */
export function eventStartMs(event: ClubEvent): number {
	return Date.parse(`${event.date}T${event.time}:00+03:00`);
}

/** Сообщение со всеми ссылками встречи: созвон, доска, материалы, трансляции. */
export function renderEventLinks(event: ClubEvent): string {
	const lines: string[] = [
		`📅 <b>${event.title}</b>`,
		`${event.date} в ${event.time} МСК`,
		"",
	];
	if (event.call_url) lines.push(`📞 Подключиться (Google Meet): ${event.call_url}`);
	if (event.streams?.youtube) lines.push(`▶️ YouTube: ${event.streams.youtube}`);
	if (event.streams?.vk) lines.push(`▶️ VK: ${event.streams.vk}`);
	if (event.type === "closed-chapter") {
		if (event.notes_board_url) lines.push(`📋 Доска для совместной работы: ${event.notes_board_url}`);
		if (event.pages) lines.push(`📖 Читаем страницы ${event.pages.from}–${event.pages.to}`);
	}
	for (const m of event.materials ?? []) {
		lines.push(`📎 ${m.title}: ${m.url}`);
	}
	return lines.join("\n");
}
