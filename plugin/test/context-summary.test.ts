import { describe, expect, test } from "bun:test";
import { extractContextSummary } from "../src/replay/context-summary.ts";

// Mirror the message-shape helpers used in orchestrator.test.ts so the
// extractor is exercised against the same OpenCode envelopes the plugin sees.
function userMsg(id = "msg-1") {
  return {
    info: { id, role: "user" },
    parts: [{ type: "text", text: "hello" }],
  };
}

function assistantMsg(id: string, parts: unknown[] = []) {
  return { info: { id, role: "assistant" }, parts };
}

describe("extractContextSummary — empty / no-work cases", () => {
  test("empty messages → empty string", () => {
    expect(extractContextSummary([], "msg-1")).toBe("");
  });

  test("lastUser id not present → empty string", () => {
    expect(extractContextSummary([userMsg("u1")], "missing-id")).toBe("");
  });

  test("no assistant messages after lastUser → empty string", () => {
    expect(extractContextSummary([userMsg("u1")], "u1")).toBe("");
  });

  test("assistant with empty parts after lastUser → empty string", () => {
    expect(
      extractContextSummary([userMsg("u1"), assistantMsg("a1", [])], "u1"),
    ).toBe("");
  });

  test("assistant BEFORE lastUser is ignored (only walk after)", () => {
    const messages = [
      assistantMsg("a-pre", [{ type: "bash" }]), // before user — must be ignored
      userMsg("u1"),
    ];
    expect(extractContextSummary(messages, "u1")).toBe("");
  });
});

describe("extractContextSummary — tool-call extraction", () => {
  test("captures tool name from part type field", () => {
    const messages = [userMsg("u1"), assistantMsg("a1", [{ type: "bash" }])];
    const summary = extractContextSummary(messages, "u1");
    expect(summary).toContain("bash");
  });

  test("captures multiple tool names across assistant messages", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [{ type: "bash" }, { type: "edit" }]),
      assistantMsg("a2", [{ type: "write" }]),
    ];
    const summary = extractContextSummary(messages, "u1");
    expect(summary).toContain("bash");
    expect(summary).toContain("edit");
    expect(summary).toContain("write");
  });
});

describe("extractContextSummary — text extraction", () => {
  test("captures short text verbatim", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [{ type: "text", text: "done" }]),
    ];
    const summary = extractContextSummary(messages, "u1");
    expect(summary).toContain("done");
  });

  test("truncates text to first ~200 chars", () => {
    const long = "x".repeat(300);
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [{ type: "text", text: long }]),
    ];
    const summary = extractContextSummary(messages, "u1");
    expect(summary).toContain("x".repeat(200));
    expect(summary).not.toContain("x".repeat(201));
  });
});

describe("extractContextSummary — cap", () => {
  test("caps total output at ~2000 chars with truncation marker", () => {
    const messages: unknown[] = [userMsg("u1")];
    for (let i = 0; i < 40; i++) {
      messages.push(
        assistantMsg(`a${i}`, [
          { type: "text", text: `m${i} ` + "y".repeat(120) },
        ]),
      );
    }
    const summary = extractContextSummary(messages, "u1");
    expect(summary.length).toBeLessThanOrEqual(2000);
    expect(summary).toContain("truncated");
  });
});

describe("extractContextSummary — graceful degradation", () => {
  test("garbage entries mixed in → still extracts valid work", () => {
    const messages: unknown[] = [
      userMsg("u1"),
      null,
      "string-not-record",
      42,
      assistantMsg("a1", [{ type: "bash" }]),
    ];
    const summary = extractContextSummary(messages, "u1");
    expect(summary).toContain("bash");
  });

  test("non-array messages argument → empty string (try/catch)", () => {
    expect(
      extractContextSummary("not-an-array" as unknown as unknown[], "u1"),
    ).toBe("");
  });

  test("nested OpenCode shape {info:{id,role}, parts} supported", () => {
    const messages = [
      userMsg("u1"),
      {
        info: { id: "a-nested", role: "assistant" },
        parts: [{ type: "read" }],
      },
    ];
    const summary = extractContextSummary(messages, "u1");
    expect(summary).toContain("read");
  });

  test("non-string lastUserMessageID → empty string", () => {
    expect(extractContextSummary([userMsg("u1")], "")).toBe("");
  });
});

describe("extractContextSummary — malformed parts", () => {
  test("{ type: 'text' } with no text field → empty string (no throw)", () => {
    const messages = [userMsg("u1"), assistantMsg("a1", [{ type: "text" }])];
    expect(() => extractContextSummary(messages, "u1")).not.toThrow();
    expect(extractContextSummary(messages, "u1")).toBe("");
  });

  test("{ type: 'text', text: <non-string> } → empty string (text not a string)", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [{ type: "text", text: 123 }]),
    ];
    expect(extractContextSummary(messages, "u1")).toBe("");
  });

  test("{ type: 123 } non-string type → skipped, no tool captured", () => {
    const messages = [userMsg("u1"), assistantMsg("a1", [{ type: 123 }])];
    expect(extractContextSummary(messages, "u1")).toBe("");
  });

  test("null part mixed with valid tool → null skipped, valid still extracted", () => {
    const messages = [
      userMsg("u1"),
      assistantMsg("a1", [null, { type: "bash" }]),
    ];
    const summary = extractContextSummary(messages, "u1");
    expect(summary).toContain("bash");
  });

  test("part with getter that throws on `.type` → graceful empty string", () => {
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, "type", {
      get() {
        throw new Error("type getter boom");
      },
    });
    const messages = [userMsg("u1"), assistantMsg("a1", [throwing])];
    expect(() => extractContextSummary(messages, "u1")).not.toThrow();
    expect(extractContextSummary(messages, "u1")).toBe("");
  });
});

describe("extractContextSummary — throwing accessors", () => {
  test("object that throws when accessing `.type` → returns empty string", () => {
    const part: Record<string, unknown> = {};
    Object.defineProperty(part, "type", {
      get() {
        throw new Error("cannot read type");
      },
    });
    const messages = [userMsg("u1"), assistantMsg("a1", [part])];
    expect(() => extractContextSummary(messages, "u1")).not.toThrow();
    expect(extractContextSummary(messages, "u1")).toBe("");
  });

  test("text part that throws when accessing `.text` → returns empty string", () => {
    const part: Record<string, unknown> = {};
    Object.defineProperty(part, "type", { value: "text" });
    Object.defineProperty(part, "text", {
      get() {
        throw new Error("cannot read text");
      },
    });
    const messages = [userMsg("u1"), assistantMsg("a1", [part])];
    expect(() => extractContextSummary(messages, "u1")).not.toThrow();
    expect(extractContextSummary(messages, "u1")).toBe("");
  });
});
