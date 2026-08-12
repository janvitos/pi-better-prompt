import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	HistoryStore,
	MAX_HISTORY_ENTRIES,
	normalizePrompt,
	parseHistory,
	serializeHistory,
} from "./history.ts";

const entry = (input: string) => JSON.stringify({ version: 1, input });

async function temporaryStore(options: ConstructorParameters<typeof HistoryStore>[1] = {}) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-prompt-history-"));
	return {
		directory,
		file: path.join(directory, "prompt-history.jsonl"),
		store: new HistoryStore(path.join(directory, "prompt-history.jsonl"), options),
	};
}

test("normalizes prompts and parses valid records around corruption", () => {
	assert.equal(normalizePrompt("  hello\n"), "hello");
	const text = [entry(" first "), "broken", JSON.stringify({ version: 2, input: "ignored" }), entry("second")].join("\n");
	assert.deepEqual(parseHistory(text), ["first", "second"]);
});

test("suppresses only consecutive duplicates", () => {
	const text = [entry("one"), entry("one"), entry("two"), entry("one")].join("\n");
	assert.deepEqual(parseHistory(text), ["one", "two", "one"]);
});

test("retains the newest 100 entries in chronological order", () => {
	const text = Array.from({ length: 105 }, (_, index) => entry(`prompt ${index}`)).join("\n");
	const prompts = parseHistory(text);
	assert.equal(prompts.length, MAX_HISTORY_ENTRIES);
	assert.equal(prompts[0], "prompt 5");
	assert.equal(prompts.at(-1), "prompt 104");
});

test("load self-heals malformed and over-limit history", async () => {
	const fixture = await temporaryStore({ maxEntries: 2 });
	try {
		await writeFile(fixture.file, `${entry("one")}\nbad\n${entry("two")}\n${entry("three")}\n`);
		assert.deepEqual(await fixture.store.load(), ["two", "three"]);
		assert.equal(await readFile(fixture.file, "utf8"), serializeHistory(["two", "three"]));
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("append serializes concurrent updates from independent stores", async () => {
	const fixture = await temporaryStore();
	try {
		const first = new HistoryStore(fixture.file);
		const second = new HistoryStore(fixture.file);
		await Promise.all([first.append("one"), second.append("two")]);
		const prompts = await fixture.store.load();
		assert.equal(prompts.length, 2);
		assert.deepEqual(new Set(prompts), new Set(["one", "two"]));
		assert.equal((await readdir(fixture.directory)).some((name) => name.endsWith(".tmp")), false);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("append recovers a stale lock", async () => {
	const fixture = await temporaryStore({ lockStaleMs: 10, lockRetryMs: 1, lockTimeoutMs: 500 });
	try {
		await writeFile(fixture.store.lockPath, "stale");
		const old = new Date(Date.now() - 60_000);
		await utimes(fixture.store.lockPath, old, old);
		assert.deepEqual(await fixture.store.append("recovered"), ["recovered"]);
		assert.deepEqual(await fixture.store.load(), ["recovered"]);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});

test("queued writes continue after an operation fails", async () => {
	const fixture = await temporaryStore({ lockTimeoutMs: 5, lockRetryMs: 1, lockStaleMs: 60_000 });
	try {
		await writeFile(fixture.store.lockPath, "busy");
		await assert.rejects(fixture.store.append("blocked"), /Timed out/);
		await rm(fixture.store.lockPath, { force: true });
		assert.deepEqual(await fixture.store.append("works"), ["works"]);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
});
