// Карточки проходят в приложении клуба, бот только напоминает: утром — тем,
// у кого в колоде есть что повторить, и по /today; /status — сводка статистики.
// Колода и прогресс общие с сайтом (D1), считает lib/stats.ts.

import { esc } from "./announce";
import { contentCache, loadDueBooks } from "./learning";
import type { BookStats, UserStats } from "./stats";
import { listSubscribers } from "./storage";
import { sendMessage } from "./telegram";
import { appKeyboard } from "./urls";

/** Русское склонение: 1 карточка, 2 карточки, 5 карточек. */
export function plural(n: number, one: string, few: string, many: string): string {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod10 === 1 && mod100 !== 11) return one;
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
	return many;
}

const cards = (n: number): string => `${n} ${plural(n, "карточка", "карточки", "карточек")}`;

/** Кнопка под напоминанием: сразу в повторение внутри Telegram. */
export const STUDY_BUTTON = "🗂 Повторить карточки";

/** Сколько и по каким книгам пора повторить. Книги — только с карточками к повторению. */
export function renderDueCards(due: BookStats[], opts: { morning?: boolean } = {}): string {
	const total = due.reduce((n, b) => n + b.due, 0);
	const head = opts.morning
		? `☀️ <b>Доброе утро!</b> Пора повторить ${cards(total)}:`
		: `🗂 К повторению ${cards(total)}:`;
	const lines = due.map((b) => `• ${esc(b.title)} — ${b.due}`);
	return `${head}\n\n${lines.join("\n")}`;
}

/** Колоды нет — напоминать не о чем: подсказываем, как её собрать. */
export const EMPTY_DECK_TEXT =
	"🗂 <b>Колода пуста</b>\n\n" +
	"Открой приложение клуба, выбери книгу и нажми «В колоду». " +
	"Я буду напоминать, когда её карточки пора повторить.";

export const ALL_DONE_TEXT =
	"🎉 Всё повторено — карточек к повторению сейчас нет. Загляни завтра!";

/** Сводка для /status. Подробности (календарь, книги) — в приложении. */
export function renderStatus(stats: UserStats): string {
	if (stats.books.length === 0) {
		return (
			"📊 <b>Твоя статистика</b>\n\n" +
			"Пока пусто: добавь книгу в колоду в приложении клуба и повтори первые карточки."
		);
	}
	const { totals, streak, reviews } = stats;
	const days = (n: number) => `${n} ${plural(n, "день", "дня", "дней")}`;
	const lines = [
		"📊 <b>Твоя статистика</b>",
		"",
		`🔥 Серия: <b>${days(streak.current)}</b>` +
			(streak.best > streak.current ? ` (рекорд — ${days(streak.best)})` : ""),
		`✅ Выучено: <b>${totals.mature}</b> из ${totals.cards}`,
		`📖 Изучаю: <b>${totals.learning}</b>`,
		`🔁 К повторению: <b>${totals.due}</b>`,
	];
	if (reviews.accuracy !== null) {
		lines.push(
			`🎯 Вспоминаешь: <b>${Math.round(reviews.accuracy * 100)}%</b> ответов · ` +
				`за неделю ${reviews.week} ${plural(reviews.week, "повторение", "повторения", "повторений")}`,
		);
	}
	lines.push("", "<b>По книгам</b>");
	for (const b of stats.books) {
		lines.push(
			`• ${esc(b.title)} — выучено ${b.mature} из ${b.total}` +
				(b.due > 0 ? `, к повторению ${b.due}` : ""),
		);
	}
	return lines.join("\n");
}

/** Пауза между подписчиками рассылки: держит темп ниже лимита ~30 msg/s. */
const BROADCAST_DELAY_MS = 75;

/**
 * Утреннее напоминание подписчикам (/start), у кого в колоде есть что
 * повторить. Пустая колода или всё повторено — не пишем.
 */
export async function runCardReminders(env: Env): Promise<void> {
	const subscribers = await listSubscribers(env.BOOK_CLUB_KV);
	const cache = contentCache();
	let sent = 0;
	for (const sub of subscribers) {
		try {
			const { due } = await loadDueBooks(env.BOOK_CLUB_DB, sub.chatId, cache);
			if (due.length === 0) continue;
			await sendMessage(
				env.BOT_TOKEN,
				sub.chatId,
				renderDueCards(due, { morning: true }),
				appKeyboard(env, STUDY_BUTTON, "/study"),
			);
			sent++;
		} catch (err) {
			// Сбой по одному человеку (например, бот заблокирован) не прерывает рассылку.
			console.error(`Не удалось напомнить о карточках ${sub.chatId}:`, err);
		}
		// Троттлинг: ожидание через setTimeout не тратит CPU-время воркера.
		await new Promise((r) => setTimeout(r, BROADCAST_DELAY_MS));
	}
	console.log(`Напоминания о карточках: ${sent} из ${subscribers.length} подписчиков`);
}
