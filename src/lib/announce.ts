// Посты о встрече в группу клуба: анонс (сразу после создания встречи в CMS),
// афиша в день встречи и напоминание за 5 минут до начала.
//
// Текст собирается из трёх источников: поля встречи (их присылает CMS, потому
// что в book-club-data встреча появится только после мержа PR), книга и темы
// главы из book-club-data и спикеры из заявок в D1. Поэтому дневной пост уже
// знает спикеров, которых подтвердили после анонса.

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
	moderators?: { name: string }[];
}

/** Тема главы для поста: спикер — @username из заявки, если она подтверждена. */
export interface AnnounceTopic {
	order: number;
	title: string;
	speaker?: string;
	slidesUrl?: string;
}

export interface AnnounceBook {
	title: string;
	url?: string;
	authors: string[];
}

export interface AnnounceContext {
	event: AnnounceEvent;
	book?: AnnounceBook;
	chapterOrder?: number;
	chapterTitle?: string;
	topics: AnnounceTopic[];
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

/** «Книжный клуб №114: Начинаем новую книгу!» — номер стрима, если задан. */
function heading(ctx: AnnounceContext, icon: string): string {
	const { event } = ctx;
	const prefix = event.stream ? `Книжный клуб №${event.stream}` : "Книжный клуб";
	return `${icon} <b>${esc(prefix)}: ${esc(event.title)}</b>`;
}

/** «Читаем «Название» (ссылка) — Автор». */
function bookLine(ctx: AnnounceContext, verb = "Читаем"): string | null {
	const book = ctx.book;
	if (!book) return null;
	const title = book.url ? link(book.url, `«${book.title}»`) : `«${esc(book.title)}»`;
	const authors = book.authors.length > 0 ? ` — ${esc(book.authors.join(", "))}` : "";
	return `${verb} ${title}${authors}`;
}

/** Задание: свой текст из формы плюс страницы, если они заданы. */
function assignmentLines(ctx: AnnounceContext): string[] {
	const { event } = ctx;
	const parts: string[] = [];
	if (event.assignment?.trim()) parts.push(esc(event.assignment.trim()));
	if (event.pages) parts.push(`страницы ${event.pages.from}–${event.pages.to}`);
	if (parts.length === 0) return [];
	return [`📖 <b>Задание:</b> ${parts.join(", ")}`];
}

/** «🔴 Глава 1 — Восход AI-инженерии — @kunjutone». */
function topicLines(ctx: AnnounceContext): string[] {
	const order = ctx.chapterOrder;
	return ctx.topics.map((t) => {
		const chapter = order ? `Глава ${order} — ` : "";
		const speaker = t.speaker ? ` — ${esc(t.speaker)}` : " — свободно";
		return `🔴 ${chapter}${esc(t.title)}${speaker}`;
	});
}

/** Трансляции, созвон и доска — по одной ссылке на строку. */
function linkLines(ctx: AnnounceContext): string[] {
	const { event } = ctx;
	const lines: string[] = [];
	if (event.streams?.youtube) lines.push(`📱 ${link(event.streams.youtube, "YouTube")}`);
	if (event.streams?.vk) lines.push(`📱 ${link(event.streams.vk, "VK")}`);
	if (event.call_url) lines.push(`🎥 ${link(event.call_url, "Google Meet")}`);
	if (event.type === "closed-chapter" && event.notes_board_url) {
		lines.push(`📋 ${link(event.notes_board_url, "Доска обсуждения")}`);
	}
	for (const m of event.materials ?? []) {
		lines.push(`📎 ${link(m.url, m.title)}`);
	}
	return lines;
}

/** Презентации докладов — появляются, когда спикер сдал слайды. */
function slideLines(ctx: AnnounceContext): string[] {
	return ctx.topics
		.filter((t) => t.slidesUrl)
		.map((t) => `📊 ${link(t.slidesUrl as string, `Презентация — ${t.title}`)}`);
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
	const icon = event.type === "live-talk" ? "🔈" : "💬";
	const moderators = (event.moderators ?? []).map((m) => m.name).filter(Boolean);

	return join([
		heading(ctx, icon),
		bookLine(ctx),
		`🗓 ${formatWhen(event.date, event.time)}`,
		assignmentLines(ctx),
		event.type === "live-talk"
			? topicLines(ctx)
			: ctx.chapterTitle
				? [`📕 Разбираем главу ${ctx.chapterOrder} — ${esc(ctx.chapterTitle)}`]
				: [],
		moderators.length > 0 ? `🎙 Ведут: ${esc(moderators.join(", "))}` : null,
		linkLines(ctx),
	]);
}

/** Пост в день встречи (с новой афишей). */
export function renderDay(ctx: AnnounceContext): string {
	const { event } = ctx;
	return join([
		heading(ctx, "📣"),
		bookLine(ctx, "На этом стриме читаем"),
		`🗓 Сегодня в ${esc(event.time)} МСК`,
		event.type === "live-talk" && ctx.topics.length > 0
			? ["<b>Рассмотрим темы:</b>", ...topicLines(ctx)]
			: ctx.chapterTitle
				? [`📕 Разбираем главу ${ctx.chapterOrder} — ${esc(ctx.chapterTitle)}`]
				: [],
		linkLines(ctx),
		slideLines(ctx),
	]);
}

/** Напоминание за 5 минут до начала. */
export function renderSoon(ctx: AnnounceContext): string {
	const { event } = ctx;
	return join([
		`⏳ <b>Через 5 минут начинаем</b> — ${esc(event.title)}`,
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
 * Момент публикации поста: анонс — сразу, афиша дня — в 10:00 МСК в день
 * встречи (если это время уже прошло, постим сразу), напоминание — старт минус
 * 5 минут.
 */
export function runAtFor(kind: AnnounceKind, event: AnnounceEvent, now = Date.now()): number {
	const start = Date.parse(`${event.date}T${event.time}:00+03:00`);
	if (kind === "announce") return now;
	if (kind === "soon") return start - 5 * 60 * 1000;
	const morning = Date.parse(`${event.date}T10:00:00+03:00`);
	return Math.max(morning, now);
}

/** Темы главы + спикеры из заявок: одна форма для всех трёх постов. */
export function buildTopics(
	chapterTopics: TopicRef[],
	claims: { topicId: string | null; username: string | null; fullName: string | null; status: string; slidesUrl: string | null }[],
	chapterOrder?: number,
): AnnounceTopic[] {
	return chapterTopics.map((topic, i) => {
		const claim = claims.find((c) => c.topicId === topic.id && c.status === "confirmed");
		const speaker = claim?.username ? `@${claim.username}` : (claim?.fullName ?? undefined);
		return {
			order: chapterOrder ?? i + 1,
			title: topic.title,
			speaker,
			slidesUrl: claim?.slidesUrl ?? undefined,
		};
	});
}

export function isAnnounceKind(value: string): value is AnnounceKind {
	return value === "announce" || value === "day" || value === "soon";
}

export type { ClubEvent };
