import { createLogger } from '../logger.js';

const log = createLogger('model-fallback');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedModel {
  provider: string;   // 'claude' | 'gpt' | 'gemini' | 'o' | unknown
  family: string;     // 'opus' | 'sonnet' | 'haiku' | '' (for gpt) | 'codex' | 'pro' etc.
  version: string;    // '4.6' | '5.1' etc.
  variant?: string;   // '1m' | 'max' | 'mini' | 'preview' etc.
  raw: string;        // original model ID
}

// ---------------------------------------------------------------------------
// Static fallback map — explicit chains for known models
// ---------------------------------------------------------------------------

/**
 * Ordered fallback chains for known model IDs.
 * Each entry maps a model to its preferred fallbacks (best alternative first).
 * Only includes models where the automatic parser might not produce ideal results.
 */
const STATIC_FALLBACK_MAP: Record<string, string[]> = {
  // Claude Opus family
  'claude-opus-4.6':       ['claude-opus-4.5', 'claude-sonnet-4.6', 'claude-sonnet-4.5'],
  'claude-opus-4.5':       ['claude-opus-4.6', 'claude-sonnet-4.6', 'claude-sonnet-4.5'],

  // Claude Sonnet family
  'claude-sonnet-4.6':     ['claude-sonnet-4.5', 'claude-haiku-4.5'],
  'claude-sonnet-4.5':     ['claude-sonnet-4.6', 'claude-haiku-4.5'],

  // Claude Haiku — cheapest Claude, fall through to sonnet
  'claude-haiku-4.5':      ['claude-sonnet-4.5', 'claude-sonnet-4.6'],

  // GPT main family
  'gpt-5.4':               ['gpt-5.2', 'gpt-5.1'],
  'gpt-5.2':               ['gpt-5.1', 'gpt-5.4'],
  'gpt-5.1':               ['gpt-5.2', 'gpt-5.4'],
  'gpt-5-mini':            ['gpt-5.1', 'gpt-5.2'],

  // GPT Codex family
  'gpt-5.3-codex':         ['gpt-5.2-codex', 'gpt-5.1-codex-max'],
  'gpt-5.2-codex':         ['gpt-5.1-codex-max', 'gpt-5.3-codex'],
  'gpt-5.1-codex-max':     ['gpt-5.2-codex', 'gpt-5.3-codex'],

  // GPT-4.1 (older)
  'gpt-4.1':               ['gpt-5-mini', 'gpt-5.1'],

  // o-series (reasoning models)
  'o3':                     ['o4-mini', 'gpt-5.4'],
  'o4-mini':                ['o3', 'gpt-5-mini'],
};

// ---------------------------------------------------------------------------
// Model ID parser
// ---------------------------------------------------------------------------

/**
 * Parse a model ID into its component parts.
 *
 * Known patterns:
 * - `claude-{family}-{version}[-{variant}]`   e.g. claude-opus-4.6, claude-sonnet-4.5
 * - `gpt-{version}[-{family}][-{variant}]`    e.g. gpt-5.4, gpt-5.3-codex, gpt-5.1-codex-max
 * - `gemini-{version}-{family}[-{variant}]`   e.g. gemini-2.5-pro
 * - `o{version}[-{variant}]`                  e.g. o3, o4-mini
 */
export function parseModelId(id: string): ParsedModel {
  const lower = id.toLowerCase();

  // Claude: claude-{family}-{version}[-variant]
  const claudeMatch = lower.match(/^claude-(\w+)-(\d+(?:\.\d+)?)(?:-(.+))?$/);
  if (claudeMatch) {
    return {
      provider: 'claude',
      family: claudeMatch[1],
      version: claudeMatch[2],
      variant: claudeMatch[3],
      raw: id,
    };
  }

  // GPT: gpt-{version}[-family][-variant]
  // e.g. gpt-5.4, gpt-5.3-codex, gpt-5.1-codex-max, gpt-5-mini, gpt-4.1
  const gptMatch = lower.match(/^gpt-(\d+(?:\.\d+)?)(?:-(\w+))?(?:-(\w+))?$/);
  if (gptMatch) {
    const version = gptMatch[1];
    const second = gptMatch[2]; // could be family (codex) or variant (mini)
    const third = gptMatch[3]; // variant if second is family

    // Distinguish: "gpt-5-mini" (family='', variant='mini') vs "gpt-5.3-codex" (family='codex')
    const knownFamilies = ['codex'];
    let family = '';
    let variant: string | undefined;

    if (second && knownFamilies.includes(second)) {
      family = second;
      variant = third;
    } else if (second) {
      variant = third ? `${second}-${third}` : second;
    }

    return { provider: 'gpt', family, version, variant, raw: id };
  }

  // Gemini: gemini-{version}-{family}[-variant]
  const geminiMatch = lower.match(/^gemini-(\d+(?:\.\d+)?)-(\w+)(?:-(.+))?$/);
  if (geminiMatch) {
    return {
      provider: 'gemini',
      family: geminiMatch[2],
      version: geminiMatch[1],
      variant: geminiMatch[3],
      raw: id,
    };
  }

  // o-series: o{version}[-variant]
  const oMatch = lower.match(/^o(\d+)(?:-(.+))?$/);
  if (oMatch) {
    return {
      provider: 'o',
      family: '',
      version: oMatch[1],
      variant: oMatch[2],
      raw: id,
    };
  }

  // Unknown model — best-effort parse
  return { provider: 'unknown', family: '', version: '', raw: id };
}

// ---------------------------------------------------------------------------
// Generic fallback strategy
// ---------------------------------------------------------------------------

/** Compare two version strings segment by segment (e.g. "4.10" > "4.9"). */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Build a generic fallback chain for a model based on parsed fields.
 * Finds models from the same provider+family, sorted by descending version,
 * excluding the original model.
 */
function buildGenericFallback(parsed: ParsedModel, availableModels: string[]): string[] {
  if (parsed.provider === 'unknown') return [];

  const candidates: Array<{ id: string; parsed: ParsedModel }> = [];
  for (const id of availableModels) {
    if (id === parsed.raw) continue;
    const p = parseModelId(id);
    if (p.provider === parsed.provider && p.family === parsed.family) {
      candidates.push({ id, parsed: p });
    }
  }

  // Sort by version descending (prefer higher versions as they're more capable)
  candidates.sort((a, b) => {
    const cmp = compareVersions(b.parsed.version, a.parsed.version);
    if (cmp !== 0) return cmp;
    // Prefer no-variant over variant (base model over specialized)
    if (!a.parsed.variant && b.parsed.variant) return -1;
    if (a.parsed.variant && !b.parsed.variant) return 1;
    return 0;
  });

  return candidates.map(c => c.id);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get an ordered fallback chain for a model, filtered to only available models.
 *
 * Strategy:
 * 1. Check static fallback map for explicit chain
 * 2. Filter to models that are actually available
 * 3. Append generic same-provider+family fallbacks not already in the static chain
 * 4. Deduplicate while preserving order
 */
export function getFallbackChain(modelId: string, availableModels: string[]): string[] {
  const availableSet = new Set(availableModels);
  const seen = new Set<string>();
  const chain: string[] = [];

  const addIfAvailable = (id: string) => {
    if (id !== modelId && availableSet.has(id) && !seen.has(id)) {
      seen.add(id);
      chain.push(id);
    }
  };

  // Static fallbacks first (explicit, curated order)
  const staticChain = STATIC_FALLBACK_MAP[modelId];
  if (staticChain) {
    for (const id of staticChain) addIfAvailable(id);
  }

  // Generic fallbacks for anything not already covered
  const parsed = parseModelId(modelId);
  const generic = buildGenericFallback(parsed, availableModels);
  for (const id of generic) addIfAvailable(id);

  return chain;
}

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

/** Patterns in error messages that indicate a model-specific (capacity/availability) issue. */
const MODEL_ERROR_PATTERNS = [
  /model.*capacity/i,
  /model.*(overloaded|over\s*loaded)/i,
  /model.*(not\s+found|not\s+available|unavailable|does\s+not\s+exist|not\s+supported)/i,
  /rate\s*limit/i,
  /too\s+many\s+requests/i,
  /resource\s+exhausted/i,
  /model.*temporarily\s+unavailable/i,
  /quota\s+exceeded/i,
  /model\s+is\s+(currently\s+)?(unavailable|overloaded|at\s+capacity)/i,
];

/** HTTP status codes that typically indicate model-level issues. */
const MODEL_ERROR_CODES = new Set([429, 503]);

/**
 * Detect whether an error is model-specific (capacity, not found, rate limit)
 * rather than a general infrastructure or auth error.
 */
export function isModelError(error: any): boolean {
  if (!error) return false;

  // Check HTTP status codes
  const status = error.status ?? error.statusCode;
  if (typeof status === 'number' && MODEL_ERROR_CODES.has(status)) {
    return true;
  }
  // Some HTTP libraries store status as a string code — try parsing
  const code = error.code;
  if (typeof code === 'number' && MODEL_ERROR_CODES.has(code)) {
    return true;
  }

  // Check error message patterns
  const message = String(error.message ?? error.reason ?? error ?? '');
  return MODEL_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Build a merged fallback chain from config overrides and auto-detected fallbacks.
 * Config fallbacks take priority; auto-detected ones fill in any gaps.
 * When availableModels is empty (e.g., listModels() failed), config fallbacks
 * are included unfiltered so they still get attempted.
 */
export function buildFallbackChain(
  primaryModel: string,
  availableModels: string[],
  configFallbacks?: string[],
): string[] {
  const hasAvailability = availableModels.length > 0;
  const availableSet = new Set(availableModels);
  const autoChain = hasAvailability ? getFallbackChain(primaryModel, availableModels) : [];

  if (configFallbacks && configFallbacks.length > 0) {
    const configSet = new Set(configFallbacks);
    const filtered = hasAvailability
      ? configFallbacks.filter(m => m !== primaryModel && availableSet.has(m))
      : configFallbacks.filter(m => m !== primaryModel);
    return [
      ...filtered,
      ...autoChain.filter(m => !configSet.has(m)),
    ];
  }
  return autoChain;
}

/**
 * Attempt an action with automatic model fallback.
 *
 * Tries the primary model first. If a model-specific error occurs, tries each
 * fallback model in order. Returns the result and the model that succeeded.
 *
 * @param primaryModel - The preferred model ID
 * @param availableModels - All models available from listModels()
 * @param configFallbacks - Optional explicit fallback list from user config
 * @param action - Async action to attempt; receives the model ID to use
 * @returns Object with the action result and the model that worked
 */
export async function tryWithFallback<T>(
  primaryModel: string,
  availableModels: string[],
  configFallbacks: string[] | undefined,
  action: (model: string) => Promise<T>,
): Promise<{ result: T; usedModel: string; didFallback: boolean }> {
  // Try primary model first
  try {
    const result = await action(primaryModel);
    return { result, usedModel: primaryModel, didFallback: false };
  } catch (err: any) {
    if (!isModelError(err)) {
      throw err; // Not a model error — don't try fallbacks
    }
    log.warn(`Model "${primaryModel}" failed: ${err.message ?? err}. Trying fallbacks...`);

    const chain = buildFallbackChain(primaryModel, availableModels, configFallbacks);

    if (chain.length === 0) {
      log.error(`No fallback models available for "${primaryModel}"`);
      throw err;
    }

    log.info(`Fallback chain for "${primaryModel}": ${chain.join(' → ')}`);

    // Try each fallback
    let lastError = err;
    for (const fallbackModel of chain) {
      try {
        log.info(`Trying fallback model "${fallbackModel}"...`);
        const result = await action(fallbackModel);
        log.info(`Fallback to "${fallbackModel}" succeeded`);
        return { result, usedModel: fallbackModel, didFallback: true };
      } catch (fallbackErr: any) {
        log.warn(`Fallback model "${fallbackModel}" also failed: ${fallbackErr.message ?? fallbackErr}`);
        lastError = fallbackErr;
      }
    }

    log.error(`All fallback models exhausted for "${primaryModel}"`);
    throw lastError;
  }
}
