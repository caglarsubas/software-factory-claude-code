// policy-check's sink scan with the real gate image (pnpm test:gates): the release's
// sink_added pack over head files passed as data, matches counted only on added lines.
import { describe, expect, it } from "vitest";
import { ensureImage } from "../../../gates/src/image.ts";
import { containerSinkScanner, SinkScanError } from "./sinks.ts";

describe("policy-check's sink scan", () => {
  const scan = containerSinkScanner(ensureImage());

  it("finds a sink on an added line, of each kind, and none on a line the PR did not add", async () => {
    expect(await scan([
      { path: "src/pricing/rules.ts", content: "export const rules = [];\nexport const apply = (s: string) => eval(s);\n", added: [2] },
      { path: "app/snap.py", content: "import pickle\n\ndef load(b):\n    return pickle.loads(b)\n", added: [4] },
    ])).toEqual(["code_exec", "deserialization"]);
    expect(await scan([{ path: "src/pricing/rules.ts", content: "export const apply = (s: string) => eval(s);\nexport const rules = [];\n", added: [2] }])).toEqual([]);
    expect(await scan([])).toEqual([]);
  }, 600_000);

  it("refuses a path that leaves the scan directory", async () => {
    await expect(scan([{ path: "../../etc/x.ts", content: "eval(x)\n", added: [1] }])).rejects.toThrow(SinkScanError);
  }, 600_000);
});
