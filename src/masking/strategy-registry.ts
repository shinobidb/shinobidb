import { MaskingError } from '../shared/errors.js';

import { FakeAddressStrategy } from './strategies/fake-address.js';
import {
  FakeNameStrategy,
  FakeFirstNameStrategy,
  FakeLastNameStrategy,
} from './strategies/fake-name.js';
import { FakePhoneStrategy } from './strategies/fake-phone.js';
import { HashEmailStrategy } from './strategies/hash-email.js';
import { HashIpStrategy } from './strategies/hash-ip.js';
import { RandomDateStrategy } from './strategies/random-date.js';
import { RedactStrategy } from './strategies/redact.js';
import type { MaskingStrategy } from './types.js';

export class StrategyRegistry {
  private strategies = new Map<string, MaskingStrategy>();

  register(strategy: MaskingStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  get(name: string): MaskingStrategy {
    const strategy = this.strategies.get(name);
    if (!strategy) {
      throw new MaskingError(`Unknown masking strategy: "${name}"`);
    }
    return strategy;
  }

  has(name: string): boolean {
    return this.strategies.has(name);
  }

  getAll(): MaskingStrategy[] {
    return Array.from(this.strategies.values());
  }
}

export function createDefaultRegistry(): StrategyRegistry {
  const registry = new StrategyRegistry();

  registry.register(new HashEmailStrategy());
  registry.register(new FakeNameStrategy());
  registry.register(new FakeFirstNameStrategy());
  registry.register(new FakeLastNameStrategy());
  registry.register(new FakePhoneStrategy());
  registry.register(new FakeAddressStrategy());
  registry.register(new RedactStrategy());
  registry.register(new RandomDateStrategy());
  registry.register(new HashIpStrategy());

  return registry;
}
