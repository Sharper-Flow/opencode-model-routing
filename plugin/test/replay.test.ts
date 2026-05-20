import { describe, expect, test } from "bun:test";
import { convertPartsForPrompt } from "../src/replay/message-converter.ts";

describe("convertPartsForPrompt", () => {
  test("passes text parts through", () => {
    const parts = [{ type: "text", text: "hello" }];
    const out = convertPartsForPrompt(parts);
    expect(out).toEqual(parts);
  });

  test("passes tool-call parts through", () => {
    const parts = [
      { type: "tool-call", toolCallId: "1", toolName: "bash", input: {} },
    ];
    expect(convertPartsForPrompt(parts)).toEqual(parts);
  });

  test("handles null / undefined", () => {
    expect(convertPartsForPrompt(null)).toEqual([]);
    expect(convertPartsForPrompt(undefined)).toEqual([]);
  });

  test("makes defensive copy (mutating output does not mutate input)", () => {
    const parts = [{ type: "text", text: "a" }];
    const out = convertPartsForPrompt(parts);
    out.push({ type: "text", text: "b" });
    expect(parts.length).toBe(1);
  });
});
