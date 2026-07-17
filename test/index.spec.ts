declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Flashcard } from "../src/types";
import { calculateNextReview, getDueCards } from "../src/lib/spaced-repetition";
import { eventDateFromPath, eventPathById } from "../src/lib/events";

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

describe("getDueCards", () => {
	const cards: Flashcard[] = [
		{ id: "a", type: "qa", question: "q", answer: "a", chapter: "1", difficulty: "easy" },
		{ id: "b", type: "qa", question: "q", answer: "a", chapter: "1", difficulty: "easy" },
	];

	it("новые карточки считаются подлежащими повторению", () => {
		const due = getDueCards(cards, new Map(), Date.now(), 5);
		expect(due).toHaveLength(2);
	});

	it("соблюдает лимит", () => {
		const due = getDueCards(cards, new Map(), Date.now(), 1);
		expect(due).toHaveLength(1);
	});
});
