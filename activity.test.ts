import assert from "node:assert/strict";
import test from "node:test";
import { ActivityStatus, classifyToolActivity } from "./activity.ts";

function recorder(): { messages: Array<string | undefined>; setMessage(message?: string): void } {
	const messages: Array<string | undefined> = [];
	return {
		messages,
		setMessage(message) {
			messages.push(message);
		},
	};
}

test("classifies built-in and web tools into simple activities", () => {
	assert.equal(classifyToolActivity("web_search"), "searching");
	assert.equal(classifyToolActivity("grep"), "searching");
	assert.equal(classifyToolActivity("read"), "reading");
	assert.equal(classifyToolActivity("url_context"), "reading");
	assert.equal(classifyToolActivity("edit"), "writing");
	assert.equal(classifyToolActivity("write"), "writing");
	assert.equal(classifyToolActivity("bash"), "running");
	assert.equal(classifyToolActivity("custom_tool"), "working");
});

test("tracks model streaming states without repeating the same message", () => {
	const status = new ActivityStatus();
	const output = recorder();
	const setMessage = output.setMessage.bind(output);

	status.start(setMessage);
	status.messageUpdate("thinking_start", setMessage);
	status.messageUpdate("thinking_delta", setMessage);
	status.messageUpdate("text_start", setMessage);
	status.messageUpdate("text_delta", setMessage);
	status.messageUpdate("toolcall_start", setMessage);
	assert.deepEqual(output.messages, ["Thinking...", "Responding...", "Working..."]);
});

test("uses a shared status for matching parallel tools and Working for mixed tools", () => {
	const status = new ActivityStatus();
	const output = recorder();
	const setMessage = output.setMessage.bind(output);

	status.start(setMessage);
	status.toolStart("one", "read", setMessage);
	status.toolStart("two", "url_context", setMessage);
	status.toolStart("three", "edit", setMessage);
	status.toolEnd("three", setMessage);
	status.toolEnd("one", setMessage);
	status.toolEnd("two", setMessage);

	assert.deepEqual(output.messages, [
		"Thinking...",
		"Reading...",
		"Working...",
		"Reading...",
		"Thinking...",
	]);
});

test("reset clears tool state and restores Pi's default message", () => {
	const status = new ActivityStatus();
	const output = recorder();
	const setMessage = output.setMessage.bind(output);

	status.toolStart("one", "bash", setMessage);
	status.reset(setMessage);
	status.start(setMessage);
	assert.deepEqual(output.messages, ["Running...", undefined, "Thinking..."]);
});
