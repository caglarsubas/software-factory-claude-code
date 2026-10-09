import { describe, expect, it } from "vitest";
import { exec, runArgs, type ContainerSpec } from "./container.ts";

const gate: ContainerSpec = {
  name: "sf-gate-test",
  image: "software-factory-gates:test",
  network: "none",
  volumes: [{ volume: "sf-data", target: "/data", readOnly: false }, { volume: "sf-osv", target: "/osv", readOnly: true }],
  env: { CI: "true" },
  argv: ["sh", "-c", "pnpm test"],
};

describe("runArgs", () => {
  const args = runArgs(gate);
  const after = (flag: string) => args.filter((_, i) => args[i - 1] === flag);

  it("hardens every container", () => {
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(after("--cap-drop")).toEqual(["ALL"]);
    expect(after("--security-opt")).toEqual(["no-new-privileges"]);
    expect(args).toContain("--read-only");
    expect(after("--user")).toEqual(["10001:10001"]);
    expect(after("--pids-limit")).toHaveLength(1);
    expect(after("--memory")).toHaveLength(1);
  });
  it("gives gate containers no network and only volume mounts", () => {
    expect(after("--network")).toEqual(["none"]);
    expect(after("--mount")).toEqual(["type=volume,src=sf-data,dst=/data", "type=volume,src=sf-osv,dst=/osv,readonly"]);
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--privileged");
  });
  it("puts the image and command last", () => {
    expect(args.slice(-4)).toEqual(["software-factory-gates:test", "sh", "-c", "pnpm test"]);
  });
  it("mounts a CA bundle read-only and passes proxy settings by name only", () => {
    const previous = process.env["HTTPS_PROXY"];
    process.env["HTTPS_PROXY"] = "http://proxy-value-marker.invalid:3128";
    const fetch = runArgs({ ...gate, network: "bridge", caFile: "/etc/corp/ca.pem", passEnv: ["HTTPS_PROXY", "UNSET_VAR_FOR_TEST"] });
    if (previous === undefined) delete process.env["HTTPS_PROXY"];
    else process.env["HTTPS_PROXY"] = previous;
    expect(fetch).toContain("type=bind,src=/etc/corp/ca.pem,dst=/etc/ssl/factory-ca.crt,readonly");
    expect(fetch).toContain("SSL_CERT_FILE=/etc/ssl/factory-ca.crt");
    expect(fetch).toContain("HTTPS_PROXY");
    expect(fetch.join(" ")).not.toContain("proxy-value-marker");
    expect(fetch).not.toContain("UNSET_VAR_FOR_TEST");
  });
  it("refuses mount values that could inject mount options", () => {
    expect(() => runArgs({ ...gate, volumes: [{ volume: "x,dst=/etc", target: "/data", readOnly: false }] })).toThrow(/unsafe/);
    expect(() => runArgs({ ...gate, caFile: "/tmp/a,readonly=false" })).toThrow(/unsafe/);
  });
});

describe("exec", () => {
  it("captures output and the exit status", async () => {
    const r = await exec(process.execPath, ["-e", "console.log('out'); console.error('err'); process.exit(3)"], { timeoutMs: 10_000 });
    expect(r).toMatchObject({ status: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
  });
  it("kills a command that runs past its timeout", async () => {
    let called = false;
    const r = await exec(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 200, onTimeout: () => (called = true) });
    expect(r.timedOut).toBe(true);
    expect(called).toBe(true);
    expect(r.status).toBeNull();
  });
});
