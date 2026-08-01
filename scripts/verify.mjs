/**
 * Headless functional verification for the prewalk extension.
 *
 * Loads extensions/prewalk.ts with jiti (the same loader pi uses at runtime),
 * drives it with a mock ExtensionAPI/ExtensionContext, and asserts the core
 * behaviour: flag/command/event registration, arming (command + startup
 * flags), target resolution, the todo gate, the one-way model switch, and
 * context scrubbing of the hidden nudges.
 *
 * Runs anywhere — no pi binary, models, or API keys required.
 *
 *   node scripts/verify.mjs
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const GLM = { provider: "opencode", id: "glm-5.2", cost: { input: 0.5, output: 2 } };
const CLAUDE = { provider: "anthropic", id: "claude-opus-4-8", cost: { input: 15, output: 75 } };

let passed = 0;
let failed = 0;
function check(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}`);
		console.error(`    ${err.message}`);
	}
}

/**
 * Build a fresh extension instance plus mocks. Captures everything the
 * extension does through pi/ctx so tests can assert on it.
 */
function makeHarness({ setModelSucceeds = true } = {}) {
	const flags = new Map();
	const commands = new Map();
	const events = new Map();
	const sent = [];
	const notices = [];
	const setModelCalls = [];
	const thinkingLevels = [];

	const pi = {
		registerFlag: (name, def) => flags.set(name, def),
		registerCommand: (name, def) => commands.set(name, def),
		on: (event, handler) => events.set(event, handler),
		getFlag: (name) => flags.get(name)?.value,
		getActiveTools: () => ["todo", "edit", "write", "bash"],
		sendMessage: (message, opts) => sent.push({ message, opts }),
		setModel: async (model) => {
			setModelCalls.push(model);
			return setModelSucceeds;
		},
		setThinkingLevel: (level) => thinkingLevels.push(level),
	};
	const ctx = {
		model: CLAUDE,
		modelRegistry: { getAvailable: async () => [CLAUDE, GLM] },
		ui: { notify: (msg, level) => notices.push({ msg, level }) },
	};
	return { flags, commands, events, sent, notices, setModelCalls, thinkingLevels, pi, ctx };
}

const jiti = createJiti(import.meta.url);
const extensionPath = fileURLToPath(new URL("../extensions/prewalk.ts", import.meta.url));
const mod = await jiti.import(extensionPath);
const factory = mod.default ?? mod;

console.log("prewalk extension verification\n");

check("default export is a factory function", () => {
	assert.equal(typeof factory, "function");
});

// --- Registration -----------------------------------------------------------

const reg = makeHarness();
factory(reg.pi);

check("registers --prewalk and --prewalk-into flags", () => {
	assert.equal(reg.flags.get("prewalk")?.type, "boolean");
	assert.equal(reg.flags.get("prewalk")?.default, false);
	assert.equal(reg.flags.get("prewalk-into")?.type, "string");
});

check("registers /prewalk command", () => {
	assert.equal(typeof reg.commands.get("prewalk")?.handler, "function");
});

check("subscribes to session_start, turn_end, and context", () => {
	for (const event of ["session_start", "turn_end", "context"]) {
		assert.equal(typeof reg.events.get(event), "function", `missing handler for ${event}`);
	}
});

// --- Command flow: status → arm → gate → switch → scrub ---------------------

const h = makeHarness();
factory(h.pi);
const prewalk = (args) => h.commands.get("prewalk").handler(args, h.ctx);
const turnEnd = (toolNames) =>
	h.events.get("turn_end")(
		{
			message: { role: "assistant" },
			toolResults: toolNames.map((toolName) => ({ isError: false, toolName })),
		},
		h.ctx,
	);

await prewalk("status");
check("status reports not armed before arming", () => {
	assert.ok(h.notices.some((n) => n.msg === "Prewalk: not armed."));
});

await prewalk("");
check("arm resolves the default target opencode/glm-5.2", () => {
	assert.ok(
		h.notices.some((n) => n.msg.startsWith("Prewalk: armed for opencode/glm-5.2")),
		`expected armed notice, got: ${h.notices.map((n) => n.msg).join(" | ")}`,
	);
});

check("arming steers in the hidden plan nudge", () => {
	const plan = h.sent.find((s) => s.message.customType === "prewalk-plan");
	assert.ok(plan, "no plan nudge sent");
	assert.equal(plan.opts.deliverAs, "steer");
	assert.equal(plan.message.display, false);
});

const contextWhileArmed = await h.events.get("context")({
	messages: [{ role: "custom", customType: "prewalk-plan", content: "x" }],
});
check("context is left untouched while armed", () => {
	assert.equal(contextWhileArmed, undefined);
});

await turnEnd(["todo"]);
check("todo-only turn does not trigger the switch (gate waits for edit/write)", () => {
	assert.equal(h.setModelCalls.length, 0);
});

await turnEnd(["edit"]);
check("first edit after the todo list switches to the target model", () => {
	assert.deepEqual(h.setModelCalls, [GLM]);
});

check("switch notifies and steers in the verification checklist", () => {
	assert.ok(h.notices.some((n) => n.msg === "Prewalk: switched to opencode/glm-5.2 after first edit call."));
	const checklist = h.sent.find((s) => s.message.customType === "prewalk-checklist");
	assert.ok(checklist, "no checklist nudge sent");
	assert.equal(checklist.opts.deliverAs, "steer");
});

const contextAfterSwitch = await h.events.get("context")({
	messages: [
		{ role: "custom", customType: "prewalk-plan", content: "x" },
		{ role: "custom", customType: "prewalk-continue", content: "y" },
		{ role: "custom", customType: "prewalk-checklist", content: "z" },
		{ role: "user", content: "hi" },
	],
});
check("after the switch, plan/continue nudges are scrubbed from context (checklist kept)", () => {
	assert.deepEqual(
		contextAfterSwitch.messages.map((m) => m.customType ?? m.role),
		["prewalk-checklist", "user"],
	);
});

// --- Command flow: disarm, explicit spec, unknown spec ----------------------

const d = makeHarness();
factory(d.pi);
await d.commands.get("prewalk").handler("", d.ctx);
await d.commands.get("prewalk").handler("off", d.ctx);
check("/prewalk off disarms", () => {
	assert.ok(d.notices.some((n) => n.msg === "Prewalk: disarmed."));
});

const s = makeHarness();
factory(s.pi);
await s.commands.get("prewalk").handler("claude-opus-4-8", s.ctx);
check("explicit bare-id spec resolves the matching model", () => {
	assert.ok(s.notices.some((n) => n.msg.startsWith("Prewalk: armed for anthropic/claude-opus-4-8")));
});

const u = makeHarness();
factory(u.pi);
await u.commands.get("prewalk").handler("no-such-model", u.ctx);
await u.commands.get("prewalk").handler("status", u.ctx);
check("unknown spec errors and stays disarmed", () => {
	assert.ok(u.notices.some((n) => n.msg === 'Prewalk: No available model matches "no-such-model"' && n.level === "error"));
	assert.ok(u.notices.some((n) => n.msg === "Prewalk: not armed."));
});

// --- Startup arming via --prewalk flag ---------------------------------------

const f = makeHarness();
factory(f.pi);
f.flags.get("prewalk").value = true;
await f.events.get("session_start")({}, f.ctx);
check("--prewalk arms at session_start with the default target", () => {
	assert.ok(f.notices.some((n) => n.msg.startsWith("Prewalk: armed for opencode/glm-5.2")));
});

// --- setModel failure path ----------------------------------------------------

const fail = makeHarness({ setModelSucceeds: false });
factory(fail.pi);
await fail.commands.get("prewalk").handler("", fail.ctx);
await fail.events.get("turn_end")(
	{ message: { role: "assistant" }, toolResults: [{ isError: false, toolName: "todo" }] },
	fail.ctx,
);
await fail.events.get("turn_end")(
	{ message: { role: "assistant" }, toolResults: [{ isError: false, toolName: "edit" }] },
	fail.ctx,
);
check("failed setModel warns and stays on the current model", () => {
	assert.ok(
		fail.notices.some(
			(n) => n.msg === "Prewalk: no API key for opencode/glm-5.2; staying on current model." && n.level === "warning",
		),
	);
	assert.ok(!fail.sent.some((s) => s.message.customType === "prewalk-checklist"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
