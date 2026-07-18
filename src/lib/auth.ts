// Аутентификация платформы через Telegram. Два источника, оба проверяются
// токеном бота (HMAC-SHA256) на стороне Worker:
//  - Login Widget (сайт в браузере): объект с полем hash;
//  - Mini App initData (внутри Telegram): подписанная query-строка.
// После проверки выдаём подписанную сессию (userId + срок), которой подписаны
// запросы к /api/me, /api/progress, /api/review.

export interface TgUser {
	id: number;
	username?: string;
	first_name?: string;
	last_name?: string;
	photo_url?: string;
}

const enc = new TextEncoder();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
const AUTH_MAX_AGE_S = 24 * 60 * 60; // свежесть подписи Telegram — сутки

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
}

async function hmac(keyRaw: Uint8Array, msg: string): Promise<Uint8Array> {
	const key = await importKey(keyRaw);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
	return new Uint8Array(sig);
}

async function sha256(msg: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(msg)));
}

/** Сравнение в постоянное время (защита от тайминг-атак). */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Проверяет данные Telegram Login Widget (объект с ключами и hash).
 * secret_key = SHA256(bot_token); строка проверки — «key=value», отсортированные
 * по ключу и склеенные \n (без hash). Возвращает пользователя или null.
 */
export async function verifyLoginWidget(
	botToken: string,
	data: Record<string, string>,
): Promise<TgUser | null> {
	const { hash, ...rest } = data;
	if (!hash) return null;

	const checkString = Object.keys(rest)
		.sort()
		.map((k) => `${k}=${rest[k]}`)
		.join("\n");
	const secret = await sha256(botToken);
	const computed = toHex(await hmac(secret, checkString));
	if (!timingSafeEqual(computed, hash)) return null;

	const authDate = Number(data.auth_date);
	if (Number.isFinite(authDate) && Date.now() / 1000 - authDate > AUTH_MAX_AGE_S) return null;

	const id = Number(data.id);
	if (!Number.isFinite(id)) return null;
	return {
		id,
		username: data.username,
		first_name: data.first_name,
		last_name: data.last_name,
		photo_url: data.photo_url,
	};
}

/**
 * Проверяет initData Telegram Mini App (подписанная query-строка).
 * secret_key = HMAC_SHA256("WebAppData", bot_token). Возвращает пользователя или null.
 */
export async function verifyInitData(botToken: string, initData: string): Promise<TgUser | null> {
	const params = new URLSearchParams(initData);
	const hash = params.get("hash");
	if (!hash) return null;
	params.delete("hash");

	const checkString = [...params.entries()]
		.map(([k, v]) => `${k}=${v}`)
		.sort()
		.join("\n");
	const secret = await hmac(enc.encode("WebAppData"), botToken);
	const computed = toHex(await hmac(secret, checkString));
	if (!timingSafeEqual(computed, hash)) return null;

	const authDate = Number(params.get("auth_date"));
	if (Number.isFinite(authDate) && Date.now() / 1000 - authDate > AUTH_MAX_AGE_S) return null;

	const userRaw = params.get("user");
	if (!userRaw) return null;
	try {
		const u = JSON.parse(userRaw) as TgUser;
		if (!Number.isFinite(u.id)) return null;
		return u;
	} catch {
		return null;
	}
}

// ── Сессия платформы ─────────────────────────────────────────────────────────

/** Ключ подписи сессий выводим из токена бота — отдельный секрет не нужен. */
async function sessionKey(botToken: string): Promise<Uint8Array> {
	return sha256(`${botToken}::platform-session`);
}

/** Подписанный токен сессии: `<userId>.<exp>.<hmac>`. */
export async function mintSession(botToken: string, userId: number): Promise<string> {
	const exp = Date.now() + SESSION_TTL_MS;
	const payload = `${userId}.${exp}`;
	const sig = toHex(await hmac(await sessionKey(botToken), payload));
	return `${payload}.${sig}`;
}

/** Возвращает userId, если сессия валидна и не истекла, иначе null. */
export async function verifySession(botToken: string, token: string): Promise<number | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [userIdStr, expStr, sig] = parts;
	const payload = `${userIdStr}.${expStr}`;
	const computed = toHex(await hmac(await sessionKey(botToken), payload));
	if (!timingSafeEqual(computed, sig)) return null;
	if (Number(expStr) < Date.now()) return null;
	const userId = Number(userIdStr);
	return Number.isFinite(userId) ? userId : null;
}
