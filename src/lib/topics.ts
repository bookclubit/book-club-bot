// Темы, объединённые в один доклад. Спикер иногда берёт две-три соседние темы
// главы и рассказывает их вместе: такие темы помечены общим `talk_group`
// (id ведущей темы). Для бота доклад неделим — тему берут, анонсируют и
// напоминают о ней целиком, поэтому группа склеивается в одну тему с
// названием через запятую сразу при чтении программы эфира.

import type { TopicRef } from "../types";

export function talkGroupKey(topic: TopicRef): string {
	return topic.talk_group?.trim() || topic.id;
}

/**
 * Темы «как их видит доклад»: объединённые склеены в одну. id группы — id её
 * первой темы: на него заводится заявка в D1 и по нему лежит монтажный ролик
 * встречи (`recordings`).
 */
export function mergeTalkTopics(topics: TopicRef[]): TopicRef[] {
	const out: TopicRef[] = [];
	const byKey = new Map<string, TopicRef>();
	for (const topic of topics) {
		const key = talkGroupKey(topic);
		const merged = byKey.get(key);
		if (merged) merged.title = `${merged.title}, ${topic.title}`;
		else {
			const created = { ...topic, id: topic.id, title: topic.title };
			byKey.set(key, created);
			out.push(created);
		}
	}
	return out;
}
