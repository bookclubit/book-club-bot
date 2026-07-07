// Доступ к KV: подписчики и прогресс повторения.

import type { CardProgress, Subscriber } from "../types";

const SUB_PREFIX = "sub:";
const PROGRESS_PREFIX = "progress:";

const subKey = (chatId: number) => `${SUB_PREFIX}${chatId}`;
const progressKey = (chatId: number, cardId: string) =>
	`${PROGRESS_PREFIX}${chatId}:${cardId}`;

// ── Подписчики ───────────────────────────────────────────────────────────────

export async function getSubscriber(
	kv: KVNamespace,
	chatId: number,
): Promise<Subscriber | null> {
	return kv.get<Subscriber>(subKey(chatId), "json");
}

export async function saveSubscriber(
	kv: KVNamespace,
	sub: Subscriber,
): Promise<void> {
	await kv.put(subKey(sub.chatId), JSON.stringify(sub));
}

export async function deleteSubscriber(
	kv: KVNamespace,
	chatId: number,
): Promise<void> {
	await kv.delete(subKey(chatId));
}

/** Возвращает всех подписчиков (для ежедневной рассылки). */
export async function listSubscribers(kv: KVNamespace): Promise<Subscriber[]> {
	const subscribers: Subscriber[] = [];
	let cursor: string | undefined;

	do {
		const page = await kv.list({ prefix: SUB_PREFIX, cursor });
		for (const key of page.keys) {
			const sub = await kv.get<Subscriber>(key.name, "json");
			if (sub) subscribers.push(sub);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);

	return subscribers;
}

// ── Прогресс повторения ──────────────────────────────────────────────────────

export async function getProgress(
	kv: KVNamespace,
	chatId: number,
	cardId: string,
): Promise<CardProgress | null> {
	return kv.get<CardProgress>(progressKey(chatId, cardId), "json");
}

export async function saveProgress(
	kv: KVNamespace,
	chatId: number,
	progress: CardProgress,
): Promise<void> {
	await kv.put(progressKey(chatId, progress.cardId), JSON.stringify(progress));
}

/** Загружает весь прогресс пользователя в map cardId → прогресс. */
export async function getProgressMap(
	kv: KVNamespace,
	chatId: number,
): Promise<Map<string, CardProgress>> {
	const map = new Map<string, CardProgress>();
	const prefix = `${PROGRESS_PREFIX}${chatId}:`;
	let cursor: string | undefined;

	do {
		const page = await kv.list({ prefix, cursor });
		for (const key of page.keys) {
			const p = await kv.get<CardProgress>(key.name, "json");
			if (p) map.set(p.cardId, p);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);

	return map;
}
