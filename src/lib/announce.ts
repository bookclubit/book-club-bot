// Посты о встрече в группу клуба: анонс (сразу после создания встречи в CMS),
// афиша в день встречи и напоминание за 5 минут до начала.
//
// Текст собирается из трёх источников: поля встречи (их присылает CMS, потому
// что в book-club-data встреча появится только после мержа PR), книга и темы
// главы из book-club-data и спикеры из заявок в D1. Поэтому дневной пост уже
// знает спикеров, которых подтвердили после анонса.
//
// Без эмодзи: структуру держат жирные подзаголовки, пустые строки и ссылки.
// Всё, что называет человека или ресурс, — ссылка: спикеры и ведущие ведут в
// Telegram, книга — на страницу издателя (или на книгу в приложении клуба).

import { telegramHandle } from "./speakers";
import type { AnnounceKind, ClubEvent, TopicRef } from "../types";

/** Поля встречи, которых достаточно для постов (совпадают со схемой events/*.json). */
export interface AnnounceEvent {
	id: string;
	type: "closed-chapter" | "live-talk";
	title: string;
	date: string; // YYYY-MM-DD
	time: string; // HH:MM, МСК
	stream?: number;
	book_id?: string;
	chapter?: string;
	/** Что сделать до встречи: прочитать главу, подготовить вопросы… */
	assignment?: string;
	pages?: { from: number; to: number };
	streams?: { youtube?: string; vk?: string };
	call_url?: string;
	notes_board_url?: string;
	materials?: { title: string; url: string }[];
	moderators?: { name: string; speaker_id?: string }[];
}

/** Тема главы для поста: спикер из подтверждённой заявки, ссылкой на Telegram. */
export interface AnnounceTopic {
	order: number;
	title: string;
	speaker?: string;
	/** Telegram спикера: имя в посте становится ссылкой. */
	speakerUrl?: string;
	slidesUrl?: string;
}

export interface AnnounceBook {
	title: string;
	url?: string;
	authors: string[];
}

/** Человек из каталога клуба (speakers.json) — источник ссылок на Telegram. */
export interface AnnouncePerson {
	id: string;
	name: string;
	aliases?: string[];
	telegram?: string;
}

export interface AnnounceContext {
	event: AnnounceEvent;
	book?: AnnounceBook;
	chapterOrder?: number;
	chapterTitle?: string;
	topics: AnnounceTopic[];
	/** Каталог спикеров клуба: по нему имена ведущих превращаются в ссылки. */
	directory?: AnnouncePerson[];
}

const WEEKDAYS = [
	"Воскресенье",
	"Понедельник",
	"Вторник",
	"Среда",
	"Четверг",
	"Пятница",
	"Суббота",
];

const MONTHS = [
	"января",
	"февраля",
	"марта",
	"апреля",
	"мая",
	"июня",
	"июля",
	"августа",
	"сентября",
	"октября",
	"ноября",
	"декабря",
];

/** «Пятница, 24 июля, в 18:00 МСК». Время встречи — московское. */
export function formatWhen(date: string, time: string): string {
	const at = new Date(`${date}T12:00:00+03:00`);
	const day = Number(date.slice(8, 10));
	const month = MONTHS[Number(date.slice(5, 7)) - 1] ?? "";
	return `${WEEKDAYS[at.getUTCDay()]}, ${day} ${month}, в ${time} МСК`;
}

/** Экранирование под parse_mode=HTML: контент приходит из данных клуба. */
export function esc(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function link(url: string, label: string): string {
	return `<a href="${esc(url)}">${esc(label)}</a>`;
}

/** Ссылка на Telegram по значению из каталога (`@handle`, `t.me/handle`). */
export function telegramUrl(value?: string): string | null {
	const handle = telegramHandle(value);
	return handle ? `https://t.me/${handle}` : null;
}

/** Человек каталога по id спикера, имени или алиасу (регистр не важен). */
export function findPerson(
	directory: AnnouncePerson[] | undefined,
	person: { name?: string | null; speaker_id?: string | null },
): AnnouncePerson | null {
	const list = directory ?? [];
	if (person.speaker_id) {
		const byId = list.find((p) => p.id === person.speaker_id);
		if (byId) return byId;
	}
	const needle = person.name?.trim().toLowerCase();
	if (!needle) return null;
	return (
		list.find(
			(p) =>
				p.name.trim().toLowerCase() === needle ||
				(p.aliases ?? []).some((a) => a.trim().toLowerCase() === needle),
		) ?? null
	);
}

/** Имя человека ссылкой на его Telegram — если каталог знает ник. */
function personLink(ctx: AnnounceContext, person: { name: string; speaker_id?: string }): string {
	const url = telegramUrl(findPerson(ctx.directory, person)?.telegram);
	return url ? link(url, person.name) : esc(person.name);
}

/** «Книжный клуб №114: Начинаем новую книгу!» — номер стрима, если задан. */
function heading(ctx: AnnounceContext): string {
	const { event } = ctx;
	const prefix = event.stream ? `Книжный клуб №${event.stream}` : "Книжный клуб";
	return `<b>${esc(prefix)}: ${esc(event.title)}</b>`;
}

/** «Читаем «Название» (ссылка) — Автор». */
function bookLine(ctx: AnnounceContext, verb = "Читаем"): string | null {
	const book = ctx.book;
	if (!book) return null;
	const title = book.url ? link(book.url, `«${book.title}»`) : `«${esc(book.title)}»`;
	const authors = book.authors.length > 0 ? ` — ${esc(book.authors.join(", "))}` : "";
	return `${verb} ${title}${authors}`;
}

/**
 * Что сделать до встречи. Собирается из самой встречи — глава с названием
 * и страницы уже известны, поэтому руками в CMS ничего не заполняют.
 * Поле `assignment` в событии, если оно задано, перекрывает шаблон.
 */
function assignmentLines(ctx: AnnounceContext): string[] {
	const { event } = ctx;
	const pages = event.pages ? `страницы ${event.pages.from}–${event.pages.to}` : null;

	if (event.assignment?.trim()) {
		const parts = [esc(event.assignment.trim()), pages].filter(Boolean);
		return [`<b>Готовимся:</b> ${parts.join(", ")}`];
	}

	const chapter = ctx.chapterOrder
		? ctx.chapterTitle
			? `прочитать главу ${ctx.chapterOrder} «${esc(ctx.chapterTitle)}»`
			: `прочитать главу ${ctx.chapterOrder}`
		: null;
	const parts = [chapter, pages].filter(Boolean);
	if (parts.length === 0) return [];

	const tail =
		event.type === "live-talk"
			? "на эфире её разбирают докладчики"
			: "на созвоне разбираем её вместе";
	return [`<b>Готовимся:</b> ${parts.join(", ")} — ${tail}`];
}

/**
 * Программа эфира: «1. Восход AI-инженерии — Антон Помазков» (имя — ссылка
 * на Telegram). Главу не повторяем в каждой строке: её уже назвало задание.
 */
function topicLines(ctx: AnnounceContext): string[] {
	return ctx.topics.map((t, i) => {
		const speaker = t.speaker
			? ` — ${t.speakerUrl ? link(t.speakerUrl, t.speaker) : esc(t.speaker)}`
			: " — свободно";
		return `${i + 1}. ${esc(t.title)}${speaker}`;
	});
}

/**
 * Куда идти: трансляции одной строкой, созвон, доска и материалы — своими.
 * Вместо иконок ссылки подписаны словами, иначе без эмодзи это просто список.
 */
function linkLines(ctx: AnnounceContext): string[] {
	const { event } = ctx;
	const lines: string[] = [];
	const streams: string[] = [];
	if (event.streams?.youtube) streams.push(link(event.streams.youtube, "YouTube"));
	if (event.streams?.vk) streams.push(link(event.streams.vk, "VK"));
	if (streams.length > 0) lines.push(`Трансляция: ${streams.join(" · ")}`);
	if (event.call_url) lines.push(`Созвон: ${link(event.call_url, "Google Meet")}`);
	if (event.type === "closed-chapter" && event.notes_board_url) {
		lines.push(link(event.notes_board_url, "Доска обсуждения"));
	}
	for (const m of event.materials ?? []) {
		lines.push(link(m.url, m.title));
	}
	return lines;
}

/** Презентации докладов — появляются, когда спикер сдал слайды. */
function slideLines(ctx: AnnounceContext): string[] {
	return ctx.topics
		.filter((t) => t.slidesUrl)
		.map((t) => link(t.slidesUrl as string, `Презентация — ${t.title}`));
}

function join(blocks: (string | string[] | null)[]): string {
	return blocks
		.filter((b): b is string | string[] => b !== null && (Array.isArray(b) ? b.length > 0 : true))
		.map((b) => (Array.isArray(b) ? b.join("\n") : b))
		.join("\n\n");
}

/** Анонс сразу после создания встречи. */
export function renderAnnounce(ctx: AnnounceContext): string {
	const { event } = ctx;
	const moderators = (event.moderators ?? []).filter((m) => m.name);

	return join([
		heading(ctx),
		bookLine(ctx),
		formatWhen(event.date, event.time),
		assignmentLines(ctx),
		// У «докладов» — программа тем; у обсуждения главу уже назвало задание.
		event.type === "live-talk" && ctx.topics.length > 0
			? ["<b>Программа:</b>", ...topicLines(ctx)]
			: [],
		moderators.length > 0
			? `Ведут: ${moderators.map((m) => personLink(ctx, m)).join(", ")}`
			: null,
		linkLines(ctx),
	]);
}

/** Пост в день встречи (с новой афишей). */
export function renderDay(ctx: AnnounceContext): string {
	const { event } = ctx;
	return join([
		heading(ctx),
		bookLine(ctx, "На этом стриме читаем"),
		`Сегодня в ${esc(event.time)} МСК`,
		event.type === "live-talk" && ctx.topics.length > 0
			? ["<b>Рассмотрим темы:</b>", ...topicLines(ctx)]
			: ctx.chapterTitle
				? [`Разбираем главу ${ctx.chapterOrder} — ${esc(ctx.chapterTitle)}`]
				: [],
		linkLines(ctx),
		slideLines(ctx),
	]);
}

/** Напоминание за 5 минут до начала. */
export function renderSoon(ctx: AnnounceContext): string {
	const { event } = ctx;
	return join([
		`<b>Через 5 минут начинаем</b> — ${esc(event.title)}`,
		linkLines(ctx),
	]);
}

export function renderAnnouncement(kind: AnnounceKind, ctx: AnnounceContext): string {
	if (kind === "announce") return renderAnnounce(ctx);
	if (kind === "day") return renderDay(ctx);
	return renderSoon(ctx);
}

/** Подпись к фото в Telegram ограничена 1024 символами. */
export const CAPTION_LIMIT = 1024;

/**
 * Как называется пост и когда его обычно публикуют. Это подсказки для CMS,
 * а не расписание: момент публикации выбирает админ.
 */
export const KIND_INFO: Record<AnnounceKind, { title: string; when: string }> = {
	announce: { title: "Анонс", when: "сразу после создания встречи" },
	day: { title: "Афиша дня", when: "утром в день встречи" },
	soon: { title: "Напоминание", when: "за 5–10 минут до начала" },
};

/**
 * Темы главы + спикеры из заявок: одна форма для всех трёх постов.
 * Имя берём лучшее из известных — каталог клуба точнее того, что человек
 * ввёл в заявке, — а ссылку на Telegram: из ника заявки, иначе из каталога.
 */
export function buildTopics(
	chapterTopics: TopicRef[],
	claims: { topicId: string | null; username: string | null; fullName: string | null; status: string; slidesUrl: string | null }[],
	chapterOrder?: number,
	directory?: AnnouncePerson[],
): AnnounceTopic[] {
	return chapterTopics.map((topic, i) => {
		const claim = claims.find((c) => c.topicId === topic.id && c.status === "confirmed");
		const handle = claim?.username ?? null;
		const person = handle
			? ((directory ?? []).find((p) => telegramHandle(p.telegram) === handle.toLowerCase()) ?? null)
			: findPerson(directory, { name: claim?.fullName });
		const speaker = person?.name ?? claim?.fullName ?? (handle ? `@${handle}` : undefined);
		const speakerUrl = handle ? `https://t.me/${handle}` : telegramUrl(person?.telegram);
		return {
			order: chapterOrder ?? i + 1,
			title: topic.title,
			speaker,
			speakerUrl: speaker ? (speakerUrl ?? undefined) : undefined,
			slidesUrl: claim?.slidesUrl ?? undefined,
		};
	});
}

export function isAnnounceKind(value: string): value is AnnounceKind {
	return value === "announce" || value === "day" || value === "soon";
}

export type { ClubEvent };
