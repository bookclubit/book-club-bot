// Кто может брать темы докладов. Тема — обязательство перед клубом, поэтому
// слоты открыты только участникам клуба: тем, кто есть в каталоге спикеров
// (book-club-data) или чью заявку на участие одобрил админ. Новый человек
// сначала отправляет заявку с рассказом о себе.

import { fetchIndex } from "./api";
import { getMembershipRequest, getSpeakerProfile, type MembershipRequest } from "./db";
import { findSpeakerByUsername, type RegistrySpeaker } from "./speakers";

export interface SpeakerAccess {
	/** Можно выбирать темы докладов. */
	registered: boolean;
	/** Профиль в каталоге клуба, если узнали по Telegram-нику. */
	speaker: RegistrySpeaker | null;
	/** Имя для программы: каталог → прошлые доклады → заявка. */
	fullName: string | null;
	/** Фото для заявки на тему (из прошлых заявок или из заявки на участие). */
	photoFileId: string | null;
	/** Заявка на участие, если человек её отправлял. */
	request: MembershipRequest | null;
}

/**
 * Кто перед нами: участник клуба или новый человек. Каталог спикеров лежит в
 * git, поэтому его недоступность (GitHub) не должна закрывать доступ тем, кого
 * бот уже знает по прошлым докладам, — проверки независимы.
 */
export async function speakerAccess(
	env: Env,
	chatId: number,
	username?: string | null,
): Promise<SpeakerAccess> {
	let catalog: RegistrySpeaker | null = null;
	if (username) {
		try {
			catalog = findSpeakerByUsername(await fetchIndex(), username);
		} catch (err) {
			console.warn("Каталог спикеров недоступен — проверяем только по D1:", err);
		}
	}

	const [profile, request] = await Promise.all([
		getSpeakerProfile(env.BOOK_CLUB_DB, chatId),
		getMembershipRequest(env.BOOK_CLUB_DB, chatId),
	]);

	// speaker_id в профиле означает, что бот когда-то сопоставил человека
	// с каталогом, — он уже выступал, заявку на участие просить не за что.
	const registered =
		Boolean(catalog) || Boolean(profile?.speakerId) || request?.status === "approved";

	return {
		registered,
		speaker: catalog ?? (profile?.speakerId ? { id: profile.speakerId, name: profile.fullName } : null),
		fullName: catalog?.name ?? profile?.fullName ?? request?.full_name ?? null,
		photoFileId: profile?.photoFileId ?? request?.photo_file_id ?? null,
		request: request ?? null,
	};
}
