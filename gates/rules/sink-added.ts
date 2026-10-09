// Rule tests for sink-added.yaml (`opengrep test`). Not compiled or linted.
// ruleid: js-process-exec
import { execFile, spawn } from "node:child_process";
// ruleid: js-code-exec
import vm from "node:vm";

// ruleid: js-code-exec
eval(input);
// ruleid: js-code-exec
const f = new Function("a", body);
// ruleid: js-code-exec
vm.runInNewContext(code, sandbox);

// ruleid: js-process-exec
child_process.exec(`git log ${ref}`);
// ok: js-process-exec
const match = /\d+/.exec(text);
// ruleid: js-process-exec
cp.spawn("ls", ["-la"], { shell: true });
// ruleid: js-process-exec
execSync("make");

// ruleid: js-unsafe-deserialization
const serialize = require("node-serialize");
// ruleid: js-unsafe-deserialization
serialize.unserialize(payload);
// ruleid: js-unsafe-deserialization
v8.deserialize(buffer);
// ok: js-unsafe-deserialization
JSON.parse(payload);
