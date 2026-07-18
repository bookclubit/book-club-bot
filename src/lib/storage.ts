// Доступ к KV: подписчики рассылки. Прогресс карточек живёт в D1 (см. lib/db.ts).

import type { Subscriber } from "../types";

const SUB_PREFIX = "sub:";

const subKey = (chatId: number) => `${SUB_PREFIX}${chatId}`;

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
