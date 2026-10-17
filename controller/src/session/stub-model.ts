// A stand-in for the Messages API, for the runner's conformance suite (P2-01) and the gateway's
// tests (P2-02): the pinned CLI talks to it as it would to Anthropic, with a dummy key, and it
// answers from a script. It is stateless: the prompt names a case (`[case:<name>]`), and the
// number of assistant turns already in the conversation picks the case's next turn, so a
// retried request gets the same answer. Requests that carry no tools (the CLI's side calls)
// get a short text answer. Any other route is refused and logged, so a call the suite did not
// expect shows up as a failure rather than passing silently.
//
// Dependency-free: it runs inside a runner container as `node stub-model.ts`, configured by env:
//   STUB_SCRIPT  path of a JSON file: { "<case>": [Turn, ...] }, read on every request
//   STUB_LOG     NDJSON log of every request, with the tool results the CLI sent back
//   STUB_PORT    listen port (default 8080)
import { appendFileSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type Turn = { text: string } | { tool: string; input: Record<string, unknown> };
export type Script = Record<string, Turn[]>;

interface Block {
  type: string;
  text?: string;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface Message {
  role: string;
  content: string | Block[];
}

interface Request {
  model?: string;
  stream?: boolean;
  tools?: unknown[];
  messages?: Message[];
}

const CASE = /\[case:([a-z0-9-]+)\]/;

function caseOf(messages: Message[]): string | null {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("\n");
    const hit = CASE.exec(text);
    if (hit !== null) return hit[1] ?? null;
  }
  return null;
}

/** The text of the last user turn: a hook's feedback reaches the model there. */
function lastUserText(messages: Message[]): string {
  const m = messages.filter((x) => x.role === "user").at(-1);
  if (m === undefined) return "";
  return (typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")).slice(-2000);
}

const toolResults = (messages: Message[]): Block[] => messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result")));

export function nextTurn(script: Script, req: Request): { turn: Turn; case: string | null; index: number } {
  const messages = req.messages ?? [];
  if ((req.tools ?? []).length === 0) return { turn: { text: "ok" }, case: null, index: -1 };
  const name = caseOf(messages);
  const turns = name === null ? undefined : script[name];
  const index = messages.filter((m) => m.role === "assistant").length;
  return { turn: turns?.[index] ?? { text: "done" }, case: name, index };
}

function answer(res: ServerResponse, req: Request, turn: Turn, id: string): void {
  const usage = { input_tokens: 10, output_tokens: 1 };
  const message = { id, type: "message", role: "assistant", model: req.model ?? "stub", content: [] as unknown[], stop_reason: null, stop_sequence: null, usage };
  const tool = "tool" in turn;
  const block = tool ? { type: "tool_use", id: `toolu_${id}`, name: turn.tool, input: {} } : { type: "text", text: "" };
  const stop = tool ? "tool_use" : "end_turn";
  if (req.stream !== true) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...message, content: [tool ? { ...block, input: turn.input } : { type: "text", text: turn.text }], stop_reason: stop }));
    return;
  }
  const delta = tool ? { type: "input_json_delta", partial_json: JSON.stringify(turn.input) } : { type: "text_delta", text: turn.text };
  const events = [
    { type: "message_start", message },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

export function stubHandler(script: () => Script, log: (e: Record<string, unknown>) => void): (req: IncomingMessage, res: ServerResponse) => void {
  let n = 0;
  return (req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const url = req.url ?? "";
      const path = url.split("?")[0] ?? "";
      if (req.method === "GET" && path === "/api/hello") {
        log({ route: path });
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (req.method !== "POST" || !path.startsWith("/v1/messages")) {
        log({ route: path, method: req.method ?? null, refused: true });
        res.writeHead(404, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"not_found_error","message":"stub: unknown route"}}');
        return;
      }
      let parsed: Request;
      try {
        parsed = JSON.parse(body === "" ? "{}" : body) as Request;
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (path === "/v1/messages/count_tokens") {
        log({ route: path });
        res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
        return;
      }
      const next = nextTurn(script(), parsed);
      log({ route: path, model: parsed.model ?? null, case: next.case, index: next.index, turn: next.turn, tool_results: toolResults(parsed.messages ?? []), last_user_text: lastUserText(parsed.messages ?? []), auth: req.headers["x-api-key"] === undefined ? "none" : "x-api-key" });
      answer(res, parsed, next.turn, `msg_${String(++n)}`);
    });
  };
}

if (import.meta.main) {
  const script = (): Script => JSON.parse(readFileSync(process.env["STUB_SCRIPT"] ?? "", "utf8")) as Script;
  const file = process.env["STUB_LOG"];
  const log = (e: Record<string, unknown>): void => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`;
    if (file === undefined || file === "") process.stdout.write(line);
    else appendFileSync(file, line);
  };
  createServer(stubHandler(script, log)).listen(Number(process.env["STUB_PORT"] ?? "8080"), "0.0.0.0");
}
