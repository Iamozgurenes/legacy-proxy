import { describe, expect, it } from "vitest";
import { resolveArgs, jsonPointer, harvestCreatedIds, type CreatedIds } from "../../src/jmap/refs.js";

describe("JMAP back-references", () => {
  it("resolves a simple #ref", () => {
    const prior = { c1: { name: "Mailbox/get", result: { list: [{ id: "abc" }] } } };
    const args = { "#ids": { resultOf: "c1", name: "Mailbox/get", path: "/list/0/id" } };
    expect(resolveArgs(args, prior)).toEqual({ ids: "abc" });
  });
  it("rejects when previous call mismatches", () => {
    const prior = { c1: { name: "Foo/get", result: {} } };
    const args = { "#ids": { resultOf: "c1", name: "Mailbox/get", path: "/x" } };
    expect(() => resolveArgs(args, prior)).toThrow(/invalidResultReference/);
  });
  it("jsonPointer walks objects and arrays", () => {
    expect(jsonPointer({ a: { b: [10, 20, 30] } }, "/a/b/2")).toBe(30);
  });
  it("jsonPointer flattens through the * wildcard", () => {
    // The common JMAP chain: Email/query -> Email/get with
    // path: "/list/*/id". Without wildcard support every chained back-ref
    // returned undefined and clients silently lost ids.
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(jsonPointer({ list }, "/list/*/id")).toEqual(["a", "b", "c"]);
  });
  it("jsonPointer * keeps nested arrays flat", () => {
    const groups = [{ ids: ["a", "b"] }, { ids: ["c"] }];
    expect(jsonPointer({ groups }, "/groups/*/ids")).toEqual(["a", "b", "c"]);
  });
  it("does not treat nested #-prefixed keys as result references", () => {
    // EmailSubmission/set's onSuccessUpdateEmail uses `#tempId` keys per
    // RFC 8621 §7.3. These must pass through unchanged so the method
    // handler can resolve them against just-created submissions.
    const args = {
      accountId: "1",
      onSuccessUpdateEmail: {
        "#sub1": { "mailboxIds/abc": null, "mailboxIds/def": true },
      },
    };
    expect(resolveArgs(args, {})).toEqual(args);
  });
  it("resolves string creation references inside nested structures", () => {
    const createdIds = new Map([["new-email", "real-id-42"]]);
    const args = {
      accountId: "1",
      create: { sub1: { emailId: "#new-email" } },
    };
    expect(resolveArgs(args, {}, createdIds)).toEqual({
      accountId: "1",
      create: { sub1: { emailId: "real-id-42" } },
    });
  });
});

describe("harvestCreatedIds", () => {
  it("harvests creation ids from Email/import so EmailSubmission can reference them", () => {
    const ids: CreatedIds = new Map();
    harvestCreatedIds(ids, "Email/import", {
      created: { "raw-import": { id: "AQOcz7DBBrkJ", blobId: "b", threadId: "t", size: 1 } },
    });
    expect(ids.get("raw-import")).toBe("AQOcz7DBBrkJ");
    expect(resolveArgs({ create: { s: { emailId: "#raw-import" } } }, {}, ids)).toEqual({
      create: { s: { emailId: "AQOcz7DBBrkJ" } },
    });
  });

  it("harvests from */set and */copy but not from reads", () => {
    const ids: CreatedIds = new Map();
    harvestCreatedIds(ids, "Email/set", { created: { a: { id: "1" } } });
    harvestCreatedIds(ids, "Email/copy", { created: { b: { id: "2" } } });
    harvestCreatedIds(ids, "Email/get", { created: { c: { id: "3" } } });
    expect([...ids]).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });
});
