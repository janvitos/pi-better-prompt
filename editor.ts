import type { EditorComponent } from "@earendil-works/pi-tui";

export interface GlobalHistoryEditor {
	editor: EditorComponent;
	addInteractive(input: string): void;
	dispose(): void;
}

/**
 * Replace an editor's session-derived history with global entries.
 *
 * Pi exposes addToHistory() but no public clearHistory() operation. Its built-in
 * Editor and CustomEditor store history in a normal `history` array, so clear it
 * reflectively before seeding. Editors with a different implementation still
 * receive global entries, but their pre-existing private history cannot be removed.
 */
export function installGlobalHistory(editor: EditorComponent, prompts: readonly string[]): GlobalHistoryEditor {
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
		dispose() {
			if (!active) return;
			active = false;
			if (addToHistory) editor.addToHistory = addToHistory;
		},
	};
}
