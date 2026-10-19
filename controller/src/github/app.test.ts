// The factory App's authentication (P2-05): a JWT signed with the App's key, traded for
// installation tokens narrowed to the run's target and minted again well before they lapse; the
// App's configuration, key permissions and granted permissions.
import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { factoryHome } from "../home.ts";
import { appConfig, AppConfigError, appInfo, appJwt, appTokens, permissionDiff, readAppKey, type AppConfig } from "./app.ts";

const scratch = mkdtempSync(join(tmpdir(), "app-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const keyFile = join(scratch, "github-app.pem");
writeFileSync(keyFile, pem, { mode: 0o600 });
const app: AppConfig = { appId: 4242, installationId: 77, keyFile };

const decode = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

describe("the factory App", () => {
  it("signs an RS256 JWT GitHub accepts: issued a minute back, for at most ten minutes", () => {
    const now = Date.parse("2026-10-18T10:00:00Z");
    const [header = "", payload = "", signature = ""] = appJwt(4242, pem, now).split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload);
    expect(claims).toEqual({ iss: "4242", iat: now / 1000 - 60, exp: now / 1000 + 540 });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("mints installation tokens narrowed to the target, and mints again before one lapses", async () => {
    let clock = Date.parse("2026-10-18T10:00:00Z");
    const calls: { url: string; auth: string; body: unknown }[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: url.toString(), auth: headers.get("authorization") ?? "", body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return Promise.resolve(new Response(JSON.stringify({ token: `ghs_${String(calls.length)}`, expires_at: new Date(clock + 3_600_000).toISOString(), permissions: { contents: "write" } }), { status: 201 }));
    }) as typeof fetch;
    const tokens = appTokens({ app, api: "https://api.example", fetchFn, now: () => clock, repositories: ["target"] });
    expect(() => tokens.current()).toThrow(/no installation token yet/);
    expect(await tokens.token()).toBe("ghs_1");
    expect(calls[0]).toMatchObject({ url: "https://api.example/app/installations/77/access_tokens", body: { repositories: ["target"] } });
    expect(calls[0]?.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    clock += 20 * 60_000;
    expect(await tokens.token()).toBe("ghs_1");
    expect(tokens.current()).toBe("ghs_1");
    // Less than 30 minutes left: a new one.
    clock += 15 * 60_000;
    expect(await tokens.token()).toBe("ghs_2");
    expect(calls).toHaveLength(2);
  });

  it("reads its IDs from the environment or github-app.json, and refuses a key others can read", () => {
    const home = factoryHome({ FACTORY_HOME: join(scratch, "home") });
    expect(appConfig(home, {})).toBeNull();
    expect(appConfig(home, { FACTORY_GITHUB_APP_ID: "5", FACTORY_GITHUB_APP_INSTALLATION_ID: "6", FACTORY_GITHUB_APP_KEY_FILE: keyFile })).toEqual({ appId: 5, installationId: 6, keyFile });
    expect(() => appConfig(home, { FACTORY_GITHUB_APP_ID: "5" })).toThrow(AppConfigError);
    const withFile = factoryHome({ FACTORY_HOME: join(scratch, "home2") });
    mkdirSync(withFile.root, { recursive: true });
    writeFileSync(join(withFile.root, "github-app.json"), JSON.stringify({ app_id: 5364464, installation_id: 172578832 }));
    expect(appConfig(withFile, {})).toEqual({ appId: 5364464, installationId: 172578832, keyFile: join(withFile.secrets, "github-app.pem") });
    writeFileSync(join(withFile.root, "github-app.json"), JSON.stringify({ app_id: "x", installation_id: 1 }));
    expect(() => appConfig(withFile, {})).toThrow(/app_id must be a positive integer/);
    expect(readAppKey(keyFile)).toBe(pem);
    const loose = join(scratch, "loose.pem");
    writeFileSync(loose, pem);
    chmodSync(loose, 0o644);
    expect(() => readAppKey(loose)).toThrow(/chmod 600/);
    expect(() => readAppKey(join(scratch, "none.pem"))).toThrow(/missing/);
  });

  it("names every permission the App holds beyond or short of what it needs", async () => {
    expect(permissionDiff({ checks: "write", contents: "write", issues: "write", metadata: "read", pull_requests: "write" })).toEqual([]);
    expect(permissionDiff({ checks: "read", contents: "write", metadata: "read", pull_requests: "write", workflows: "write", administration: "read" })).toEqual([
      "administration is read, expected not granted",
      "checks is read, expected write",
      "issues is not granted, expected write",
      "workflows is write, expected not granted",
    ]);
    const fetchFn = (async () => Promise.resolve(new Response(JSON.stringify({ id: 4242, slug: "software-factory-x", permissions: { checks: "write" } }), { status: 200 }))) as typeof fetch;
    expect(await appInfo({ app, api: "https://api.example", fetchFn })).toEqual({ id: 4242, slug: "software-factory-x", permissions: { checks: "write" } });
  });
});
