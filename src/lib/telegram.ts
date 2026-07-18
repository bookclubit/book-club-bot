// Обёртки над Telegram Bot API.

import type { InlineKeyboardMarkup } from "../types";

const API_BASE = "https://api.telegram.org/bot";

/** Вызов метода Bot API с повторами при сетевых ошибках / 5xx. */
async function callApi(
	token: string,
	method: string,
	body: Record<string, unknown>,
	retries = 3,
): Promise<unknown> {
	const url = `${API_BASE}${token}/${method}`;
	let lastError: unknown;

	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			if (res.ok) return await res.json();

			const text = await res.text();
			// 429/5xx — временные ошибки, повторяем; прочие 4xx — нет.
			if (res.status !== 429 && res.status < 500) {
				console.error(`Telegram ${method} → HTTP ${res.status}: ${text}`);
				throw new Error(`Telegram API ${method}: HTTP ${res.status}`);
			}
			lastError = new Error(`Telegram API ${method}: HTTP ${res.status} ${text}`);
		} catch (err) {
			lastError = err;
		}

		if (attempt < retries - 1) {
			await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
		}
	}

	console.error(`Telegram ${method} не удался после ${retries} попыток`, lastError);
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Отправляет сообщение. По умолчанию parse_mode=HTML. */
export function sendMessage(
	token: string,
	chatId: number,
	text: string,
	replyMarkup?: InlineKeyboardMarkup,
): Promise<unknown> {
	return callApi(token, "sendMessage", {
		chat_id: chatId,
		text,
		parse_mode: "HTML",
		disable_web_page_preview: true,
		...(replyMarkup ? { reply_markup: replyMarkup } : {}),
	});
}

/** Редактирует текст ранее отправленного сообщения (для раскрытия ответа). */
export function editMessageText(
	token: string,
	chatId: number,
	messageId: number,
	text: string,
	replyMarkup?: InlineKeyboardMarkup,
): Promise<unknown> {
	return callApi(token, "editMessageText", {
		chat_id: chatId,
		message_id: messageId,
		text,
		parse_mode: "HTML",
		disable_web_page_preview: true,
		...(replyMarkup ? { reply_markup: replyMarkup } : {}),
	});
}

/**
 * Скачивает файл из Telegram (фото спикера для CMS).
 * null — файл не найден или недоступен.
 */
export async function getFileResponse(token: string, fileId: string): Promise<Response | null> {
	try {
		const info = (await callApi(token, "getFile", { file_id: fileId })) as {
			result?: { file_path?: string };
		};
		const path = info.result?.file_path;
		if (!path) return null;
		const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
		return res.ok ? res : null;
	} catch {
		return null;
	}
}

/** Отвечает на callback_query (убирает «часики» на кнопке). */
export function answerCallback(
	token: string,
	callbackQueryId: string,
	text?: string,
): Promise<unknown> {
	return callApi(token, "answerCallbackQuery", {
		callback_query_id: callbackQueryId,
		...(text ? { text } : {}),
	});
}
