// The stub GitHub runs inside the test process, whose event loop blocks for seconds at a time in
// synchronous git calls (the kill-point suite measured blocks of almost 4 s, longer under a full
// run's load). With Node's default 5 s keep-alive, a request a factoryctl process had already sent
// on its pooled connection was reset when the server's expired timer ran before it read the
// request: "fetch failed", cause ECONNRESET. The stub leaves closing idle connections to the client.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { memoryGitHub, serveGitHub } from "./testing.ts";

describe("the stub GitHub", () => {
  it("answers a request a client sent on its pooled connection while this process was blocked past Node's keep-alive", async () => {
    const api = await serveGitHub(memoryGitHub());
    try {
      // As factoryctl does: one call, then another two seconds later on the same pooled connection.
      const child = spawn(process.execPath, ["-e", `
        const url = ${JSON.stringify(`${api.url}/user`)};
        (async () => {
          await (await fetch(url)).text();
          console.log("first");
          await new Promise((r) => setTimeout(r, 2000));
          try {
            await (await fetch(url)).text();
            console.log("second: ok");
          } catch (e) {
            console.log("second: " + e.message + " (" + String(e.cause?.code ?? e.cause) + ")");
          }
        })();
      `], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      const done = new Promise<void>((resolve) => child.once("close", () => {
        resolve();
      }));
      child.stdout.on("data", (b: Buffer) => {
        out += b.toString();
        // Once the first call is answered, block this process for 7 s where a test's continuation would:
        // in an I/O callback's follow-up, so the next loop iteration runs expired timers before it reads sockets.
        if (out === "first\n") {
          setImmediate(() => {
            const end = Date.now() + 7000;
            while (Date.now() < end) {
              // A test's synchronous git calls, under load.
            }
          });
        }
      });
      await done;
      expect(out).toBe("first\nsecond: ok\n");
    } finally {
      await api.close();
    }
  }, 30_000);
});
