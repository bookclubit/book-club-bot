declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { groupCommand } from "../src/index";
import type { CardProgress, ClubEvent, Flashcard } from "../src/types";
import { initialProgress, reviewFromQuality } from "../src/lib/spaced-repetition";
import { eventArchived, eventDateFromPath, eventPathById, eventProgram } from "../src/lib/events";
import { bookScope, cardsInScope, deckFolders, parseDeck } from "../src/lib/deck";
import {
	checkLogin,
	confirmLogin,
	isLoginCode,
	isLoginSecret,
	LOGIN_TTL_MS,
	loginPending,
	startLogin,
} from "../src/lib/login";
import {
	ACTIVITY_DAYS,
	computeStats,
	MATURE_DAYS,
	streaks,
	type BookStats,
} from "../src/lib/stats";
import { renderDueCards, renderStatus } from "../src/lib/reminders";
import { appKeyboard } from "../src/lib/urls";
import { mergeTalkTopics } from "../src/lib/topics";
import { ANNOUNCE_MARK, buildTopics, renderAnnounce, renderDay, renderSoon } from "../src/lib/announce";
import {
	getDraftPoster,
	prepareDrafts,
	publishDraft,
	refreshDraft,
	runScheduledPosts,
	setDraftPoster,
	suggestedPublishAt,
} from "../src/lib/announcer";
import { findSpeakerByUsername, telegramHandle } from "../src/lib/speakers";
import {
	addAnnounceChat,
	addDeckBook,
	ANNOUNCE_CHAT_KEY,
	assignClaim,
	cancelLoginRequest,
	createSpeakerClaim,
	deleteSpeakerClaim,
	findSpeakerChat,
	getCardProgressMap,
	getClaimByTopic,
	getDeck,
	getPostDraft,
	getSpeakerProfile,
	getUser,
	listReviews,
	mergeDeck,
	removeDeckBook,
	saveCardProgress,
	listAnnounceChats,
	listMembershipRequests,
	listDuePostDrafts,
	listPostDrafts,
	listSpeakerClaims,
	MAX_PUBLISH_ATTEMPTS,
	releaseClaimByTopic,
	removeAnnounceChat,
	resetSchemaCacheForTests,
	saveMembershipRequest,
	saveSpeakerIdentity,
	setBotSetting,
	setClaimSlides,
	setMembershipStatus,
	setPostDraftApproved,
	setPostDraftPoster,
	setPostDraftSchedule,
	setPostDraftText,
	updateSpeakerClaim,
	upsertUser,
	type MembershipRequest,
} from "../src/lib/db";
import { speakerAccess } from "../src/lib/members";
import { membershipPrompt, speakerIntro } from "../src/handlers/registration";
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

describe("Встреча прошла: через EVENT_HOURS после начала", () => {
	const event = {
		id: "live-2026-07-31-glava-9",
		type: "live-talk",
		title: "Серверные компоненты React",
		date: "2026-07-31",
		time: "23:00",
		timezone: "Europe/Moscow",
		talks: [],
	} as unknown as ClubEvent;
	// Начало — 23:00 МСК = 20:00 UTC.
	const start = Date.parse("2026-07-31T20:00:00Z");

	it("во время встречи — ещё не прошла", () => {
		expect(eventArchived(event, start + 3 * 3600 * 1000)).toBe(false);
	});

	it("через 4 часа после начала — прошла, флаг админа не нужен", () => {
		expect(eventArchived(event, start + 4 * 3600 * 1000)).toBe(true);
	});

	it("флаг finished отправляет в архив сразу", () => {
		expect(eventArchived({ ...event, finished: true }, start - 3600 * 1000)).toBe(true);
	});

	it("без времени начала — по дате, на следующий день", () => {
		const noTime = { ...event, time: "" } as unknown as ClubEvent;
		// 1 августа 00:30 МСК — дата встречи уже позади.
		expect(eventArchived(noTime, Date.parse("2026-07-31T21:30:00Z"))).toBe(true);
		// 31 июля 23:30 МСК — ещё её день.
		expect(eventArchived(noTime, Date.parse("2026-07-31T20:30:00Z"))).toBe(false);
	});
});

describe("Программа эфира: несколько глав и книг", () => {
	const event = {
		id: "live-2026-08-14-dve-glavy",
		type: "live-talk" as const,
		title: "Две главы за вечер",
		date: "2026-08-14",
		time: "18:00",
		talks: [],
		program: [
			{ book_id: "fluent-react", chapter: "09-servernye-komponenty-react" },
			{ book_id: "docker-intro", chapter: "10-monitoring", topic_ids: ["docker-intro-10-1"] },
		],
	} as unknown as ClubEvent;

	it("программа берётся из блоков", () => {
		expect(eventProgram(event)).toHaveLength(2);
		expect(eventProgram(event)[1].topic_ids).toEqual(["docker-intro-10-1"]);
	});

	it("старая встреча без program — это тот же один блок", () => {
		const old = {
			id: "live-2026-07-24-osnovy",
			type: "live-talk",
			title: "Начинаем",
			date: "2026-07-24",
			time: "18:00",
			talks: [],
			book_id: "ai-engineering",
			chapter: "01-osnovy",
			topic_ids: ["ai-1-2"],
		} as unknown as ClubEvent;
		expect(eventProgram(old)).toEqual([
			{ book_id: "ai-engineering", chapter: "01-osnovy", topic_ids: ["ai-1-2"] },
		]);
	});

	const ctx = {
		// Страницы заданы — у «докладов» задание пишется только с ними.
		event: {
			id: event.id,
			type: "live-talk" as const,
			title: event.title,
			date: event.date,
			time: event.time,
			pages: { from: 210, to: 260 },
		},
		chapters: [
			{
				order: 9,
				title: "Серверные компоненты React",
				bookTitle: "React. К вершинам мастерства",
				topics: [
					{ order: 9, title: "Преимущества", speaker: "Антон Помазков", speakerUrl: "https://t.me/kunjutone" },
					{ order: 9, title: "Серверные действия" },
				],
			},
			{
				order: 10,
				title: "Мониторинг",
				bookTitle: "Docker. Вводный курс",
				topics: [{ order: 10, title: "Prometheus", speaker: "Артём" }],
			},
		],
		topics: [],
	};

	it("задание перечисляет все главы программы", () => {
		const text = renderAnnounce(ctx);
		expect(text).toContain(
			"прочитать главы 9 «Серверные компоненты React» (React. К вершинам мастерства) и 10 «Мониторинг» (Docker. Вводный курс)",
		);
	});

	it("темы сгруппированы по главам, нумерация сквозная", () => {
		const text = renderAnnounce(ctx);
		expect(text).toContain("React. К вершинам мастерства, глава 9 — Серверные компоненты React:");
		expect(text).toContain('1. Преимущества — <a href="https://t.me/kunjutone">Антон Помазков</a>');
		expect(text).toContain("2. Серверные действия — свободно");
		expect(text).toContain("Docker. Вводный курс, глава 10 — Мониторинг:");
		expect(text).toContain("3. Prometheus — Артём");
	});
});

describe("Объединённые темы: несколько тем — один доклад", () => {
	// CMS помечает группу целиком, включая ведущую тему: ключ — её id.
	const topics = [
		{ id: "react-10-1", title: "Vue.js", talk_group: "react-10-1" },
		{ id: "react-10-2", title: "Angular", talk_group: "react-10-1" },
		{ id: "react-10-3", title: "Svelte", talk_group: "react-10-1" },
		{ id: "react-10-4", title: "Qwik" },
	];

	it("группа склеивается в одну тему с названиями через запятую", () => {
		expect(mergeTalkTopics(topics)).toEqual([
			{ id: "react-10-1", title: "Vue.js, Angular, Svelte", talk_group: "react-10-1" },
			{ id: "react-10-4", title: "Qwik" },
		]);
	});

	it("id доклада — id первой темы группы: на него заведена бронь в D1", () => {
		expect(mergeTalkTopics(topics)[0].id).toBe("react-10-1");
	});

	it("тема без группы остаётся собой", () => {
		expect(mergeTalkTopics([topics[3]])).toEqual([{ id: "react-10-4", title: "Qwik" }]);
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

	it("коэффициент лёгкости не опускается ниже 1.3", () => {
		let p = reviewFromQuality(undefined, 1, now);
		for (let i = 0; i < 10; i++) p = reviewFromQuality(p, 1, now);
		expect(p.easiness).toBeGreaterThanOrEqual(1.3);
	});
});

describe("Колода: общая для сайта и бота", () => {
	const card = (id: string, chapter: string): Flashcard => ({
		id,
		type: "qa",
		question: "q",
		answer: "a",
		chapter,
		difficulty: "easy",
	});
	const sorted = (list: string[]) => [...list].sort();

	it("книга целиком, отдельные главы или ничего — как на сайте", () => {
		const deck = { books: ["docker"], chapters: ["react::2", "react::3"] };
		expect(bookScope(deck, "docker")).toBe("all");
		expect(bookScope(deck, "ai")).toBeNull();
		const cards = [card("r1", "1"), card("r2", "2"), card("r3", "3")];
		expect(cardsInScope(cards, bookScope(deck, "react")).map((c) => c.id)).toEqual(["r2", "r3"]);
		expect(deckFolders(deck)).toEqual(["docker", "react"]);
	});

	it("колода из запроса: мусор и дубли отбрасываются", () => {
		expect(
			parseDeck({ books: ["docker", "../etc", 5, "docker"], chapters: ["react::2", "react::x", "evil"] }),
		).toEqual({ books: ["docker"], chapters: ["react::2"] });
		expect(parseDeck(null)).toEqual({ books: [], chapters: [] });
	});

	it("добавление, удаление и слияние с устройства (D1)", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		const user = 7001;
		await addDeckBook(db, user, "docker");
		await mergeDeck(db, user, { books: ["fluent-react"], chapters: ["docker::2", "ai-engineering::1"] });
		let deck = await getDeck(db, user);
		// Глава книги, которая уже в колоде целиком, лишняя.
		expect(sorted(deck.books)).toEqual(["docker", "fluent-react"]);
		expect(deck.chapters).toEqual(["ai-engineering::1"]);

		// Книга целиком вытесняет подписки на её главы.
		await addDeckBook(db, user, "ai-engineering");
		deck = await getDeck(db, user);
		expect(deck.chapters).toEqual([]);
		expect(sorted(deck.books)).toEqual(["ai-engineering", "docker", "fluent-react"]);

		await removeDeckBook(db, user, "docker");
		expect(sorted((await getDeck(db, user)).books)).toEqual(["ai-engineering", "fluent-react"]);
		// Колода у каждого своя.
		expect(await getDeck(db, 7002)).toEqual({ books: [], chapters: [] });
	});
});

describe("Вход на сайт через бота", () => {
	it("заявка → кнопка в боте → сессия один раз и только своему браузеру", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		const now = Date.now();
		const { code, secret } = await startLogin(db, now);
		expect(isLoginCode(code)).toBe(true);
		expect(isLoginSecret(secret)).toBe(true);
		expect(await loginPending(db, code, now)).toBe(true);
		expect(await checkLogin(db, code, secret, now)).toEqual({ status: "pending" });

		expect(await confirmLogin(db, code, 555, now + 1000)).toBe(true);
		// Подтверждённую заявку второй раз (или другим человеком) не перехватить.
		expect(await confirmLogin(db, code, 666, now + 2000)).toBe(false);
		expect(await loginPending(db, code, now + 2000)).toBe(false);

		// code виден в чате с ботом, но без secret сессию не получить.
		expect(await checkLogin(db, code, "0".repeat(64), now + 3000)).toEqual({ status: "denied" });

		expect(await checkLogin(db, code, secret, now + 3000)).toEqual({ status: "ok", userId: 555 });
		expect(await checkLogin(db, code, secret, now + 4000)).toEqual({ status: "expired" });
	});

	it("неподтверждённая заявка устаревает, «Отмена» её удаляет", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		const now = Date.now();
		const late = now + LOGIN_TTL_MS + 1;
		const old = await startLogin(db, now);
		expect(await confirmLogin(db, old.code, 555, late)).toBe(false);
		expect(await checkLogin(db, old.code, old.secret, late)).toEqual({ status: "expired" });

		const fresh = await startLogin(db, now);
		await cancelLoginRequest(db, fresh.code);
		expect(await checkLogin(db, fresh.code, fresh.secret, now)).toEqual({ status: "expired" });
	});

	it("HTTP: /api/auth/bot выдаёт code и secret, check — сессию после подтверждения", async () => {
		resetSchemaCacheForTests();
		const testEnv = { ...env, BOT_TOKEN: "123456:test-bot-token" };
		const call = async (path: string, body: unknown = {}) => {
			const ctx = createExecutionContext();
			const res = await worker.fetch(
				new IncomingRequest(`http://example.com${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
				testEnv,
				ctx,
			);
			await waitOnExecutionContext(ctx);
			return res;
		};

		const started = (await (await call("/api/auth/bot")).json()) as { code: string; secret: string };
		expect(await (await call("/api/auth/bot/check", started)).json()).toEqual({ status: "pending" });

		await upsertUser(env.BOOK_CLUB_DB, { id: 4242, username: "reader", firstName: "Читатель" });
		expect(await confirmLogin(env.BOOK_CLUB_DB, started.code, 4242)).toBe(true);
		const data = (await (await call("/api/auth/bot/check", started)).json()) as {
			status: string;
			token: string;
			user: { id: number; username: string };
		};
		expect(data.status).toBe("ok");
		expect(data.user).toMatchObject({ id: 4242, username: "reader" });
		expect(await verifySession(testEnv.BOT_TOKEN, data.token)).toBe(4242);

		expect((await call("/api/auth/bot/check", started)).status).toBe(410);
		expect((await call("/api/auth/bot/check", { code: "x", secret: "y" })).status).toBe(400);
	});

	it("вход через бота не стирает фото, пришедшее из Mini App", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		await upsertUser(db, { id: 4343, firstName: "Аня", photoUrl: "https://t.me/i/userpic/anya.jpg" });
		await upsertUser(db, { id: 4343, firstName: "Аня", username: "anya" });
		const user = await getUser(db, 4343);
		expect(user?.photo_url).toBe("https://t.me/i/userpic/anya.jpg");
		expect(user?.username).toBe("anya");
	});
});

describe("Статистика изучения", () => {
	const DAY = 24 * 60 * 60 * 1000;
	const now = Date.parse("2026-09-26T12:00:00+03:00");
	const card = (id: string, chapter = "1"): Flashcard => ({
		id,
		type: "qa",
		question: "q",
		answer: "a",
		chapter,
		difficulty: "easy",
	});
	const learned = (key: string, interval: number, dueDate: number): [string, CardProgress] => [
		key,
		{ cardId: key, repetition: 2, interval, easiness: 2.5, dueDate, lastReviewed: now - DAY },
	];
	const books = [
		{ folder: "docker", title: "Docker", cards: [card("d1"), card("d2"), card("d3")] },
		{ folder: "react", title: "React", cards: [card("r1"), card("r2", "2")] },
		{ folder: "ai", title: "AI", cards: [card("a1")] },
	];
	const noDeck = { books: [], chapters: [] };

	it("выучено, изучаю, новые; к повторению — только по колоде", () => {
		const stats = computeStats({
			books,
			deck: { books: ["docker"], chapters: [] },
			progress: new Map([
				learned("docker:d1", MATURE_DAYS, now + 5 * DAY), // выучена и не к повторению
				learned("docker:d2", 3, now - DAY), // изучается, срок подошёл
				learned("react:r1", 6, now - DAY), // книги нет в колоде: прогресс виден, напоминать не о чем
			]),
			reviews: [],
			now,
		});
		// ai — ни в колоде, ни в прогрессе: в статистику не попадает.
		expect(stats.books.map((b) => b.folder)).toEqual(["docker", "react"]);
		const [docker, react] = stats.books;
		expect(docker).toMatchObject({ in_deck: true, total: 3, mature: 1, learning: 1, fresh: 1, due: 2 });
		expect(react).toMatchObject({ in_deck: false, total: 2, learning: 1, fresh: 1, due: 0 });
		expect(stats.totals).toEqual({ cards: 5, fresh: 2, learning: 2, mature: 1, due: 2 });
	});

	it("подписка на главу: к повторению только её карточки", () => {
		const stats = computeStats({
			books,
			deck: { books: [], chapters: ["react::2"] },
			progress: new Map(),
			reviews: [],
			now,
		});
		expect(stats.books).toHaveLength(1);
		expect(stats.books[0]).toMatchObject({ folder: "react", in_deck: true, total: 2, fresh: 2, due: 1 });
	});

	it("активность по дням МСК, серия и доля вспомненного", () => {
		const reviews = [
			{ at: Date.parse("2026-09-26T09:00:00+03:00"), quality: 4 },
			{ at: Date.parse("2026-09-25T20:00:00+03:00"), quality: 1 },
			{ at: Date.parse("2026-09-25T21:00:00+03:00"), quality: 5 },
			// 00:30 по Москве — уже 24-е, хотя по UTC ещё 23-е.
			{ at: Date.parse("2026-09-24T00:30:00+03:00"), quality: 3 },
			{ at: Date.parse("2026-09-21T12:00:00+03:00"), quality: 4 },
		];
		const stats = computeStats({ books, deck: noDeck, progress: new Map(), reviews, now });
		expect(stats.activity).toHaveLength(ACTIVITY_DAYS);
		expect(stats.activity.at(-1)).toEqual({ date: "2026-09-26", count: 1 });
		expect(stats.activity.at(-2)).toEqual({ date: "2026-09-25", count: 2 });
		expect(stats.activity.at(-3)).toEqual({ date: "2026-09-24", count: 1 });
		expect(stats.activity.at(-4)).toEqual({ date: "2026-09-23", count: 0 });
		expect(stats.streak).toEqual({ current: 3, best: 3 });
		expect(stats.reviews).toEqual({ total: 5, today: 1, week: 5, accuracy: 4 / 5 });
	});

	it("серия не рвётся, пока сегодня ещё не занимался", () => {
		expect(streaks(["2026-09-24", "2026-09-25"], "2026-09-26")).toEqual({ current: 2, best: 2 });
		expect(streaks(["2026-09-22", "2026-09-23", "2026-09-24"], "2026-09-26")).toEqual({
			current: 0,
			best: 3,
		});
		expect(streaks([], "2026-09-26")).toEqual({ current: 0, best: 0 });
	});
});

describe("Напоминания о карточках", () => {
	const book = (title: string, due: number): BookStats => ({
		folder: title.toLowerCase(),
		title,
		in_deck: true,
		total: 10,
		fresh: 0,
		learning: 0,
		mature: 0,
		due,
		last_reviewed: null,
	});

	it("утреннее: сколько и по каким книгам, со склонением и экранированием", () => {
		const text = renderDueCards([book("Docker", 1), book("React <19>", 3)], { morning: true });
		expect(text).toContain("Пора повторить 4 карточки");
		expect(text).toContain("• Docker — 1");
		expect(text).toContain("• React &lt;19&gt; — 3");
		expect(renderDueCards([book("Docker", 5)])).toContain("К повторению 5 карточек");
		expect(renderDueCards([book("Docker", 21)])).toContain("21 карточка");
	});

	it("кнопка открывает приложение внутри Telegram (web_app)", () => {
		const kb = appKeyboard({ MINIAPP_URL: "https://app.example/" }, "Повторить", "/study");
		expect(kb.inline_keyboard[0][0]).toEqual({
			text: "Повторить",
			web_app: { url: "https://app.example/study" },
		});
	});

	it("сводка /status считается той же статистикой, что на сайте", () => {
		const stats = computeStats({
			books: [{ folder: "docker", title: "Docker", cards: [] }],
			deck: { books: ["docker"], chapters: [] },
			progress: new Map(),
			reviews: [{ at: Date.now(), quality: 4 }],
			now: Date.now(),
		});
		const text = renderStatus(stats);
		expect(text).toContain("Серия: <b>1 день</b>");
		expect(text).toContain("Вспоминаешь: <b>100%</b>");
		expect(text).toContain("• Docker — выучено 0 из 0");

		const empty = computeStats({ books: [], deck: { books: [], chapters: [] }, progress: new Map(), reviews: [], now: Date.now() });
		expect(renderStatus(empty)).toContain("Пока пусто");
	});
});

describe("API карточек: колода, импорт, журнал", () => {
	const TOKEN = "123456:test-bot-token";
	const testEnv = { ...env, BOT_TOKEN: TOKEN };

	async function api(
		path: string,
		userId: number | null,
		init: { method?: string; body?: unknown } = {},
	): Promise<Response> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (userId !== null) headers.authorization = `Bearer ${await mintSession(TOKEN, userId)}`;
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new IncomingRequest(`http://example.com${path}`, {
				method: init.method ?? "GET",
				headers,
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			}),
			testEnv,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		return res;
	}
	const post = (path: string, userId: number | null, body: unknown) =>
		api(path, userId, { method: "POST", body });

	it("без входа — 401", async () => {
		expect((await api("/api/deck", null)).status).toBe(401);
		expect((await api("/api/stats", null)).status).toBe(401);
		expect((await post("/api/deck", null, { action: "add", book: "docker" })).status).toBe(401);
		expect((await post("/api/progress/import", null, { items: [] })).status).toBe(401);
	});

	it("колода: add, merge, remove; чужие папки не принимаются", async () => {
		resetSchemaCacheForTests();
		let res = await post("/api/deck", 9001, { action: "add", book: "docker-up-and-running" });
		expect(await res.json()).toEqual({ deck: { books: ["docker-up-and-running"], chapters: [] } });

		expect((await post("/api/deck", 9001, { action: "add", book: "../../etc" })).status).toBe(400);
		expect((await post("/api/deck", 9001, { action: "wipe" })).status).toBe(400);

		await post("/api/deck", 9001, { action: "merge", books: ["fluent-react"], chapters: ["ai-engineering::1"] });
		res = await post("/api/deck", 9001, { action: "remove", book: "docker-up-and-running" });
		expect(await res.json()).toEqual({ deck: { books: ["fluent-react"], chapters: ["ai-engineering::1"] } });
		expect(await (await api("/api/deck", 9001)).json()).toEqual({
			deck: { books: ["fluent-react"], chapters: ["ai-engineering::1"] },
		});
	});

	it("импорт гостевого прогресса не перетирает серверный и отбрасывает мусор", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		const now = Date.now();
		await saveCardProgress(db, 9002, "docker", {
			cardId: "docker:d1",
			repetition: 3,
			interval: 15,
			easiness: 2.6,
			dueDate: now + 1000,
			lastReviewed: now - 1000,
		});
		const item = (card_id: string, interval: number) => ({
			book_id: "docker",
			card_id,
			repetition: 1,
			interval,
			easiness: 2.5,
			due_date: now,
			last_reviewed: now - 5000,
		});
		const res = await post("/api/progress/import", 9002, {
			items: [item("d1", 1), item("d2", 6), { book_id: "../x", card_id: "d3" }, item("d4", -5)],
		});
		expect(await res.json()).toEqual({ imported: 1 });
		const map = await getCardProgressMap(db, 9002);
		expect(map.get("docker:d1")?.interval).toBe(15);
		expect(map.get("docker:d2")?.interval).toBe(6);
		expect(map.has("docker:d3")).toBe(false);
		expect(map.has("docker:d4")).toBe(false);
	});

	it("оценка карточки пишется в прогресс и в журнал", async () => {
		resetSchemaCacheForTests();
		const res = await post("/api/review", 9003, { card_id: "d1", book_id: "docker", grade: "good" });
		expect(res.status).toBe(200);
		const reviews = await listReviews(env.BOOK_CLUB_DB, 9003);
		expect(reviews).toHaveLength(1);
		expect(reviews[0].quality).toBe(4);
		expect((await getCardProgressMap(env.BOOK_CLUB_DB, 9003)).get("docker:d1")?.repetition).toBe(1);
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

describe("Посты о встрече в группу клуба", () => {
	const talkEvent = {
		id: "live-2026-07-24-osnovy",
		type: "live-talk" as const,
		title: "Начинаем новую книгу!",
		date: "2026-07-24",
		time: "18:00",
		stream: 114,
		book_id: "ai-engineering",
		chapter: "01-osnovy",
		streams: { youtube: "https://youtu.be/x", vk: "https://vkvideo.ru/y" },
	};

	const ctx = {
		event: talkEvent,
		book: {
			title: "AI-инженерия",
			url: "https://oreilly.com/ai-engineering",
			authors: ["Чип Хьюен"],
		},
		chapterOrder: 1,
		chapterTitle: "Основы создания AI-приложений",
		topics: [
			{
				order: 1,
				title: "Восход AI-инженерии",
				speaker: "Антон Помазков",
				speakerUrl: "https://t.me/kunjutone",
			},
			{ order: 1, title: "Стек AI-инженерии", speaker: "@Frich22", slidesUrl: "https://slides" },
			{ order: 1, title: "Планирование AI-приложений" },
		],
	};

	it("анонс: номер стрима, книга с автором, дата по-русски, темы со спикерами", () => {
		const text = renderAnnounce(ctx);
		// Жирным — только клуб с номером, перед ним рупор.
		expect(text.startsWith("🔊 <b>Книжный клуб №114:</b> Начинаем новую книгу!")).toBe(true);
		expect(text).toContain("<b>Пятница, 24 июля, в 18:00 МСК</b>");
		// Первая глава — значит, книга новая; название — жирная ссылка.
		expect(text).toContain(
			'Начинаем в клубе читать новую книгу — <b><a href="https://oreilly.com/ai-engineering">AI-инженерия</a></b> от Чип Хьюен',
		);
		// У «докладов» задания нет: главу называют заголовок и программа.
		expect(text).not.toContain("Готовимся:");
		// Подзаголовок программы отделён от списка пустой строкой.
		expect(text).toContain("<b>Программа:</b>\n\n1. Восход AI-инженерии");
		// Спикер в программе — ссылка на его Telegram.
		expect(text).toContain(
			'1. Восход AI-инженерии — <a href="https://t.me/kunjutone">Антон Помазков</a>',
		);
		// Тема без заявки не выпадает из программы, а помечается свободной.
		expect(text).toContain("3. Планирование AI-приложений — свободно");
		expect(text).toContain('Трансляция: <a href="https://youtu.be/x">YouTube</a>');
	});

	it("не первая глава — книгу «читаем», а не «начинаем»", () => {
		const text = renderAnnounce({ ...ctx, chapterOrder: 4 });
		expect(text).toContain("Читаем книгу — <b><a");
		expect(text).not.toContain("новую книгу —");
	});

	it("эмодзи один — рупор в заголовке анонса", () => {
		const emoji = /\p{Extended_Pictographic}/u;
		const withEverything = {
			...ctx,
			event: {
				...talkEvent,
				call_url: "https://meet.google.com/abc",
				materials: [{ title: "Конспект", url: "https://notes" }],
				moderators: [{ name: "Артём Никифоров", speaker_id: "nikiforov-artem" }],
			},
		};
		const announce = renderAnnounce(withEverything);
		expect(announce.startsWith(ANNOUNCE_MARK)).toBe(true);
		for (const text of [
			announce.slice(ANNOUNCE_MARK.length),
			renderDay(withEverything),
			renderSoon(withEverything),
		]) {
			expect(text).not.toMatch(emoji);
		}
	});

	it("ведущие — ссылки на Telegram из каталога клуба", () => {
		const text = renderAnnounce({
			...ctx,
			event: {
				...talkEvent,
				moderators: [
					{ name: "Артём Никифоров", speaker_id: "nikiforov-artem" },
					{ name: "Кто-то со стороны" },
				],
			},
			directory: [
				{
					id: "nikiforov-artem",
					name: "Артём Никифоров",
					telegram: "https://t.me/Frich22",
				},
			],
		});
		expect(text).toContain(
			'Ведут: <a href="https://t.me/frich22">Артём Никифоров</a>, Кто-то со стороны',
		);
	});

	it("пост в день встречи: программа и презентации сдавших спикеров", () => {
		const text = renderDay(ctx);
		expect(text.startsWith("<b>Книжный клуб №114:</b> Начинаем новую книгу!")).toBe(true);
		expect(text).toContain("<b>Рассмотрим темы:</b>\n\n1. Восход AI-инженерии");
		expect(text).toContain("<b>Сегодня в 18:00 МСК</b>");
		expect(text).toContain("Презентация — Стек AI-инженерии");
	});

	it("напоминание за 5 минут: коротко и со ссылками", () => {
		const text = renderSoon(ctx);
		expect(text).toContain(
			"<b>Книжный клуб №114:</b> Начинаем новую книгу!\n\n<b>Через 5 минут начинаем</b>",
		);
		expect(text).toContain("VK");
		// Программа в напоминании не повторяется.
		expect(text).not.toContain("Восход AI-инженерии");
	});

	it("обсуждение: задание из главы и страниц, без ручного текста", () => {
		const text = renderAnnounce({
			...ctx,
			event: {
				...talkEvent,
				type: "closed-chapter",
				pages: { from: 12, to: 48 },
				call_url: "https://meet.google.com/abc",
			},
			topics: [],
		});
		expect(text).toContain(
			"Готовимся:</b> прочитать главу 1 «Основы создания AI-приложений», страницы 12–48",
		);
		expect(text).toContain("на созвоне разбираем её вместе");
		expect(text).toContain("Созвон: <a");
		// Строка «Разбираем главу…» ушла: главу уже назвало задание.
		expect(text).not.toContain("Разбираем главу");
	});

	it("явный assignment перекрывает шаблон", () => {
		const text = renderAnnounce({
			...ctx,
			event: { ...talkEvent, assignment: "посмотреть доклад про RAG", pages: { from: 5, to: 9 } },
		});
		expect(text).toContain("Готовимся:</b> посмотреть доклад про RAG, страницы 5–9");
		expect(text).not.toContain("прочитать главу");
	});

	it("HTML в названиях экранируется (parse_mode=HTML)", () => {
		const text = renderAnnounce({
			...ctx,
			event: { ...talkEvent, title: "<b>взлом</b>" },
			topics: [],
		});
		expect(text).toContain("&lt;b&gt;взлом&lt;/b&gt;");
	});

	it("спикер берётся только из подтверждённой заявки, имя — ссылкой на Telegram", () => {
		const topics = buildTopics(
			[
				{ id: "t1", title: "Тема 1" },
				{ id: "t2", title: "Тема 2" },
			],
			[
				{ topicId: "t1", username: "kunjutone", fullName: "Антон", status: "confirmed", slidesUrl: null },
				{ topicId: "t2", username: "someone", fullName: "Ещё кто-то", status: "pending", slidesUrl: null },
			],
			3,
			[{ id: "pomazkov-anton", name: "Антон Помазков", telegram: "@kunjutone" }],
		);
		// Имя из каталога точнее того, что человек ввёл в заявке.
		expect(topics[0]).toMatchObject({
			order: 3,
			speaker: "Антон Помазков",
			speakerUrl: "https://t.me/kunjutone",
		});
		expect(topics[1].speaker).toBeUndefined();
	});

	it("без каталога спикер остаётся @ником, но со ссылкой", () => {
		const topics = buildTopics(
			[{ id: "t1", title: "Тема 1" }],
			[{ topicId: "t1", username: "Frich22", fullName: null, status: "confirmed", slidesUrl: null }],
			1,
		);
		expect(topics[0]).toMatchObject({
			speaker: "@Frich22",
			speakerUrl: "https://t.me/Frich22",
		});
	});

	// Для черновиков берём встречу без книги и главы: тогда рендер не идёт
	// в book-club-data и тесты не зависят от сети.
	const draftEvent = { ...talkEvent, book_id: undefined, chapter: undefined };

	it("готовит черновики, не публикуя их и не требуя групп", async () => {
		// Хранилище D1 изолируется между тестами, а флаг «схема создана» живёт
		// в модуле — сбрасываем, иначе таблиц в свежей базе не будет.
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;

		const { drafts } = await prepareDrafts(env, draftEvent, {});
		expect(drafts).toBe(3);

		const all = await listPostDrafts(db);
		expect(all.map((d) => d.kind).sort()).toEqual(["announce", "day", "soon"]);
		// Ничего не отправлено: публикацию запускает админ из CMS.
		expect(all.every((d) => d.status === "pending" && d.sent_at === null)).toBe(true);
		expect(all.find((d) => d.kind === "announce")?.text).toContain("Книжный клуб №114");

		// Правку текста повторная подготовка встречи не затирает.
		const announce = all.find((d) => d.kind === "announce")!;
		await setPostDraftText(db, announce.id, "Свой текст админа");
		await prepareDrafts(env, draftEvent, {});
		const after = await getPostDraft(db, announce.id);
		expect(after?.text).toBe("Свой текст админа");
		expect(after?.edited).toBe(1);

		// Пересборка возвращает текст «как из данных» и снимает флаг правки.
		const refreshed = await refreshDraft(env, announce.id);
		expect(refreshed?.text).toContain("Книжный клуб №114");
		expect(refreshed?.edited).toBe(0);
	});

	it("публикация без подключённых групп — понятная ошибка, а не сбой", async () => {
		resetSchemaCacheForTests();
		await prepareDrafts(env, draftEvent, {});
		const draft = (await listPostDrafts(env.BOOK_CLUB_DB))[0];
		await expect(publishDraft(env, draft.id)).rejects.toThrow(/anons_here/);
	});

	it("группы: /anons_here добавляет, /anons_stop убирает", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		await addAnnounceChat(db, -1001, "Книжный клуб");
		await addAnnounceChat(db, -1002, "Тестовая группа");
		// Повторное подключение той же группы не создаёт дубль.
		await addAnnounceChat(db, -1001, null);

		const chats = await listAnnounceChats(db);
		expect(chats.map((c) => c.chat_id)).toEqual([-1001, -1002]);
		// Название не затирается пустым при повторном /anons_here.
		expect(chats[0].title).toBe("Книжный клуб");

		expect(await removeAnnounceChat(db, -1002)).toBe(true);
		expect(await removeAnnounceChat(db, -1002)).toBe(false);
		expect((await listAnnounceChats(db)).map((c) => c.chat_id)).toEqual([-1001]);
	});

	it("группа, подключённая до появления нескольких чатов, не теряется", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		await setBotSetting(db, ANNOUNCE_CHAT_KEY, "-1002793252927");
		const chats = await listAnnounceChats(db);
		expect(chats.map((c) => c.chat_id)).toEqual([-1002793252927]);
	});

	it("расписание ставится только одобренному посту", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		await prepareDrafts(env, draftEvent, {});
		const draft = (await listPostDrafts(db)).find((d) => d.kind === "announce")!;
		const at = Date.parse("2026-07-24T15:00:00+03:00");

		// Без одобрения расписание не принимается: иначе это автопостинг.
		expect(await setPostDraftSchedule(db, draft.id, at)).toBeNull();

		expect((await setPostDraftApproved(db, draft.id, true))?.approved_at).toBeTruthy();
		expect((await setPostDraftSchedule(db, draft.id, at))?.scheduled_at).toBe(at);

		// Забрали пост на доработку — расписание снимается вместе с одобрением.
		const unapproved = await setPostDraftApproved(db, draft.id, false);
		expect(unapproved?.approved_at).toBeNull();
		expect(unapproved?.scheduled_at).toBeNull();
	});

	it("повторная подготовка встречи снимает одобрение неправленого текста", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		await prepareDrafts(env, draftEvent, {});
		const [auto, manual] = await listPostDrafts(db);

		await setPostDraftApproved(db, auto.id, true);
		await setPostDraftText(db, manual.id, "Текст админа");
		await setPostDraftApproved(db, manual.id, true);

		await prepareDrafts(env, draftEvent, {});
		// Текст переписан заново — одобрение прошлого текста больше не в счёт.
		expect((await getPostDraft(db, auto.id))?.approved_at).toBeNull();
		// Ручной текст остался, значит и одобрение к нему всё ещё относится.
		expect((await getPostDraft(db, manual.id))?.approved_at).toBeTruthy();
	});

	it("cron публикует только одобренные и только по времени, ошибки не долбят группу", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		await prepareDrafts(env, draftEvent, {});
		const all = await listPostDrafts(db);
		const now = Date.parse("2026-07-24T12:00:00+03:00");
		const [due, future, unapproved] = all;

		await setPostDraftApproved(db, due.id, true);
		await setPostDraftSchedule(db, due.id, now - 60_000);
		await setPostDraftApproved(db, future.id, true);
		await setPostDraftSchedule(db, future.id, now + 3600_000);
		// Третьему поставим время в прошлом, но одобрения у него нет.
		await setPostDraftSchedule(db, unapproved.id, now - 60_000);

		expect((await listDuePostDrafts(db, now)).map((d) => d.id)).toEqual([due.id]);

		// Групп нет — публикация падает; попытка считается, причина видна в CMS.
		await runScheduledPosts(env, now);
		const afterFirst = await getPostDraft(db, due.id);
		expect(afterFirst?.status).toBe("pending");
		expect(afterFirst?.attempts).toBe(1);
		expect(afterFirst?.publish_error).toMatch(/anons_here/);

		for (let i = 1; i < MAX_PUBLISH_ATTEMPTS; i++) await runScheduledPosts(env, now);
		expect((await getPostDraft(db, due.id))?.attempts).toBe(MAX_PUBLISH_ATTEMPTS);
		// Исчерпал попытки — cron его больше не берёт, ждёт админа.
		expect(await listDuePostDrafts(db, now)).toEqual([]);
	});

	it("афишу можно добавить любому посту, включая напоминание, и заменить", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		await prepareDrafts(env, draftEvent, {});
		const soon = (await listPostDrafts(db)).find((d) => d.kind === "soon")!;
		expect(soon.has_poster).toBe(0);

		const first = new Uint8Array([1, 2, 3]);
		expect((await setDraftPoster(env, soon.id, first))?.has_poster).toBe(1);
		expect(await getDraftPoster(env, (await getPostDraft(db, soon.id))!)).toEqual({
			bytes: first,
		});

		// Пост уже публиковали, у него есть file_id: новая картинка обязана его
		// сбросить, иначе Telegram отправит прежнюю.
		await setPostDraftPoster(db, soon.id, "file-123");
		const replaced = await setDraftPoster(env, soon.id, new Uint8Array([9]));
		expect(replaced?.poster_file_id).toBeNull();
		expect(replaced?.has_poster).toBe(1);

		const removed = await setDraftPoster(env, soon.id, null);
		expect(removed?.has_poster).toBe(0);
		expect(await getDraftPoster(env, removed!)).toBeNull();
	});

	it("подсказка времени: афиша утром, напоминание за 10 минут до начала", () => {
		const event = { date: "2026-07-24", time: "18:00" };
		expect(suggestedPublishAt("day", event)).toBe(Date.parse("2026-07-24T10:00:00+03:00"));
		expect(suggestedPublishAt("soon", event)).toBe(Date.parse("2026-07-24T17:50:00+03:00"));
		// Анонс публикуют сразу — подсказка равна «сейчас».
		expect(suggestedPublishAt("announce", event, 1_000)).toBe(1_000);
	});
})

describe("Бот в группе клуба: только свои команды", () => {
	it("на болтовню участников и чужие команды не реагирует", () => {
		expect(groupCommand("/anons_here")).toBe("anons_here");
		// В группе Telegram дописывает адресата к команде.
		expect(groupCommand("/anons_here@bookclubfrontbot")).toBe("anons_here");
		expect(groupCommand("привет всем")).toBeNull();
		expect(groupCommand("а бот тут /anons_here")).toBeNull();
		expect(groupCommand("/today")).toBeNull();
		expect(groupCommand("/speaker")).toBeNull();
		expect(groupCommand(undefined)).toBeNull();
	});
});

describe("Участие в клубе: темы берут только участники", () => {
	// Ник не передаём: каталог спикеров лежит в git, а тесты не ходят в сеть —
	// проверяем именно оперативную часть доступа (D1).
	it("новый человек тем не видит, одобренная заявка их открывает", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		const chatId = 909001;

		let access = await speakerAccess(env, chatId);
		expect(access.registered).toBe(false);
		expect(access.request).toBeNull();

		const created = await saveMembershipRequest(db, {
			chatId,
			fullName: "Новый Участник",
			about: "Фронтендер, хочу рассказать про Vite",
			source: "miniapp",
		});
		expect(created?.status).toBe("pending");

		access = await speakerAccess(env, chatId);
		expect(access.registered).toBe(false);
		expect(access.request?.status).toBe("pending");
		expect(access.fullName).toBe("Новый Участник");

		// Повторная отправка обновляет ту же заявку и не затирает уже известное.
		await saveMembershipRequest(db, { chatId, about: "Дополнил рассказ", source: "bot" });
		const mine = (await listMembershipRequests(db)).filter((m) => m.chat_id === chatId);
		expect(mine).toHaveLength(1);
		expect(mine[0].full_name).toBe("Новый Участник");
		expect(mine[0].about).toBe("Дополнил рассказ");

		expect((await setMembershipStatus(db, created!.id, "approved"))?.status).toBe("approved");
		expect((await speakerAccess(env, chatId)).registered).toBe(true);

		// Принятого участника случайный повтор заявки не лишает доступа.
		await saveMembershipRequest(db, { chatId, about: "ещё раз", source: "bot" });
		expect((await speakerAccess(env, chatId)).registered).toBe(true);
	});

	it("Telegram спикера находится, даже если тему назначил админ в CMS", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;

		// 1. Устойчивая личность: спикер когда-то брал тему у бота.
		await saveSpeakerIdentity(db, {
			chatId: 909101,
			speakerId: "identity-speaker",
			fullName: "Иван Личность",
			username: "ivan_identity",
		});
		expect(await findSpeakerChat(db, "identity-speaker")).toEqual({
			chatId: 909101,
			username: "ivan_identity",
		});

		// 2. Прошлая заявка из Telegram (легаси до speaker_identity).
		const legacy = await createSpeakerClaim(db, {
			topicId: "legacy-topic",
			topicTitle: "Старый доклад",
			chatId: 909102,
			username: "old_speaker",
		});
		await updateSpeakerClaim(db, legacy!.id, { speakerId: "legacy-speaker" });
		expect((await findSpeakerChat(db, "legacy-speaker"))?.chatId).toBe(909102);

		// 3. Ни разу не писал боту, но входил в приложение — ищем по нику каталога.
		await upsertUser(db, { id: 909103, username: "MiniappOnly" });
		expect((await findSpeakerChat(db, "miniapp-speaker", "@miniappOnly"))?.chatId).toBe(909103);

		// Незнакомый спикер — писать некуда, и это честно видно вызывающему.
		expect(await findSpeakerChat(db, "unknown-speaker", "nobody_here")).toBeNull();
	});

	it("назначение из CMS запоминает Telegram спикера в заявке", async () => {
		resetSchemaCacheForTests();
		const db = env.BOOK_CLUB_DB;
		await assignClaim(db, {
			topicId: "assign-contact-1",
			topicTitle: "Серверный рендеринг",
			bookId: "fluent-react",
			chapter: "09-react-server-components",
			speakerId: "contact-speaker",
			speakerName: "Пётр Контактов",
			chatId: 909104,
			username: "petr_contact",
		});
		const claim = await getClaimByTopic(db, "assign-contact-1");
		expect(claim?.chat_id).toBe(909104);
		expect(claim?.username).toBe("petr_contact");
	});

	it("спикера, узнанного ранее, заявкой не мучаем", async () => {
		resetSchemaCacheForTests();
		const chatId = 909002;
		await saveSpeakerIdentity(env.BOOK_CLUB_DB, {
			chatId,
			fullName: "Пётр Каталогов",
			speakerId: "katalogov-petr",
		});
		const access = await speakerAccess(env, chatId);
		expect(access.registered).toBe(true);
		expect(access.speaker?.id).toBe("katalogov-petr");
		expect(access.request).toBeNull();
	});

	it("текст объясняет, что делать: заявка, ожидание, отказ", () => {
		expect(membershipPrompt(null)).toContain("заявку на участие");
		expect(membershipPrompt({ status: "pending" } as MembershipRequest)).toContain("у админа");
		expect(membershipPrompt({ status: "declined" } as MembershipRequest)).toContain("заново");
	});

	it("участнику без свободных тем говорим прямо, свою тему не предлагаем", () => {
		const empty = speakerIntro([]);
		expect(empty).toContain("Свободных тем сейчас нет");
		expect(empty).not.toContain("свою");

		const withTopics = speakerIntro([
			{
				topic: { id: "t1", title: "Архитектура" },
				bookId: "docker",
				bookTitle: "Docker. Вводный курс",
				chapterSlug: "02-obschie",
			},
		]);
		expect(withTopics).toContain("Docker. Вводный курс");
	});

	it("бронь темы требует входа, модерация — админ-токена", async () => {
		const post = (path: string) =>
			new IncomingRequest(`http://example.com${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});

		const ctxExec = createExecutionContext();
		const claim = await worker.fetch(post("/api/claim"), env, ctxExec);
		const apply = await worker.fetch(post("/api/membership"), env, ctxExec);
		const members = await worker.fetch(post("/api/admin/members"), env, ctxExec);
		await waitOnExecutionContext(ctxExec);

		expect(claim.status).toBe(401);
		expect(apply.status).toBe(401);
		expect(members.status).toBe(401);
	});
})

