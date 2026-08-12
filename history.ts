import { open, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const HISTORY_VERSION = 1;
export const MAX_HISTORY_ENTRIES = 100;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;

export interface HistoryEntry {
	version: 1;
	input: string;
}

export interface HistoryStoreOptions {
	maxEntries?: number;
	lockStaleMs?: number;
	lockRetryMs?: number;
	lockTimeoutMs?: number;
	now?: () => number;
}

export function normalizePrompt(input: string): string {
	return input.trim();
}

export function parseHistory(text: string, maxEntries = MAX_HISTORY_ENTRIES): string[] {
	const prompts: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as { version?: unknown; input?: unknown };
			if (value.version !== HISTORY_VERSION || typeof value.input !== "string") continue;
			const prompt = normalizePrompt(value.input);
			if (!prompt || prompts.at(-1) === prompt) continue;
			prompts.push(prompt);
		} catch {
			// A damaged record must not make the rest of the history unreadable.
		}
	}
	const limit = Math.max(0, Math.floor(maxEntries));
	return limit === 0 ? [] : prompts.slice(-limit);
}

export function serializeHistory(prompts: readonly string[]): string {
	return prompts
		.map((input) => JSON.stringify({ version: HISTORY_VERSION, input } satisfies HistoryEntry))
		.join("\n") + (prompts.length ? "\n" : "");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HistoryStore {
	readonly filePath: string;
	readonly lockPath: string;
	private readonly maxEntries: number;
	private readonly lockStaleMs: number;
	private readonly lockRetryMs: number;
	private readonly lockTimeoutMs: number;
	private readonly now: () => number;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(filePath: string, options: HistoryStoreOptions = {}) {
		this.filePath = path.resolve(filePath);
		this.lockPath = `${this.filePath}.lock`;
		this.maxEntries = Math.max(0, Math.floor(options.maxEntries ?? MAX_HISTORY_ENTRIES));
		this.lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS;
		this.lockRetryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
		this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
		this.now = options.now ?? Date.now;
	}

	load(): Promise<string[]> {
		return this.enqueue(() => this.withLock(async () => {
			const raw = await readFile(this.filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return "";
				throw error;
			});
			const prompts = parseHistory(raw, this.maxEntries);
			const canonical = serializeHistory(prompts);
			if (raw !== canonical) await this.writeAtomic(canonical);
			return prompts;
		}));
	}

	append(input: string): Promise<string[]> {
		const prompt = normalizePrompt(input);
		if (!prompt) return this.load();
		return this.enqueue(() => this.withLock(async () => {
			const raw = await readFile(this.filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return "";
				throw error;
			});
			const prompts = parseHistory(raw, this.maxEntries);
			if (prompts.at(-1) !== prompt) prompts.push(prompt);
			const retained = this.maxEntries === 0 ? [] : prompts.slice(-this.maxEntries);
			await this.writeAtomic(serializeHistory(retained));
			return retained;
		}));
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		const started = this.now();
		while (true) {
			try {
				const handle = await open(this.lockPath, "wx");
				try {
					await handle.writeFile(`${process.pid}\n${this.now()}\n`);
					return await operation();
				} finally {
					await handle.close().catch(() => undefined);
					await rm(this.lockPath, { force: true }).catch(() => undefined);
				}
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST") throw error;
				const info = await stat(this.lockPath).catch(() => undefined);
				if (info && this.now() - info.mtimeMs > this.lockStaleMs) {
					await rm(this.lockPath, { force: true }).catch(() => undefined);
					continue;
				}
				if (this.now() - started >= this.lockTimeoutMs) {
					throw new Error(`Timed out waiting for prompt history lock: ${this.lockPath}`);
				}
				await sleep(this.lockRetryMs);
			}
		}
	}

	private async writeAtomic(content: string): Promise<void> {
		const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		try {
			await rename(temporary, this.filePath);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		}
	}
}
