import path from "node:path";
import {
	copyToClipboard,
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	Editor,
	matchesKey,
	sliceByColumn,
	visibleWidth,
	type EditorComponent,
	type KeyId,
} from "@earendil-works/pi-tui";
import { installActivityStatus } from "./activity.ts";
import { installGlobalHistory, type GlobalHistoryEditor } from "./editor.ts";
import { HistoryStore } from "./history.ts";
import { decorateCurrentFactory } from "./lifecycle.ts";

export const GLOBAL_HISTORY_PATH = path.join(getAgentDir(), "prompt-history.jsonl");

export default function betterPrompt(pi: ExtensionAPI): void {
	installActivityStatus(pi);
	const store = new HistoryStore(GLOBAL_HISTORY_PATH);
	let activeEditor: GlobalHistoryEditor | undefined;
	let currentContext: ExtensionContext | undefined;
	let prompts: string[] = [];

	async function record(input: string): Promise<void> {
		if (currentContext?.mode !== "tui") return;
		activeEditor?.addInteractive(input);
		try {
			await store.append(input);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			currentContext?.ui.notify(`Could not persist global prompt history: ${message}`, "warning");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		prompts = [];
		if (ctx.mode !== "tui") return;

		try {
			prompts = await store.load();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not load global prompt history: ${message}`, "warning");
		}
	});

	// Pi runs resources_discover after every extension's session_start handler.
	// Deferring composition until here lets conventional custom editors install
	// themselves first, regardless of package load order.
	pi.on("resources_discover", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const previous = ctx.ui.getEditorComponent();
		const fallback: NonNullable<ReturnType<typeof ctx.ui.getEditorComponent>> =
			(tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings);
		ctx.ui.setEditorComponent(decorateCurrentFactory(
			previous,
			fallback,
			(editor, _tui, _theme, keybindings): EditorComponent => {
				activeEditor?.dispose();
				activeEditor = installGlobalHistory(editor, prompts, {
					baseEditor: Editor,
					matchesKey: (data, key) => matchesKey(data, key as KeyId),
					matchesAction: (data, action) =>
						keybindings.matches(data, action as Parameters<typeof keybindings.matches>[1]),
					decodePrintable: (data) => {
						const kitty = decodeKittyPrintable(data);
						if (kitty !== undefined) return kitty;
						return data.length > 0 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32
							? data
							: undefined;
					},
					visibleWidth,
					sliceByColumn,
					copyText: copyToClipboard,
					onCopyError: (error) => {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Could not copy prompt selection: ${message}`, "warning");
					},
				});
				return activeEditor.editor;
			},
		));
	});

	pi.on("input", async (event) => {
		if (event.source !== "interactive") return { action: "continue" as const };
		await record(event.text);
		return { action: "continue" as const };
	});

	pi.on("user_bash", async (event) => {
		await record(`${event.excludeFromContext ? "!!" : "!"}${event.command}`);
	});

	pi.on("session_shutdown", () => {
		activeEditor?.dispose();
		activeEditor = undefined;
		currentContext = undefined;
		prompts = [];
	});
}
