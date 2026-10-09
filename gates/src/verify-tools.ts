// Verify every download the gate image pins (ROADMAP §3.2: each scanner and package has a
// signature or provenance check). CI runs this before building the image; it reads the pins
// from the Dockerfile itself, so a pin cannot land without its publisher's signature.
//
//   node gates/src/verify-tools.ts      (needs curl, cosign, slsa-verifier, and gh with GH_TOKEN)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { GATES_DIR } from "./image.ts";

export interface Pin {
  sha256: string;
  url: string;
}

const ADD = /^ADD --checksum=sha256:([0-9a-f]{64}) \\\n\s+(https:\/\/\S+) \S+$/gm;

export function pins(dockerfile: string): Pin[] {
  return [...dockerfile.matchAll(ADD)].map((m) => ({ sha256: m[1] ?? "", url: m[2] ?? "" }));
}

const RELEASE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\/v?([^/]+)\/([^/]+)$/;
const COSIGN_ISSUER = "https://token.actions.githubusercontent.com";

/** The commands that prove a pinned file came from its publisher's release workflow. */
export function verification(pin: Pin, file: string): { fetch: string[]; run: string[][] } {
  const m = RELEASE.exec(pin.url);
  if (m === null) throw new Error(`not a GitHub release download: ${pin.url}`);
  const [, repo = "", version = "", asset = ""] = m;
  const dir = pin.url.slice(0, pin.url.length - asset.length);
  switch (repo) {
    case "trufflesecurity/trufflehog": {
      // Signed checksums file; the pinned hash must be the one it lists for this asset.
      const sums = `trufflehog_${version}_checksums.txt`;
      return {
        fetch: [sums, `${sums}.pem`, `${sums}.sig`].map((f) => dir + f),
        run: [
          ["cosign", "verify-blob", "--certificate", `${sums}.pem`, "--signature", `${sums}.sig`, "--certificate-identity", `https://github.com/${repo}/.github/workflows/release.yml@refs/tags/v${version}`, "--certificate-oidc-issuer", COSIGN_ISSUER, sums],
          ["grep", "-qx", `${pin.sha256}  ${asset}`, sums],
        ],
      };
    }
    case "opengrep/opengrep":
      return {
        fetch: [`${pin.url}.cert`, `${pin.url}.sig`],
        run: [["cosign", "verify-blob", "--certificate", `${asset}.cert`, "--signature", `${asset}.sig`, "--certificate-identity", `https://github.com/${repo}/.github/workflows/rolling-release.yml@refs/heads/release-v${version}`, "--certificate-oidc-issuer", COSIGN_ISSUER, file]],
      };
    case "google/osv-scanner":
      return {
        fetch: [`${dir}multiple.intoto.jsonl`],
        run: [["slsa-verifier", "verify-artifact", file, "--provenance-path", "multiple.intoto.jsonl", "--source-uri", `github.com/${repo}`, "--source-tag", `v${version}`]],
      };
    case "astral-sh/uv":
      return { fetch: [], run: [["gh", "attestation", "verify", file, "--repo", repo]] };
    default:
      throw new Error(`no signature or provenance check is defined for ${repo}`);
  }
}

function sh(cwd: string, argv: string[]): void {
  const [cmd = "", ...args] = argv;
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${argv.join(" ")} failed:\n${r.stdout}${r.stderr}`);
}

function main(): void {
  const all = pins(readFileSync(join(GATES_DIR, "image/Dockerfile"), "utf8"));
  let failed = 0;
  for (const pin of all) {
    const dir = mkdtempSync(join(tmpdir(), "verify-"));
    const file = basename(pin.url);
    try {
      const plan = verification(pin, file);
      for (const url of [pin.url, ...plan.fetch]) sh(dir, ["curl", "--fail", "--silent", "--show-error", "--location", "--remote-name", url]);
      const actual = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
      if (actual !== pin.sha256) throw new Error(`sha256 ${actual} does not match the pin ${pin.sha256}`);
      for (const argv of plan.run) sh(dir, argv);
      process.stdout.write(`verified  ${pin.url}\n`);
    } catch (e) {
      failed++;
      process.stdout.write(`FAILED    ${pin.url}\n${e instanceof Error ? e.message : String(e)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  process.stdout.write(`${String(all.length - failed)}/${String(all.length)} pinned downloads verified\n`);
  process.exit(failed === 0 && all.length > 0 ? 0 : 1);
}

if (import.meta.main) main();
