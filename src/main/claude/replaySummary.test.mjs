import { describe, expect, test } from "bun:test";
import { summarizeForReplay } from "./replaySummary.ts";

function fakeQuery(reply) {
  const calls = [];
  const queryFn = ({ prompt, options }) => {
    const call = { options, text: null };
    calls.push(call);
    async function* stream() {
      const first = await prompt[Symbol.asyncIterator]().next();
      call.text = first.value.message.content;
      yield { type: "result", subtype: "success", is_error: false, result: ` ${reply(calls.length)} ` };
    }
    return stream();
  };
  return { queryFn, calls };
}

describe("summarizeForReplay", () => {
  test("summarizes with no tools at all", async () => {
    const { queryFn, calls } = fakeQuery(() => "We decided X.");
    const out = await summarizeForReplay("[User]\nhello", { cwd: "/tmp", window: 200_000, queryFn });
    expect(out).toBe("We decided X.");
    expect(calls[0].options.tools).toEqual([]);
    expect(calls[0].options.settingSources).toEqual([]);
    const decision = await calls[0].options.canUseTool("Bash", {}, { signal: new AbortController().signal, toolUseID: "t" });
    expect(decision.behavior).toBe("deny");
  });

  test("summarizes text larger than the window chunk by chunk, then joins the parts", async () => {
    const { queryFn, calls } = fakeQuery((n) => `part ${n}`);
    const section = (c) => `[User]\n${c.repeat(300)}`;
    // window 200 tokens → chunks of at most 480 chars, so each 307-char section is its own chunk.
    const out = await summarizeForReplay([section("a"), section("b"), section("c")].join("\n\n"), { cwd: "/tmp", window: 200, queryFn });
    expect(calls.length).toBe(3);
    expect(out).toBe("part 1\n\npart 2\n\npart 3");
  });

  test("stops when the chat is stopped", async () => {
    const stop = new AbortController();
    let seenAbort = null;
    const queryFn = ({ options }) => (async function* () {
      seenAbort = options.abortController.signal;
      stop.abort();
      yield { type: "result", subtype: "success", is_error: false, result: "late" };
    })();
    await expect(summarizeForReplay("[User]\nhi", { cwd: "/tmp", window: 200_000, queryFn, signal: stop.signal })).rejects.toThrow("stopped");
    expect(seenAbort.aborted).toBe(true);
    const neverCalled = () => { throw new Error("should not start"); };
    await expect(summarizeForReplay("[User]\nhi", { cwd: "/tmp", window: 200_000, queryFn: neverCalled, signal: stop.signal })).rejects.toThrow("stopped");
  });

  test("fails when Claude couldn't summarize", async () => {
    const queryFn = () => (async function* () { yield { type: "result", subtype: "error_during_execution", is_error: true }; })();
    await expect(summarizeForReplay("[User]\nhi", { cwd: "/tmp", window: 200_000, queryFn })).rejects.toThrow("Couldn't summarize");
  });
});
