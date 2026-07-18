// Сопоставление участника Telegram с каталожным спикером (book-club-data)
// по его Telegram, указанному в CMS (socials.telegram). Так бот узнаёт
// вернувшегося спикера и не спрашивает имя/фото заново.

import type { ContentIndex } from "../types";

export interface RegistrySpeaker {
	id: string;
	name: string;
	avatar?: string;
}

/** Достаёт @-хендл из ссылки/строки Telegram: t.me/<handle>, @handle, handle. */
export function telegramHandle(value?: string): string | null {
	if (!value) return null;
	// Заякорено целиком: инвайты (t.me/+hash) и глубокие пути (t.me/joinchat/…) не пройдут.
	const m = value
		.trim()
		.match(/^(?:https?:\/\/)?(?:t\.me\/|telegram\.me\/|@)?([A-Za-z0-9_]{4,32})$/i);
	return m ? m[1].toLowerCase() : null;
}

/** Ищет спикера каталога по Telegram-username заявителя. */
export function findSpeakerByUsername(index: ContentIndex, username?: string | null): RegistrySpeaker | null {
	const u = username?.toLowerCase();
	if (!u) return null;
	for (const s of index.speakers ?? []) {
		if (telegramHandle(s.socials?.telegram) === u) {
			return { id: s.id, name: s.name, avatar: s.avatar };
		}
	}
	return null;
}
