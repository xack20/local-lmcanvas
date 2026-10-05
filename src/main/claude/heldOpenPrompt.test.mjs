// src/main/claude/heldOpenPrompt.test.mjs
import { expect, test } from "bun:test";
import { heldOpenPrompt } from "./heldOpenPrompt.ts";

test("yields the message, then stays open until released", async () => {
  const message = { type: "user", parent_tool_use_id: null, message: { role: "user", content: "hi" } };
  const held = heldOpenPrompt(message);
  const it = held.input[Symbol.asyncIterator]();
  expect((await it.next()).value).toBe(message);
  let finished = false;
  const next = it.next().then((r) => (finished = r.done));
  await new Promise((r) => setTimeout(r, 10));
  expect(finished).toBe(false);
  held.release();
  await next;
  expect(finished).toBe(true);
});
