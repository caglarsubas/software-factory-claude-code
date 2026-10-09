// Which gates run, in which order, for a target profile. Scanners and rule packs that feed
// the policy engine's risk signals always run: a profile can add rule packs, never drop one.
export type Adapter = "typescript" | "python";

export interface AdapterSpec {
  /** OSV ecosystem whose offline database the dependency audit needs. */
  osvEcosystem: "npm" | "PyPI";
  /** Lockfile basenames this ecosystem's dependency audit reads. */
  lockfiles: RegExp;
  /** Setup has network access, so lifecycle scripts and source builds are off. */
  setupEnv: Readonly<Record<string, string>>;
  /** Command gates run with no network; tools must not try to reach one. */
  offlineEnv: Readonly<Record<string, string>>;
}

export const ADAPTERS: Readonly<Record<Adapter, AdapterSpec>> = {
  typescript: {
    osvEcosystem: "npm",
    lockfiles: /^(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lock)$/,
    // pnpm 11+ reads only pnpm_config_*; npm and yarn have their own switches.
    setupEnv: {
      pnpm_config_ignore_scripts: "true",
      npm_config_ignore_scripts: "true",
      YARN_ENABLE_SCRIPTS: "false",
      pnpm_config_update_notifier: "false",
      npm_config_update_notifier: "false",
    },
    offlineEnv: {
      COREPACK_ENABLE_NETWORK: "0",
      pnpm_config_offline: "true",
      npm_config_offline: "true",
      pnpm_config_update_notifier: "false",
      npm_config_update_notifier: "false",
    },
  },
  python: {
    osvEcosystem: "PyPI",
    lockfiles: /^(uv\.lock|poetry\.lock|pdm\.lock|Pipfile\.lock|requirements[\w.-]*\.txt)$/,
    // No source builds while the network is up: a build backend runs project code.
    setupEnv: { UV_NO_BUILD: "1", PIP_ONLY_BINARY: ":all:" },
    // The shared cache is mounted read-only for command gates; uv needs a writable one.
    offlineEnv: { UV_OFFLINE: "1", UV_PYTHON_DOWNLOADS: "never", UV_CACHE_DIR: "/tmp/uv-cache", PIP_NO_INDEX: "1" },
  },
};

/** Self-authored opengrep packs in gates/rules/. */
export const RULE_PACKS = { default: "default.yaml", sink_added: "sink-added.yaml" } as const;
export type RulePack = keyof typeof RULE_PACKS;
const ALWAYS_ON: readonly RulePack[] = ["default", "sink_added"];

export interface GateProfile {
  commands: { setup?: string; build?: string; typecheck?: string; lint?: string; test: string };
  gates: { adapters: string[]; sast_rules?: string[] };
  invariants?: { id: string; text: string; check?: string }[];
}

export interface CommandGate {
  name: string;
  command: string;
}

export interface GatePlan {
  adapters: Adapter[];
  setup: string | null;
  /** build, typecheck, lint, test, then each invariant with a check, in that order. */
  commands: CommandGate[];
  rulePacks: RulePack[];
}

const COMMAND_ORDER = ["build", "typecheck", "lint", "test"] as const;
const GATE_NAME = /^[a-z][a-z0-9-]*$/;

const isAdapter = (a: string): a is Adapter => Object.hasOwn(ADAPTERS, a);
const isRulePack = (p: string): p is RulePack => Object.hasOwn(RULE_PACKS, p);

export function planGates(profile: GateProfile): GatePlan {
  const adapters: Adapter[] = [];
  for (const a of profile.gates.adapters) {
    if (!isAdapter(a)) throw new Error(`unknown gate adapter "${a}"`);
    if (!adapters.includes(a)) adapters.push(a);
  }
  if (adapters.length === 0) throw new Error("the profile names no gate adapter");

  const packs = new Set<RulePack>(ALWAYS_ON);
  for (const p of profile.gates.sast_rules ?? []) {
    if (!isRulePack(p)) throw new Error(`unknown SAST rule pack "${p}"`);
    packs.add(p);
  }

  const commands: CommandGate[] = [];
  for (const name of COMMAND_ORDER) {
    const command = profile.commands[name];
    if (command !== undefined) commands.push({ name, command });
  }
  for (const inv of profile.invariants ?? []) {
    if (inv.check === undefined) continue;
    const name = `invariant-${inv.id.toLowerCase()}`;
    if (!GATE_NAME.test(name)) throw new Error(`invariant id "${inv.id}" does not make a valid gate name`);
    commands.push({ name, command: inv.check });
  }

  return { adapters, setup: profile.commands.setup ?? null, commands, rulePacks: [...packs].sort() };
}

/** Environment for one phase: the union over the plan's adapters. */
export function phaseEnv(plan: GatePlan, phase: "setupEnv" | "offlineEnv"): Record<string, string> {
  return Object.assign({}, ...plan.adapters.map((a) => ADAPTERS[a][phase])) as Record<string, string>;
}

export function isLockfile(plan: GatePlan, path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return plan.adapters.some((a) => ADAPTERS[a].lockfiles.test(base));
}
