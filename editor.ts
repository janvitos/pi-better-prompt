import type { EditorComponent } from "@earendil-works/pi-tui";
import {
	installPromptSelection,
	type SelectionDependencies,
	type PromptSelection,
} from "./selection.ts";

export interface GlobalHistoryEditor {
	editor: EditorComponent;
	addInteractive(input: string): void;
	clearSelection(): void;
	dispose(): void;
}

function installSlashCommandCapture(
	editor: EditorComponent,
	record: (input: string) => void | Promise<void>,
): () => void {
	const originalDescriptor = Object.getOwnPropertyDescriptor(editor, "onSubmit");
	if (originalDescriptor?.configurable === false) return () => undefined;
	if (originalDescriptor && !("value" in originalDescriptor) && !originalDescriptor.set) {
		return () => undefined;
	}

	let submitHandler = editor.onSubmit;
	const wrap = (handler: NonNullable<EditorComponent["onSubmit"]>) =>
		async function (this: EditorComponent, text: string): Promise<void> {
			if (text.trimStart().startsWith("/")) await record(text);
			await handler.call(this, text);
		};
	let wrappedHandler = submitHandler ? wrap(submitHandler) : undefined;

	Object.defineProperty(editor, "onSubmit", {
		configurable: true,
		enumerable: originalDescriptor?.enumerable ?? true,
		get: () => wrappedHandler,
		set: (handler: EditorComponent["onSubmit"]) => {
			submitHandler = handler;
			wrappedHandler = handler ? wrap(handler) : undefined;
		},
	});

	return () => {
		if (originalDescriptor) {
			if ("value" in originalDescriptor) {
				Object.defineProperty(editor, "onSubmit", { ...originalDescriptor, value: submitHandler });
			} else {
				Object.defineProperty(editor, "onSubmit", originalDescriptor);
				originalDescriptor.set?.call(editor, submitHandler);
			}
		} else {
			delete (editor as EditorComponent & { onSubmit?: EditorComponent["onSubmit"] }).onSubmit;
			if (submitHandler) editor.onSubmit = submitHandler;
		}
	};
}

/**
 * Replace an editor's session-derived history with global entries.
 *
 * Pi exposes addToHistory() but no public clearHistory() operation. Its built-in
 * Editor and CustomEditor store history in a normal `history` array, so clear it
 * reflectively before seeding. Editors with a different implementation still
 * receive global entries, but their pre-existing private history cannot be removed.
 */
export function installGlobalHistory(
	editor: EditorComponent,
	prompts: readonly string[],
	selectionDependencies?: SelectionDependencies,
	recordSlashCommand?: (input: string) => void | Promise<void>,
): GlobalHistoryEditor {
	const selection: PromptSelection | undefined = selectionDependencies
		? installPromptSelection(editor, selectionDependencies)
		: undefined;
	const disposeSlashCommandCapture = recordSlashCommand
		? installSlashCommandCapture(editor, recordSlashCommand)
		: () => undefined;
	const addToHistory = editor.addToHistory?.bind(editor);
	const candidate = editor as EditorComponent & { history?: unknown };
	if (Array.isArray(candidate.history)) candidate.history.length = 0;

	if (addToHistory) {
		for (const prompt of prompts) addToHistory(prompt);
		// Pi repopulates history from the active session after creating an editor.
		// Block those calls; interactive input is added explicitly by the extension.
		editor.addToHistory = () => undefined;
	}

	let active = true;
	return {
		editor,
		addInteractive(input: string) {
			if (active) addToHistory?.(input);
		},
		clearSelection() {
			if (active) selection?.clear();
		},
		dispose() {
			if (!active) return;
			active = false;
			disposeSlashCommandCapture();
			selection?.dispose();
			if (addToHistory) editor.addToHistory = addToHistory;
		},
	};
}
