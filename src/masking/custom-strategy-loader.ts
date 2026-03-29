import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ConfigValidationError, MaskingError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

import type { StrategyRegistry } from './strategy-registry.js';
import type { MaskingStrategy } from './types.js';

function isValidStrategy(obj: unknown): obj is MaskingStrategy {
  if (obj === null || typeof obj !== 'object') return false;
  const s = obj as Record<string, unknown>;
  return typeof s.name === 'string' && s.name.length > 0 && typeof s.mask === 'function';
}

export function extractStrategies(module: Record<string, unknown>): MaskingStrategy[] {
  const strategies: MaskingStrategy[] = [];

  // default export can be a single strategy or an array
  if (module.default !== undefined) {
    if (Array.isArray(module.default)) {
      for (const item of module.default) {
        if (isValidStrategy(item)) {
          strategies.push(item);
        }
      }
    } else if (isValidStrategy(module.default)) {
      strategies.push(module.default);
    }
  }

  // named exports
  for (const [key, value] of Object.entries(module)) {
    if (key === 'default') continue;
    if (isValidStrategy(value)) {
      // Avoid duplicates if same object exported as both default and named
      if (!strategies.some((s) => s.name === (value as MaskingStrategy).name)) {
        strategies.push(value);
      }
    }
  }

  return strategies;
}

export async function loadCustomStrategies(
  paths: string[],
  registry: StrategyRegistry,
  basePath: string = process.cwd(),
): Promise<void> {
  for (const filePath of paths) {
    const absolutePath = resolve(basePath, filePath);

    if (!existsSync(absolutePath)) {
      throw new ConfigValidationError(
        `Custom strategy file not found: "${filePath}" (resolved to "${absolutePath}")`,
      );
    }

    let module: Record<string, unknown>;
    try {
      module = (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
    } catch (err) {
      throw new MaskingError(`Failed to load custom strategy file: "${filePath}"`, err);
    }

    const strategies = extractStrategies(module);

    if (strategies.length === 0) {
      throw new ConfigValidationError(
        `Custom strategy file "${filePath}" does not export any valid MaskingStrategy. ` +
          'Each export must have a "name" (string) and "mask" (function) property.',
      );
    }

    for (const strategy of strategies) {
      if (registry.has(strategy.name)) {
        throw new ConfigValidationError(
          `Custom strategy "${strategy.name}" from "${filePath}" conflicts with an existing strategy`,
        );
      }
      registry.register(strategy);
      logger.info(`Registered custom strategy: "${strategy.name}" from "${filePath}"`);
    }
  }
}
