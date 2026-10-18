// The factory's GitHub App (P2-05): factoryctl signs a short-lived JWT with the App's private
// key and trades it for an installation token, which pushes, opens PRs and posts the
// factory/verdict check run. The key never leaves $FACTORY_HOME/secrets and never reaches a
// session; installation tokens last an hour and are refreshed well before that.
import { createSign } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Home } from "../home.ts";
import { GitHubError } from "./client.ts";

export interface AppConfig {
  appId: number;
  installationId: number;
  keyFile: string;
}

/** What the App must be granted, exactly (ROADMAP §3.2): no workflows, no administration. */
export const APP_PERMISSIONS: Readonly<Record<string, string>> = { checks: "write", contents: "write", metadata: "read", pull_requests: "write" };

export class AppConfigError extends Error {}

const positive = (v: unknown, what: string): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^[0-9]+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppConfigError(`${what} must be a positive integer`);
  return n;
};

export const appConfigPath = (home: Home): string => join(home.root, "github-app.json");

/**
 * The App to act as, or null when none is set: FACTORY_GITHUB_APP_ID and
 * FACTORY_GITHUB_APP_INSTALLATION_ID, else $FACTORY_HOME/github-app.json. Neither ID is a secret;
 * the key is, and stays in $FACTORY_HOME/secrets/github-app.pem (or FACTORY_GITHUB_APP_KEY_FILE).
 */
export function appConfig(home: Home, env: NodeJS.ProcessEnv = process.env): AppConfig | null {
  const keyFile = env["FACTORY_GITHUB_APP_KEY_FILE"] ?? join(home.secrets, "github-app.pem");
  if (env["FACTORY_GITHUB_APP_ID"] !== undefined || env["FACTORY_GITHUB_APP_INSTALLATION_ID"] !== undefined) {
    return { appId: positive(env["FACTORY_GITHUB_APP_ID"], "FACTORY_GITHUB_APP_ID"), installationId: positive(env["FACTORY_GITHUB_APP_INSTALLATION_ID"], "FACTORY_GITHUB_APP_INSTALLATION_ID"), keyFile };
  }
  const path = appConfigPath(home);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new AppConfigError(`${path} is not JSON`);
  }
  const c = raw as { app_id?: unknown; installation_id?: unknown };
  return { appId: positive(c.app_id, `${path}: app_id`), installationId: positive(c.installation_id, `${path}: installation_id`), keyFile };
}

/** The key, refused unless only its owner can read it. */
export function readAppKey(keyFile: string): string {
  if (!existsSync(keyFile)) throw new AppConfigError(`the App's private key is missing: ${keyFile}`);
  if ((statSync(keyFile).mode & 0o077) !== 0) throw new AppConfigError(`${keyFile} must be readable by you only (chmod 600)`);
  return readFileSync(keyFile, "utf8");
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/** An App JWT (RS256), valid from a minute ago, for nine minutes: GitHub allows at most ten. */
export function appJwt(appId: number, key: string, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat, exp: iat + 600, iss: String(appId) }))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key);
  return `${unsigned}.${b64url(signature)}`;
}

async function appCall(o: { app: AppConfig; api: string; fetchFn: typeof fetch; now: () => number }, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await o.fetchFn(`${o.api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${appJwt(o.app.appId, readAppKey(o.app.keyFile), o.now())}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new GitHubError(`${method} ${path}: HTTP ${String(res.status)}`);
  return res.json();
}

export interface InstallationToken {
  token: string;
  expiresAt: number;
  permissions: Record<string, string>;
}

export interface AppTokens {
  /** A token valid for at least the next refresh margin; minted again when older. */
  token(): Promise<string>;
  /** The token held now, for synchronous callers (git); call token() or refresh() first. */
  current(): string;
  refresh(): Promise<InstallationToken>;
}

/** Re-minted when less than this is left: a push or an API call never starts on a token about to lapse. */
const MARGIN_MS = 30 * 60_000;

/**
 * Installation tokens for the App, narrowed to `repositories` (names in the installation's owner)
 * when given: a run's token reaches only its own target.
 */
export function appTokens(o: { app: AppConfig; api?: string; fetchFn?: typeof fetch; now?: () => number; repositories?: string[] }): AppTokens {
  const ctx = { app: o.app, api: o.api ?? "https://api.github.com", fetchFn: o.fetchFn ?? fetch, now: o.now ?? Date.now };
  let held: InstallationToken | null = null;
  const refresh = async (): Promise<InstallationToken> => {
    const body = (await appCall(ctx, "POST", `/app/installations/${String(o.app.installationId)}/access_tokens`, o.repositories === undefined ? undefined : { repositories: o.repositories })) as { token: string; expires_at: string; permissions?: Record<string, string> };
    held = { token: body.token, expiresAt: Date.parse(body.expires_at), permissions: body.permissions ?? {} };
    return held;
  };
  return {
    async token() {
      const t = held !== null && held.expiresAt - ctx.now() >= MARGIN_MS ? held : await refresh();
      return t.token;
    },
    current() {
      if (held === null) throw new GitHubError("no installation token yet: call token() or refresh() first");
      return held.token;
    },
    refresh,
  };
}

export interface AppInfo {
  id: number;
  slug: string;
  permissions: Record<string, string>;
}

/** The App as GitHub describes it, with the permissions it was granted. */
export async function appInfo(o: { app: AppConfig; api?: string; fetchFn?: typeof fetch; now?: () => number }): Promise<AppInfo> {
  const body = (await appCall({ app: o.app, api: o.api ?? "https://api.github.com", fetchFn: o.fetchFn ?? fetch, now: o.now ?? Date.now }, "GET", "/app")) as { id: number; slug: string; permissions?: Record<string, string> };
  return { id: body.id, slug: body.slug, permissions: body.permissions ?? {} };
}

/** Every difference between what the App holds and APP_PERMISSIONS: more is as wrong as less. */
export function permissionDiff(granted: Readonly<Record<string, string>>): string[] {
  const diffs: string[] = [];
  for (const [k, v] of Object.entries(APP_PERMISSIONS)) if (granted[k] !== v) diffs.push(`${k} is ${granted[k] ?? "not granted"}, expected ${v}`);
  for (const [k, v] of Object.entries(granted)) if (!(k in APP_PERMISSIONS)) diffs.push(`${k} is ${v}, expected not granted`);
  return diffs.sort();
}
