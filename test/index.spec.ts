declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { CardProgress, DeckCard, Flashcard } from "../src/types";
import {
	calculateNextReview,
	initialProgress,
	reviewFromQuality,
	selectDue,
} from "../src/lib/spaced-repetition";
import { eventDateFromPath, eventPathById } from "../src/lib/events";
import { findSpeakerByUsername, telegramHandle } from "../src/lib/speakers";
import {
	assignClaim,
	cardKey,
	createSpeakerClaim,
	deleteSpeakerClaim,
	getSpeakerProfile,
	listSpeakerClaims,
	releaseClaimByTopic,
	resetSchemaCacheForTests,
	saveSpeakerIdentity,
	setClaimSlides,
} from "../src/lib/db";
import {
	mintSession,
	verifyInitData,
	verifyLoginWidget,
	verifySession,
} from "../src/lib/auth";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("worker fetch", () => {
	it("отвечает на GET health-check", async () => {
		const request = new IncomingRequest("http://example.com");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Книжного клуба");
	});
});

describe("вебхук: секрет обязателен (fail-closed)", () => {
	const SECRET = "test-webhook-secret";
	const update = JSON.stringify({ update_id: 1 });

	function webhookRequest(headers: Record<string, string> = {}) {
		return new IncomingRequest("http://example.com/", {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: update,
		});
	}

	it("без WEBHOOK_SECRET в env вебхук отключён (500)", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			webhookRequest({ "X-Telegram-Bot-Api-Secret-Token": SECRET }),
			{ ...env, WEBHOOK_SECRET: undefined },
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(500);
	});

	it("запрос без заголовка секрета отклоняется (403)", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			webhookRequest(),
			{ ...env, WEBHOOK_SECRET: SECRET },
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
	});

	it("запрос с неверным секретом отклоняется (403)", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			webhookRequest({ "X-Telegram-Bot-Api-Secret-Token": "wrong" }),
			{ ...env, WEBHOOK_SECRET: SECRET },
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
	});

	it("запрос с верным секретом принимается (200 OK)", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			webhookRequest({ "X-Telegram-Bot-Api-Secret-Token": SECRET }),
			{ ...env, WEBHOOK_SECRET: SECRET },
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("OK");
	});
});

describe("админские эндпоинты: Bearer-токен", () => {
	const TOKEN = "test-admin-token";

	function adminRequest(headers: Record<string, string> = {}) {
		return new IncomingRequest("http://example.com/api/admin/claims", { headers });
	}

	it("без токена — 401", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			adminRequest(),
			{ ...env, ADMIN_API_TOKEN: TOKEN },
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it("с неверным токеном — 401", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			adminRequest({ authorization: "Bearer wrong-token" }),
			{ ...env, ADMIN_API_TOKEN: TOKEN },
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it("если токен не задан в env — 401 даже с любым Bearer", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			adminRequest({ authorization: "Bearer anything" }),
			{ ...env, ADMIN_API_TOKEN: undefined },
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it("с верным токеном — 200", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			adminRequest({ authorization: `Bearer ${TOKEN}` }),
			{ ...env, ADMIN_API_TOKEN: TOKEN },
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
	});
});

describe("events: id ↔ путь файла", () => {
	it("live-эфир → live-talks/", () => {
		expect(eventPathById("live-2026-07-25-docker-doklady")).toBe(
			"live-talks/2026-07-25-docker-doklady.json",
		);
	});

	it("закрытая встреча → closed-chapters/", () => {
		expect(eventPathById("closed-2026-07-20-docker-glava-01")).toBe(
			"closed-chapters/2026-07-20-docker-glava-01.json",
		);
	});

	it("невалидный id → null", () => {
		expect(eventPathById("что-то-не-то")).toBeNull();
	});

	it("дата из пути события", () => {
		expect(eventDateFromPath("live-talks/2026-07-25-docker-doklady.json")).toBe("2026-07-25");
	});
});

describe("SM-2 calculateNextReview", () => {
	const now = 1_700_000_000_000;
	const DAY = 24 * 60 * 60 * 1000;

	it("первое успешное повторение → интервал 1 день", () => {
		const p = calculateNextReview(undefined, "easy", now);
		expect(p.repetition).toBe(1);
		expect(p.interval).toBe(1);
		expect(p.dueDate).toBe(now + DAY);
	});

	it("«Забыл» сбрасывает repetition и ставит интервал 1", () => {
		const seed = calculateNextReview(undefined, "easy", now); // rep=1
		const second = calculateNextReview(seed, "easy", now); // rep=2, interval=6
		expect(second.interval).toBe(6);
		const forgot = calculateNextReview(second, "again", now);
		expect(forgot.repetition).toBe(0);
		expect(forgot.interval).toBe(1);
	});

	it("коэффициент лёгкости не опускается ниже 1.3", () => {
		let p = calculateNextReview(undefined, "again", now);
		for (let i = 0; i < 10; i++) p = calculateNextReview(p, "again", now);
		expect(p.easiness).toBeGreaterThanOrEqual(1.3);
	});
});

describe("Telegram-аутентификация", () => {
	const TOKEN = "123456:test-bot-token";
	const enc = new TextEncoder();
	const hex = (b: ArrayBuffer) =>
		[...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

	async function hmacHex(keyRaw: Uint8Array, msg: string): Promise<string> {
		const key = await crypto.subtle.importKey(
			"raw",
			keyRaw as BufferSource,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
	}
	const sha256 = async (msg: string) =>
		new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(msg)));

	it("сессия: round-trip и отклонение подделки", async () => {
		const token = await mintSession(TOKEN, 777);
		expect(await verifySession(TOKEN, token)).toBe(777);
		expect(await verifySession(TOKEN, token + "x")).toBeNull();
		expect(await verifySession(TOKEN, "1.2.3")).toBeNull();
	});

	it("Login Widget: валидная подпись проходит, битая — нет", async () => {
		const now = Math.floor(Date.now() / 1000);
		const data: Record<string, string> = {
			id: "42",
			first_name: "Аня",
			username: "anya",
			auth_date: String(now),
		};
		const checkString = Object.keys(data)
			.sort()
			.map((k) => `${k}=${data[k]}`)
			.join("\n");
		data.hash = await hmacHex(await sha256(TOKEN), checkString);

		const user = await verifyLoginWidget(TOKEN, data);
		expect(user?.id).toBe(42);

		expect(await verifyLoginWidget(TOKEN, { ...data, hash: "deadbeef" })).toBeNull();
		expect(await verifyLoginWidget(TOKEN, { ...data, first_name: "Взлом" })).toBeNull();
	});

	it("Mini App initData: валидная подпись проходит", async () => {
		const now = Math.floor(Date.now() / 1000);
		const user = JSON.stringify({ id: 99, first_name: "Боб" });
		const pairs = { auth_date: String(now), user };
		const checkString = Object.entries(pairs)
			.map(([k, v]) => `${k}=${v}`)
			.sort()
			.join("\n");
		const secret = await crypto.subtle.importKey(
			"raw",
			enc.encode("WebAppData") as BufferSource,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const secretRaw = new Uint8Array(await crypto.subtle.sign("HMAC", secret, enc.encode(TOKEN)));
		const hash = await hmacHex(secretRaw, checkString);
		const initData = new URLSearchParams({ ...pairs, hash }).toString();

		const result = await verifyInitData(TOKEN, initData);
		expect(result?.id).toBe(99);
		expect(await verifyInitData(TOKEN, initData + "x")).toBeNull();
	});
});

describe("SM-2 reviewFromQuality (оценки сайта, 0–5)", () => {
	const now = 1_700_000_000_000;
	const DAY = 24 * 60 * 60 * 1000;

	it("quality=4 (good с сайта): интервалы 1 → 6 → round(6·EF)", () => {
		const p1 = reviewFromQuality(undefined, 4, now);
		expect(p1.repetition).toBe(1);
		expect(p1.interval).toBe(1);
		// При q=4 поправка EF равна нулю — остаётся дефолтные 2.5.
		expect(p1.easiness).toBeCloseTo(2.5);
		expect(p1.dueDate).toBe(now + DAY);

		const p2 = reviewFromQuality(p1, 4, now);
		expect(p2.repetition).toBe(2);
		expect(p2.interval).toBe(6);

		const p3 = reviewFromQuality(p2, 4, now);
		expect(p3.repetition).toBe(3);
		expect(p3.interval).toBe(Math.round(6 * p3.easiness));
	});

	it("quality<3 сбрасывает повторения, initialProgress — карточка к повторению сразу", () => {
		const seed = initialProgress("book:card", now);
		expect(seed.dueDate).toBe(now);
		const failed = reviewFromQuality(seed, 1, now);
		expect(failed.repetition).toBe(0);
		expect(failed.interval).toBe(1);
	});
});

describe("selectDue (общая для бота и рассылки выборка карточек)", () => {
	const now = 1_700_000_000_000;
	const card = (id: string): Flashcard => ({
		id,
		type: "qa",
		question: "q",
		answer: "a",
		chapter: "1",
		difficulty: "easy",
	});
	const deck: DeckCard[] = [
		{ book: "book-1", card: card("a") },
		{ book: "book-2", card: card("b") },
		{ book: "book-2", card: card("c") },
	];
	const keyOf = (d: DeckCard) => cardKey(d.book, d.card.id);

	it("новые карточки (без прогресса) подлежат повторению", () => {
		const due = selectDue(deck, keyOf, new Map(), now, 5);
		expect(due).toHaveLength(3);
	});

	it("соблюдает лимит", () => {
		const due = selectDue(deck, keyOf, new Map(), now, 1);
		expect(due).toHaveLength(1);
	});

	it("карточки с dueDate в будущем исключаются, просроченные — первыми", () => {
		const progress = new Map<string, CardProgress>([
			// «a» — повторять только завтра, не должна попасть в выборку.
			["book-1:a", { ...initialProgress("book-1:a", now), dueDate: now + 1 }],
			// «c» — просрочена сильнее, чем новая «b» (dueDate=0 у новых при сортировке).
			["book-2:c", { ...initialProgress("book-2:c", now), dueDate: now - 1000 }],
		]);
		const due = selectDue(deck, keyOf, progress, now, 5);
		expect(due.map((d) => d.card.id)).toEqual(["b", "c"]);
	});
});

describe("Сопоставление спикера по Telegram", () => {
	it("парсит хендл из ссылки, @ и голого ника", () => {
		expect(telegramHandle("https://t.me/Pomazkov_Anton")).toBe("pomazkov_anton");
		expect(telegramHandle("t.me/anton")).toBe("anton");
		expect(telegramHandle("@Anton")).toBe("anton");
		expect(telegramHandle("anton")).toBe("anton");
	});

	it("игнорирует инвайты и мусор", () => {
		expect(telegramHandle("https://t.me/+AbCdEf12")).toBeNull();
		expect(telegramHandle("https://t.me/joinchat/xxx")).toBeNull();
		expect(telegramHandle("")).toBeNull();
		expect(telegramHandle(undefined)).toBeNull();
	});

	it("находит спикера каталога по нику заявителя (без регистра)", () => {
		const index = {
			version: 1 as const,
			active_book: "b",
			books: [],
			events: [],
			speakers: [
				{ id: "pomazkov-anton", name: "Антон Помазков", socials: { telegram: "https://t.me/anton_p" } },
				{ id: "nikiforov-artem", name: "Артём Никифоров" },
			],
		};
		expect(findSpeakerByUsername(index, "Anton_P")?.id).toBe("pomazkov-anton");
		expect(findSpeakerByUsername(index, "unknown")).toBeNull();
		expect(findSpeakerByUsername(index, undefined)).toBeNull();
	});
});

describe("Единый источник занятости: заявки из CMS (D1)", () => {
	it("assign создаёт подтверждённую заявку, slides проставляет, release освобождает", async () => {
		// Хранилище D1 изолировано между тестами, а кэш «схема создана» — нет.
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		const topic = "test-topic-single-source";
		await releaseClaimByTopic(db, topic);

		await assignClaim(db, {
			topicId: topic,
			topicTitle: "Тестовая тема",
			bookId: "test-book",
			chapter: "01-test",
			speakerId: "sp-test",
			speakerName: "Спикер Тестовый",
		});
		let c = (await listSpeakerClaims(db)).find((x) => x.topic_id === topic);
		expect(c).toBeTruthy();
		expect(c?.status).toBe("confirmed");
		expect(c?.speaker_id).toBe("sp-test");
		expect(c?.full_name).toBe("Спикер Тестовый");

		await setClaimSlides(db, topic, "https://bc-1-test.pages.dev");
		c = (await listSpeakerClaims(db)).find((x) => x.topic_id === topic);
		expect(c?.slides_url).toBe("https://bc-1-test.pages.dev");

		// Повторный assign заменяет спикера, тема остаётся одна.
		await assignClaim(db, {
			topicId: topic,
			topicTitle: "Тестовая тема",
			bookId: "test-book",
			chapter: "01-test",
			speakerId: "sp-other",
			speakerName: "Другой Спикер",
		});
		const dupes = (await listSpeakerClaims(db)).filter((x) => x.topic_id === topic);
		expect(dupes).toHaveLength(1);
		expect(dupes[0].speaker_id).toBe("sp-other");

		await releaseClaimByTopic(db, topic);
		const gone = (await listSpeakerClaims(db)).find((x) => x.topic_id === topic);
		expect(gone).toBeUndefined();

		// ── Устойчивая личность спикера (переживает удаление заявок) ──────────────
		const chatId = 555000111;

		// Знакомство запоминается устойчиво; частичное обновление не затирает (COALESCE).
		await saveSpeakerIdentity(db, {
			chatId,
			fullName: "Пётр Тестовый",
			speakerId: "petrov-test",
			username: "petrov",
		});
		await saveSpeakerIdentity(db, { chatId, photoFileId: "photo-xyz" });

		// Берёт тему и её тут же отклоняют (заявка удаляется).
		const claim = await createSpeakerClaim(db, {
			topicId: null,
			topicTitle: "Своя тема",
			chatId,
			username: "petrov",
		});
		expect(claim).toBeTruthy();
		if (claim) await deleteSpeakerClaim(db, claim.id);

		// Профиль всё равно доступен — бот узнает вернувшегося спикера.
		const profile = await getSpeakerProfile(db, chatId);
		expect(profile?.fullName).toBe("Пётр Тестовый");
		expect(profile?.speakerId).toBe("petrov-test");
		expect(profile?.photoFileId).toBe("photo-xyz");
	});
});
