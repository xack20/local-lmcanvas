// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { cancelAllForClient, completeRequest, requestAnswer } from "./askUserBridge.ts";

function fakeClient(id = "c1") {
  const listeners = new Set();
  const client = {
    id,
    kind: "browser",
    sent: [],
    gone: false,
    send(channel, payload) {
      client.sent.push({ channel, payload });
    },
    isGone: () => client.gone,
    onGone(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    die() {
      client.gone = true;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
  return client;
}

const QUESTIONS = [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }];

describe("askUserBridge", () => {
  test("sends the request to the client and resolves with its answer", async () => {
    const client = fakeClient();
    const answer = requestAnswer(QUESTIONS, client, "node-1");
    const { channel, payload } = client.sent[0];
    expect(channel).toBe("askUser:request");
    expect(payload.nodeId).toBe("node-1");
    completeRequest({ id: payload.id, answers: ["A"] });
    expect(await answer).toEqual({ id: payload.id, answers: ["A"] });
    expect(client.listenerCount()).toBe(0);
  });

  test("resolves as cancelled when the client goes away", async () => {
    const client = fakeClient();
    const answer = requestAnswer(QUESTIONS, client, "node-1");
    const { id } = client.sent[0].payload;
    client.die();
    expect(await answer).toEqual({ id, cancelled: true });
  });

  test("cancelAllForClient settles only that client's requests", async () => {
    const mine = fakeClient("mine");
    const other = fakeClient("other");
    const mineAnswer = requestAnswer(QUESTIONS, mine, "n1");
    const otherAnswer = requestAnswer(QUESTIONS, other, "n2");
    cancelAllForClient(mine);
    expect((await mineAnswer).cancelled).toBe(true);
    const otherId = other.sent[0].payload.id;
    completeRequest({ id: otherId, answers: ["B"] });
    expect(await otherAnswer).toEqual({ id: otherId, answers: ["B"] });
  });

  test("rejects at once when the client is already gone", async () => {
    const client = fakeClient();
    client.gone = true;
    await expect(requestAnswer(QUESTIONS, client, "n1")).rejects.toThrow("Target window is gone");
  });
});
