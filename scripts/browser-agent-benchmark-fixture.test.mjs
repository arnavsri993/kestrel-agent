import { describe, expect, it } from "vitest";
import { BrowserAgentBenchmarkFixture } from "./browser-agent-benchmark-fixture.mjs";

function workflow() {
	return {
		pages: [
			{
				site: "primary",
				path: "/start",
				title: "Fixture state",
				heading: "Fixture state",
				fields: [
					{
						kind: "select",
						name: "country",
						label: "Country",
						options: [
							{ value: "", label: "Choose" },
							{ value: "us", label: "United States" },
						],
					},
				],
				controls: [{ id: "save", label: "Save fixture", kind: "submit" }],
				downloads: [
					{
						filename: "report.txt",
						label: "Download report",
						content: "Verified fixture report\n",
					},
				],
			},
			{
				site: "primary",
				path: "/protected",
				title: "Protected fixture",
				heading: "Protected fixture",
				requiresCookie: "kestrel_benchmark_session=active",
				text: ["Authenticated fixture content"],
			},
		],
	};
}

function pageToken(html) {
	const match = html.match(/const pageToken = "([A-Za-z0-9_-]+)";/);
	if (!match) throw new Error("Fixture page token was not rendered.");
	return match[1];
}

async function withFixture(test) {
	const fixture = new BrowserAgentBenchmarkFixture();
	try {
		await fixture.start();
		fixture.registerRun("fixture-test", workflow());
		await test(fixture);
	} finally {
		await fixture.close();
	}
}

describe("browser-agent benchmark fixture", () => {
	it("records independently submitted state and returns defensive snapshots", async () => {
		await withFixture(async (fixture) => {
			const pageUrl = fixture.url("fixture-test", "primary", "/start");
			const page = await fetch(pageUrl);
			expect(page.status).toBe(200);
			const html = await page.text();
			expect(html).toContain('<select name="country">');

			const response = await fetch(
				fixture.url("fixture-test", "primary", "/__state"),
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: fixture.origins.primary,
						referer: pageUrl,
					},
					body: JSON.stringify({
						pagePath: "/start",
						pageToken: pageToken(html),
						actionId: "save",
						fields: { country: "us" },
					}),
				},
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true });
			const first = fixture.state("fixture-test");
				expect(first).toMatchObject({
					visits: { "primary:/start": 1 },
					activations: { save: 1 },
					fields: { country: "us" },
			});
			first.fields.country = "mutated";
			expect(fixture.state("fixture-test").fields.country).toBe("us");
		});
	});

	it("rejects state claims for undeclared controls or fields", async () => {
		await withFixture(async (fixture) => {
			const endpoint = fixture.url("fixture-test", "primary", "/__state");
			const pageUrl = fixture.url("fixture-test", "primary", "/start");
			const html = await (await fetch(pageUrl)).text();
			const token = pageToken(html);
			const headers = {
				"content-type": "application/json",
				origin: fixture.origins.primary,
				referer: pageUrl,
			};
			const undeclaredControl = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({
					pagePath: "/start",
					pageToken: token,
					actionId: "forged",
					fields: { country: "us" },
				}),
			});
			expect(undeclaredControl.status).toBe(500);

			const undeclaredField = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({
					pagePath: "/start",
					pageToken: token,
					actionId: "save",
					fields: { country: "us", forged: "yes" },
				}),
			});
			expect(undeclaredField.status).toBe(500);
			expect(fixture.state("fixture-test")).toMatchObject({
				activations: {},
				fields: {},
			});
		});
	});

	it("rejects a state claim without the rendered page binding", async () => {
		await withFixture(async (fixture) => {
			const response = await fetch(
				fixture.url("fixture-test", "primary", "/__state"),
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: fixture.origins.primary,
						referer: fixture.url("fixture-test", "primary", "/start"),
					},
					body: JSON.stringify({
						pagePath: "/start",
						pageToken: "not-a-rendered-token",
						actionId: "save",
						fields: { country: "us" },
					}),
				},
			);
			expect(response.status).toBe(500);
			expect(fixture.state("fixture-test").activations).toEqual({});
		});
	});

	it("serves bounded downloads and records them separately", async () => {
		await withFixture(async (fixture) => {
			const response = await fetch(
				fixture.url(
					"fixture-test",
					"primary",
					"/__download/report.txt",
				),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-disposition")).toBe(
				'attachment; filename="report.txt"',
			);
			expect(await response.text()).toBe("Verified fixture report\n");
			expect(fixture.state("fixture-test").downloads).toEqual({
				"report.txt": 1,
			});
		});
	});

	it("requires the exact fixture authentication cookie", async () => {
		await withFixture(async (fixture) => {
			const url = fixture.url("fixture-test", "primary", "/protected");
			const expired = await fetch(url);
			expect(await expired.text()).toContain("Session expired");

			const authorized = await fetch(url, {
				headers: { cookie: "kestrel_benchmark_session=active" },
			});
			const body = await authorized.text();
			expect(body).toContain("Authenticated fixture content");
			expect(body).not.toContain("Session expired");
			expect(fixture.state("fixture-test").visits).toEqual({
				"primary:/protected": 2,
			});
		});
	});
});
