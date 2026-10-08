import { describe, expect, it, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { SieveClient } from "../../src/sieve/client.js";

// A firewalled Sieve port used to hang connect() until the OS's own TCP
// retry timeout (~130s on Linux), one leaked socket per attempt. These cover
// both halves of the fix: a TCP connect that never completes, and a server
// that accepts the connection but never speaks (same symptom, different
// phase) -- both must now fail on our own short deadline instead.

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("SieveClient connect timeout", () => {
  it("fails fast when the server accepts the connection but never sends a greeting", async () => {
    server = createServer((socket) => {
      // Accept and say nothing -- the handshake-hang case.
      socket.on("error", () => {});
    });
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
    });

    const client = new SieveClient({
      host: "127.0.0.1",
      port,
      creds: { mech: "PLAIN", username: "a", password: "b" },
      connectTimeoutMs: 200,
    });

    const start = Date.now();
    await expect(client.connect()).rejects.toThrow(/timed out/i);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("still rejects quickly and normally when the port is simply closed", async () => {
    // Nothing listening on this port -- a real, fast ECONNREFUSED, unrelated
    // to our timeout path; confirms the refactor didn't swallow it.
    const client = new SieveClient({
      host: "127.0.0.1",
      port: 1,
      creds: { mech: "PLAIN", username: "a", password: "b" },
      connectTimeoutMs: 5000,
    });
    await expect(client.connect()).rejects.toThrow();
  });
});
