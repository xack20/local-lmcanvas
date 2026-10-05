import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** A one-message prompt stream that stays open until released, so the session still answers
 *  control requests (e.g. getContextUsage) after its final result. */
export function heldOpenPrompt(message: SDKUserMessage): { input: AsyncIterable<SDKUserMessage>; release(): void } {
  let release = (): void => {};
  const idle = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* input(): AsyncGenerator<SDKUserMessage, void> {
    yield message;
    await idle;
  }
  return { input: input(), release: () => release() };
}
