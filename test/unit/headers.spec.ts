import { describe, expect, it } from "vitest";
import { headersToEmailHeaders, parseHeaderBlock } from "../../src/imap/headers.js";

describe("headersToEmailHeaders", () => {
  it("returns every header in order with Raw values, keeping parameters", () => {
    const parsed = parseHeaderBlock(
      [
        "From: a@example.org",
        "Content-Type: application/pkcs7-mime; smime-type=signed-data;",
        ' name="smime.p7m"',
        "Received: one",
        "Received: two",
        "",
        "body",
      ].join("\r\n"),
    );
    expect(headersToEmailHeaders(parsed)).toEqual([
      { name: "From", value: " a@example.org" },
      {
        name: "Content-Type",
        value: ' application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"',
      },
      { name: "Received", value: " one" },
      { name: "Received", value: " two" },
    ]);
  });
});
