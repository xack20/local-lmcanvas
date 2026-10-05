// .mjs keeps the bun:test import out of `bun run typecheck`.
import { beforeEach, describe, expect, test } from "bun:test";
import { useNodePanelStore } from "./useNodePanelStore.ts";

describe("useNodePanelStore", () => {
  beforeEach(() => useNodePanelStore.getState().hide());

  test("starts closed, so selecting a node does not open the panel", () => {
    expect(useNodePanelStore.getInitialState().open).toBe(false);
  });

  test("show opens the panel and hide closes it", () => {
    useNodePanelStore.getState().show();
    expect(useNodePanelStore.getState().open).toBe(true);
    useNodePanelStore.getState().hide();
    expect(useNodePanelStore.getState().open).toBe(false);
  });
});
