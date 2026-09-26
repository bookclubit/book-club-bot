// Вход на сайт через бота — вместо Telegram Login Widget, чьё подтверждение
// приходит от Telegram по номеру телефона и в России не доходит. Сайт получает
// пару code + secret: code уходит в диплинк t.me/<бот>?start=login_<code>,
// человек подтверждает вход кнопкой в боте, а сессию забирает браузер, который
// знает secret. Code виден в чате, secret — нет: чужим браузером по ссылке
// из чата не войти.

import { randomHex, sha256Hex, timingSafeEqual } from "./auth";
import { confirmLoginRequest, consumeLoginRequest, createLoginRequest, getLoginRequest } from "./db";

/** Payload диплинка: /start login_<code>. */
export const LOGIN_START_PREFIX = "login_";

/** Сколько ждём подтверждения в боте. */
export const LOGIN_TTL_MS = 10 * 60 * 1000;

const CODE_RE = /^[0-9a-f]{32}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;

export const isLoginCode = (code: string): boolean => CODE_RE.test(code);
export const isLoginSecret = (secret: string): boolean => SECRET_RE.test(secret);

/** Новая заявка на вход: code — в диплинк, secret — остаётся в браузере. */
export async function startLogin(
	db: D1Database,
	now = Date.now(),
): Promise<{ code: string; secret: string }> {
	const code = randomHex(16);
	const secret = randomHex(32);
	await createLoginRequest(db, code, await sha256Hex(secret), now);
	return { code, secret };
}

/** Заявку ещё можно подтвердить в боте: свежая, не подтверждена и не использована. */
export async function loginPending(db: D1Database, code: string, now = Date.now()): Promise<boolean> {
	const req = await getLoginRequest(db, code);
	return Boolean(req && !req.confirmed_at && !req.used_at && now - req.created_at <= LOGIN_TTL_MS);
}

/** Подтверждение в боте. false — заявка устарела или её уже подтвердили. */
export function confirmLogin(
	db: D1Database,
	code: string,
	userId: number,
	now = Date.now(),
): Promise<boolean> {
	return confirmLoginRequest(db, code, userId, now, now - LOGIN_TTL_MS);
}

export type LoginCheck =
	| { status: "pending" }
	| { status: "ok"; userId: number }
	| { status: "expired" }
	| { status: "denied" };

/** Проверка из браузера: сессия выдаётся один раз и только знающему secret. */
export async function checkLogin(
	db: D1Database,
	code: string,
	secret: string,
	now = Date.now(),
): Promise<LoginCheck> {
	const req = await getLoginRequest(db, code);
	if (!req) return { status: "expired" };
	if (!timingSafeEqual(await sha256Hex(secret), req.secret_hash)) return { status: "denied" };
	if (req.used_at) return { status: "expired" };
	if (!req.confirmed_at || req.user_id === null) {
		return now - req.created_at > LOGIN_TTL_MS ? { status: "expired" } : { status: "pending" };
	}
	if (!(await consumeLoginRequest(db, code, now))) return { status: "expired" };
	return { status: "ok", userId: req.user_id };
}
