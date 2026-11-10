import type { PermissionsConfig } from '../types.js';
import type { StoredPermissionRule } from '../state/types.js';
import type { SDKPermissionConfig } from './bridge.js';
import { SHELL_WRAPPERS } from './permission-patterns.js';

type RuntimeRules = NonNullable<SDKPermissionConfig['rules']>;
type RuntimeRule = RuntimeRules['approved'][number];

export interface RuntimePermissionPolicyInput {
  config: PermissionsConfig | undefined;
  /** Already ordered exactly as checkPermission would consult each tool's rules. */
  storedRules: readonly StoredPermissionRule[];
  workingDirectory: string;
  allowPaths: readonly string[];
  isAdmin: boolean;
}

const RESERVED_KINDS = new Set([
  'shell', 'read', 'write', 'url', 'memory', 'mcp', 'custom-tool', 'hook',
  'workflow', 'extension-management', 'extension-permission-access',
  'extension-env-access', 'commands', 'path',
]);
const SIMPLE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
// Deliberately excludes native :* metasyntax, globbing, quoting, and shell operators.
const SIMPLE_SHELL_PREFIX = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?: [A-Za-z0-9_./=-]+)*$/;

/**
 * Builds a conservative projection, not a complete replacement for bridge policy.
 *
 * The caller must merge this rule contribution with its OWN known baseline and
 * restore that baseline when leaving assisted mode. Native configure replaces
 * rules; SDK 1.0.31 has no getState/getRules snapshot API. An unknown baseline
 * must not be treated as empty.
 *
 * The owner-tool policy declaration keeps this connection's custom tools behind
 * its bridge permission handler during unattended assisted autopilot. It does
 * not restore callbacks for shell/file/URL requests.
 *
 * Paths and URLs are intentionally omitted: path eligibility is not the bridge's
 * path-scoped write approval, and these managers cannot be faithfully restored
 * from paths.list(). No escalation flags or managed policy are modified here.
 */
export function buildRuntimePermissionPolicy(input: RuntimePermissionPolicyInput): {
  config: SDKPermissionConfig;
  warnings: string[];
} {
  const warnings = new Set<string>();
  const approved: RuntimeRule[] = [];
  const denied: RuntimeRule[] = [];
  const configAllows: RuntimeRule[] = [];
  const unprojectedDenyKinds = new Set<string>();
  const warn = (message: string) => { warnings.add(message); };
  const add = (target: RuntimeRule[], rule: RuntimeRule) => {
    if (!target.some(existing => existing.kind === rule.kind && existing.argument === rule.argument)) {
      target.push(rule);
    }
  };

  warn('Hardcoded shell safety predicates are not native rules. The bridge guards built-in shell tools with a pre-tool hook; enforcement is not guaranteed for other runtime-owned tool forms.');
  warn('Workspace and allowPaths read/write autoapprovals are not projected: native path eligibility is not a path-scoped write grant. Existing native path policy is left unchanged.');
  if (input.config?.allowUrls?.length) {
    warn('Configured allowUrls are not projected because native domain/path matching equivalence is unverified. Existing native URL policy is left unchanged.');
  }
  if (input.isAdmin) {
    warn('Admin-only shell autoapprovals are not projected; runtime policy and safety review handle requests not delivered to the bridge.');
  }

  // Mirrors the small, private parsePermissionSpec in config.ts. In particular,
  // url(host) and read(path) are NOT functional path/domain rules in that parser.
  const parse = (spec: string): RuntimeRule | undefined => {
    const match = spec.match(/^([^(]+?)(?:\((.+)\))?$/);
    if (!match) return undefined;
    return { kind: match[1].trim(), argument: match[2]?.trim() ?? null };
  };
  const mapConfig = (spec: string): RuntimeRule | undefined => {
    const rule = parse(spec);
    if (!rule) return undefined;
    if (rule.kind === 'shell') {
      if (rule.argument === null) return rule;
      if (!SIMPLE_SHELL_PREFIX.test(rule.argument)) return undefined;
      return {
        kind: 'shell',
        argument: rule.argument.includes(' ') ? `${rule.argument}:*` : rule.argument,
      };
    }
    if (rule.kind === 'read' || rule.kind === 'write') {
      return rule.argument === null ? rule : undefined;
    }
    if (!SIMPLE_NAME.test(rule.kind) || RESERVED_KINDS.has(rule.kind.toLowerCase())) return undefined;
    if (rule.argument !== null && !SIMPLE_NAME.test(rule.argument)) return undefined;
    return rule; // An ordinary config kind is an exact MCP server name.
  };

  for (const spec of input.config?.deny ?? []) {
    const rule = mapConfig(spec);
    if (rule) add(denied, rule);
    else {
      const kind = parse(spec)?.kind;
      // Unknown syntax must not allow a projected grant to jump over a config
      // deny that the normal bridge callback would have considered first.
      unprojectedDenyKinds.add(kind ?? '*');
      warn(`Config deny ${JSON.stringify(spec)} was not projected; overlapping approvals are withheld rather than bypassing an unrepresentable restriction.`);
    }
  }
  const canApprove = (rule: RuntimeRule) =>
    !unprojectedDenyKinds.has('*') && !unprojectedDenyKinds.has(rule.kind) &&
    !(unprojectedDenyKinds.has('mcp') && !RESERVED_KINDS.has(rule.kind));

  for (const spec of input.config?.allow ?? []) {
    const rule = mapConfig(spec);
    if (!rule) {
      warn(`Config allow ${JSON.stringify(spec)} was not projected because its native meaning is not verified.`);
      continue;
    }
    // Keep even withheld config allows for precedence against stored denies.
    configAllows.push(rule);
    if (canApprove(rule)) add(approved, rule);
    else warn(`Config allow ${JSON.stringify(spec)} was withheld because an overlapping config deny could not be projected.`);
  }

  const byTool = new Map<string, StoredPermissionRule[]>();
  for (const rule of input.storedRules) {
    const group = byTool.get(rule.tool) ?? [];
    group.push(rule);
    byTool.set(rule.tool, group);
  }
  const emitStored = (rule: RuntimeRule, action: 'allow' | 'deny', label: string) => {
    if (action === 'allow') {
      if (canApprove(rule)) add(approved, rule);
      else warn(`${label} was withheld because an overlapping config deny could not be projected.`);
    } else if (configAllows.some(allow => overlaps(allow, rule))) {
      // Config approval wins before SQLite is queried. Native deny-wins cannot
      // express an exception to a broader remembered deny, so do not invert it.
      warn(`${label} was not projected because config approval has priority over the overlapping stored deny.`);
    } else {
      add(denied, rule);
    }
  };

  for (const [tool, rules] of byTool) {
    if (tool.startsWith('mcp:')) {
      const server = tool.slice(4);
      if (!SIMPLE_NAME.test(server) || RESERVED_KINDS.has(server.toLowerCase())) {
        warn(`Stored MCP rules for ${JSON.stringify(server)} were not projected: the server name is unsupported or collides with native permission kinds.`);
        continue;
      }
      // The bridge asks checkPermission(mcp:server, '*'), not the tool name.
      const effective = rules.find(rule => rule.commandPattern === '*');
      if (effective) emitStored({ kind: server, argument: null }, effective.action, `Stored MCP ${effective.action} for ${JSON.stringify(server)}`);
      if (rules.some(rule => rule.commandPattern !== '*')) {
        warn(`Non-wildcard stored MCP rules for ${JSON.stringify(server)} were not projected: bridge server-level lookup only queries "*".`);
      }
      continue;
    }
    if (tool !== 'shell' && tool !== 'read' && tool !== 'write') {
      warn(`Stored rules for tool ${JSON.stringify(tool)} were not projected; tool names must not be reinterpreted as permission kinds or MCP servers.`);
      continue;
    }

    const patterns = [...new Set(rules.map(rule => rule.commandPattern).filter(pattern => pattern !== '*'))];
    const effective = (pattern: string) => rules.find(rule => rule.commandPattern === '*' || rule.commandPattern === pattern)!;
    const wildcard = rules.find(rule => rule.commandPattern === '*');
    const exceptions = wildcard ? patterns.filter(pattern => effective(pattern).action !== wildcard.action) : [];

    if (wildcard) {
      if (exceptions.length) {
        warn(`Stored ${tool} wildcard ${wildcard.action} was not projected: ordered exact-rule exceptions cannot be represented by native deny-wins rules.`);
      } else if (tool === 'shell' && wildcard.action === 'allow') {
        warn('Stored shell wildcard allow was not projected: native blanket approval would also approve wrappers excluded by the bridge.');
      } else if (tool !== 'shell' && wildcard.action === 'deny') {
        warn(`Stored ${tool} wildcard deny was not projected: it must not override earlier workspace/allowPaths approval.`);
      } else {
        emitStored({ kind: tool, argument: null }, wildcard.action, `Stored ${tool} wildcard ${wildcard.action}`);
      }
    }

    for (const pattern of patterns) {
      const winner = effective(pattern);
      // A projected homogeneous wildcard already includes these exact entries.
      if (wildcard && !exceptions.length && !(tool === 'shell' && wildcard.action === 'allow')) continue;
      if (tool !== 'shell' || !SIMPLE_NAME.test(pattern)) {
        warn(`Stored ${tool} pattern ${JSON.stringify(pattern)} was not projected: exact bridge tokens are not native prefix/glob/path rules.`);
        continue;
      }
      if (winner.action === 'allow' && SHELL_WRAPPERS.has(pattern)) {
        warn(`Stored shell allow for wrapper ${JSON.stringify(pattern)} was not projected because the bridge excludes wrapper autoapproval.`);
        continue;
      }
      emitStored({ kind: 'shell', argument: pattern }, winner.action, `Stored shell ${winner.action} for ${JSON.stringify(pattern)}`);
    }
  }

  if ([...approved, ...denied].some(rule => rule.kind === 'shell')) {
    warn('Projected shell rules use native parsed command segments, not the bridge’s simple splitter; compound commands, quoting, and executable-path forms can differ.');
  }
  return {
    config: { rules: { approved, denied }, hostPolicyPermissionHandler: true },
    warnings: [...warnings],
  };
}

/** Conservative overlap detection: false positives withhold rather than broaden. */
function overlaps(left: RuntimeRule, right: RuntimeRule): boolean {
  if (left.kind !== right.kind) return false;
  if (left.argument === null || right.argument === null) return true;
  if (left.kind === 'shell') {
    return left.argument.split(/[ :]/)[0] === right.argument.split(/[ :]/)[0];
  }
  return left.argument === right.argument;
}
