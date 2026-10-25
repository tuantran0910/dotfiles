import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createClassifier, type ClassifierContext, type ClassifyFn } from "./classifier.ts";
import { createJevClassifier } from "./jev.ts";
import type { ClassifierConfig } from "./types.ts";

interface ClassifierRuntime {
  model?: typeof createClassifier;
  jev?: typeof createJevClassifier;
  /** Reserve another provider attempt against the hook's session budget. */
  reserveFallback?: () => boolean;
}

export function createGuardClassifier(pi: ExtensionAPI, ctx: ClassifierContext, config: ClassifierConfig, runtime: ClassifierRuntime = {}): ClassifyFn {
  const modelFactory = runtime.model ?? createClassifier;
  if (config.backend !== "opencode-jev") return modelFactory(pi, ctx, config);
  if (!config.fallbackModel) return (runtime.jev ?? createJevClassifier)(pi, ctx, config);

  return async (call, intent, signal) => {
    const deadline = performance.now() + config.timeoutMs;
    // Reserve time for the fallback while retaining one overall deadline.
    const primary = (runtime.jev ?? createJevClassifier)(pi, ctx, { ...config, timeoutMs: Math.min(3000, config.timeoutMs / 2) });
    const verdict = await primary(call, intent, signal).catch(() => null);
    // A real denial or prompt is authoritative; never shop for an easier answer.
    if (verdict !== null) return verdict;
    const remaining = Math.floor(deadline - performance.now());
    if (signal?.aborted || remaining <= 0 || runtime.reserveFallback?.() === false) return null;
    pi.logger.warn(`tool-gate: Jev unavailable; falling back to ${config.fallbackModel}`);
    const fallback = modelFactory(pi, ctx, { ...config, backend: "model", model: config.fallbackModel!, fallbackModel: undefined, timeoutMs: remaining });
    return fallback(call, intent, signal);
  };
}
