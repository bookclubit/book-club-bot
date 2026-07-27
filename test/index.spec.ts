declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { groupCommand } from "../src/index";
import type { CardProgress, DeckCard, Flashcard } from "../src/types";
import {
	calculateNextReview,
	initialProgress,
	reviewFromQuality,
	selectDue,
} from "../src/lib/spaced-repetition";
import { eventDateFromPath, eventPathById } from "../src/lib/events";
import { buildTopics, renderAnnounce, renderDay, renderSoon } from "../src/lib/announce";
import { prepareDrafts, publishDraft, refreshDraft } from "../src/lib/announcer";
import { findSpeakerByUsername, telegramHandle } from "../src/lib/speakers";
import {
	addAnnounceChat,
	ANNOUNCE_CHAT_KEY,
	assignClaim,
	cardKey,
	createSpeakerClaim,
	deleteSpeakerClaim,
	getPostDraft,
	getSpeakerProfile,
	listAnnounceChats,
	listMembershipRequests,
	listPostDrafts,
	listSpeakerClaims,
	releaseClaimByTopic,
	removeAnnounceChat,
	resetSchemaCacheForTests,
	saveMembershipRequest,
	saveSpeakerIdentity,
	setBotSetting,
	setClaimSlides,
	setMembershipStatus,
	setPostDraftText,
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
		expect(text).toContain("Книжный клуб №114: Начинаем новую книгу!");
		expect(text).toContain("Пятница, 24 июля, в 18:00 МСК");
		expect(text).toContain('<a href="https://oreilly.com/ai-engineering">«AI-инженерия»</a>');
		expect(text).toContain("Чип Хьюен");
		// Задание собирается само: главу и её название бот знает из данных.
		expect(text).toContain("Готовимся:</b> прочитать главу 1 «Основы создания AI-приложений»");
		expect(text).toContain("на эфире её разбирают докладчики");
		// Спикер в программе — ссылка на его Telegram.
		expect(text).toContain(
			'1. Восход AI-инженерии — <a href="https://t.me/kunjutone">Антон Помазков</a>',
		);
		// Тема без заявки не выпадает из программы, а помечается свободной.
		expect(text).toContain("3. Планирование AI-приложений — свободно");
		expect(text).toContain('Трансляция: <a href="https://youtu.be/x">YouTube</a>');
	});

	it("в постах нет эмодзи — структуру держат подзаголовки и ссылки", () => {
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
		for (const text of [
			renderAnnounce(withEverything),
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
		expect(text).toContain("На этом стриме читаем");
		expect(text).toContain("Рассмотрим темы:");
		expect(text).toContain("Сегодня в 18:00 МСК");
		expect(text).toContain("Презентация — Стек AI-инженерии");
	});

	it("напоминание за 5 минут: коротко и со ссылками", () => {
		const text = renderSoon(ctx);
		expect(text).toContain("Через 5 минут начинаем");
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
