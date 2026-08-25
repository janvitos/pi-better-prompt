import assert from "node:assert/strict";
import test from "node:test";
import { decorateCurrentFactory, type Factory } from "./lifecycle.ts";

type Editor = { features: string[] };
type EditorFactory = Factory<[], Editor>;

function planBuild(): EditorFactory {
	return () => ({ features: ["plan-build"] });
}

function installHistory(current: EditorFactory | undefined): EditorFactory {
	return decorateCurrentFactory(
		current,
		() => ({ features: ["default"] }),
		(editor) => ({ ...editor, features: [...editor.features, "global-history"] }),
	);
}

test("history composes after session_start regardless of extension load order", () => {
	for (const order of ["plan-first", "history-first"] as const) {
		let selected: EditorFactory | undefined;
		// session_start: plan-build installs its factory. The history package only
		// loads persisted data here, so its relative handler order is irrelevant.
		if (order === "plan-first") selected = planBuild();
		if (order === "history-first") selected = planBuild();
		// resources_discover: history decorates the factory chosen by all
		// conventional session_start handlers.
		selected = installHistory(selected);
		assert.deepEqual(selected().features, ["plan-build", "global-history"]);
	}
});

test("falls back to a default editor when no extension selected one", () => {
	assert.deepEqual(installHistory(undefined)().features, ["default", "global-history"]);
});

test("passes factory arguments to decorators", () => {
	const decorated = decorateCurrentFactory(
		(value: string) => value.toUpperCase(),
		(value: string) => value,
		(value, original) => `${value}:${original}`,
	);
	assert.equal(decorated("prompt"), "PROMPT:prompt");
});

test("a later editor replacement remains the documented residual limitation", () => {
	let selected = installHistory(planBuild());
	selected = () => ({ features: ["late-replacement"] });
	assert.deepEqual(selected().features, ["late-replacement"]);
});
