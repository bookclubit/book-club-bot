// Ссылки на приложения клуба. Адрес мини-приложения задаётся переменной
// MINIAPP_URL (wrangler.jsonc); дефолт — прод, чтобы деплой без переменной
// ничего не ломал.

import type { InlineKeyboardMarkup } from "../types";

export const DEFAULT_MINIAPP_URL = "https://book-club-miniapp.vercel.app";

export function miniappUrl(env: { MINIAPP_URL?: string }): string {
	return (env.MINIAPP_URL || DEFAULT_MINIAPP_URL).replace(/\/+$/, "");
}

/** Страница книги в приложении клуба (роут `/book/<папка>`). */
export function bookPageUrl(env: { MINIAPP_URL?: string }, folder: string): string {
	return `${miniappUrl(env)}/book/${folder}`;
}

/**
 * Кнопка, открывающая страницу приложения клуба прямо в Telegram (Mini App):
 * вход — по initData, без логина. Работает только в личке с ботом.
 */
export function appKeyboard(
	env: { MINIAPP_URL?: string },
	text: string,
	path = "/",
): InlineKeyboardMarkup {
	return { inline_keyboard: [[{ text, web_app: { url: `${miniappUrl(env)}${path}` } }]] };
}
