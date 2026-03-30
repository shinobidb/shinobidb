import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PiiDetectionResult } from '../../detection/types.js';
import { applyDriftToConfig } from '../config-applier.js';
import type { DriftItem } from '../config-drift.js';

jest.mock('../../shared/logger.js', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), success: jest.fn() },
}));

function makeDetection(overrides: Partial<PiiDetectionResult> = {}): PiiDetectionResult {
  return {
    schema: 'public',
    table: 'users',
    column: 'phone',
    category: 'phone',
    confidence: 0.9,
    reasoning: 'column name match',
    suggestedMaskingStrategy: 'fake_phone',
    ...overrides,
  };
}

function makeDriftItem(overrides: Partial<DriftItem> = {}): DriftItem {
  return {
    type: 'new_pii_column',
    severity: 'warning',
    schema: 'public',
    table: 'users',
    column: 'phone',
    message: 'New PII column',
    detection: makeDetection(),
    ...overrides,
  };
}

const BASE_CONFIG = `version: "1"
source:
  type: mysql
  host: localhost
  port: 3306
  user: root
  password: ""
target:
  type: mysql
  host: staging
  port: 3306
  user: root
  password: ""
options:
  batchSize: 1000
  deterministic: true
  seed: test-seed
  truncateTarget: true
tables:
  - schema: public
    table: users
    columns:
      - name: email
        strategy: hash_email
`;

const CONFIG_WITH_COMMENT = `version: "1"
source:
  type: mysql
  host: localhost
  port: 3306
  user: root
  password: ""
target:
  type: mysql
  host: staging
  port: 3306
  user: root
  password: ""
options:
  batchSize: 1000
  deterministic: true
  seed: test-seed
  truncateTarget: true
tables:
  - schema: public
    table: users
    # This is a comment about user masking
    columns:
      - name: email
        strategy: hash_email
`;

const CONFIG_WITH_COPYONLY = `version: "1"
source:
  type: mysql
  host: localhost
  port: 3306
  user: root
  password: ""
target:
  type: mysql
  host: staging
  port: 3306
  user: root
  password: ""
options:
  batchSize: 1000
  deterministic: true
  seed: test-seed
  truncateTarget: true
tables:
  - schema: public
    table: users
    columns:
      - name: email
        strategy: hash_email
  - schema: public
    table: sessions
    copyOnly: true
`;

async function createTempConfig(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shinobidb-test-'));
  const path = join(dir, 'shinobidb.yaml');
  await writeFile(path, content, 'utf-8');
  return path;
}

describe('applyDriftToConfig', () => {
  it('should append a new table entry at end of tables array', async () => {
    const configPath = await createTempConfig(BASE_CONFIG);
    const items: DriftItem[] = [
      makeDriftItem({
        table: 'orders',
        column: 'customer_email',
        detection: makeDetection({
          table: 'orders',
          column: 'customer_email',
          category: 'email',
          suggestedMaskingStrategy: 'hash_email',
        }),
      }),
    ];

    const result = await applyDriftToConfig(configPath, items);

    expect(result.added).toBe(1);
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('table: orders');
    expect(content).toContain('name: customer_email');
    expect(content).toContain('strategy: hash_email');
    // Original content should still be there
    expect(content).toContain('table: users');
    expect(content).toContain('name: email');
  });

  it('should preserve existing YAML comments', async () => {
    const configPath = await createTempConfig(CONFIG_WITH_COMMENT);
    const items: DriftItem[] = [
      makeDriftItem({
        table: 'orders',
        column: 'phone',
        detection: makeDetection({ table: 'orders', column: 'phone' }),
      }),
    ];

    const result = await applyDriftToConfig(configPath, items);

    expect(result.added).toBe(1);
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('# This is a comment about user masking');
    expect(content).toContain('table: orders');
  });

  it('should add columns to copyOnly table and remove copyOnly flag', async () => {
    const configPath = await createTempConfig(CONFIG_WITH_COPYONLY);
    const items: DriftItem[] = [
      makeDriftItem({
        type: 'copyonly_has_pii',
        severity: 'critical',
        table: 'sessions',
        column: 'user_ip',
        detection: makeDetection({
          table: 'sessions',
          column: 'user_ip',
          category: 'ip_address',
          suggestedMaskingStrategy: 'hash_ip',
        }),
      }),
    ];

    const result = await applyDriftToConfig(configPath, items);

    expect(result.added).toBe(1);
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('name: user_ip');
    expect(content).toContain('strategy: hash_ip');
    expect(content).not.toContain('copyOnly: true');
    // Original users table should be unchanged
    expect(content).toContain('table: users');
  });

  it('should handle multiple new tables in single apply', async () => {
    const configPath = await createTempConfig(BASE_CONFIG);
    const items: DriftItem[] = [
      makeDriftItem({
        table: 'orders',
        column: 'customer_email',
        detection: makeDetection({
          table: 'orders',
          column: 'customer_email',
          suggestedMaskingStrategy: 'hash_email',
        }),
      }),
      makeDriftItem({
        table: 'payments',
        column: 'card_number',
        detection: makeDetection({
          table: 'payments',
          column: 'card_number',
          category: 'credit_card',
          suggestedMaskingStrategy: 'redact',
        }),
      }),
    ];

    const result = await applyDriftToConfig(configPath, items);

    expect(result.added).toBe(2);
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('table: orders');
    expect(content).toContain('table: payments');
    expect(content).toContain('name: card_number');
  });

  it('should return added=0 when no applicable items', async () => {
    const configPath = await createTempConfig(BASE_CONFIG);
    const items: DriftItem[] = [
      {
        type: 'column_not_in_db',
        severity: 'warning',
        schema: 'public',
        table: 'users',
        column: 'old_field',
        message: 'column gone',
      },
    ];

    const result = await applyDriftToConfig(configPath, items);

    expect(result.added).toBe(0);
    const content = await readFile(configPath, 'utf-8');
    expect(content).toBe(BASE_CONFIG);
  });

  it('should not modify the ignore section', async () => {
    const configWithIgnore = BASE_CONFIG + `ignore:\n  - public.logs.user_agent\n`;
    const configPath = await createTempConfig(configWithIgnore);
    const items: DriftItem[] = [
      makeDriftItem({
        table: 'orders',
        column: 'phone',
        detection: makeDetection({ table: 'orders', column: 'phone' }),
      }),
    ];

    const result = await applyDriftToConfig(configPath, items);

    expect(result.added).toBe(1);
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('ignore:');
    expect(content).toContain('public.logs.user_agent');
  });

  it('should match indentation of existing table entries', async () => {
    const configPath = await createTempConfig(BASE_CONFIG);
    const items: DriftItem[] = [
      makeDriftItem({
        table: 'orders',
        column: 'phone',
        detection: makeDetection({ table: 'orders', column: 'phone' }),
      }),
    ];

    await applyDriftToConfig(configPath, items);

    const content = await readFile(configPath, 'utf-8');
    // The existing entries use 2-space indent for "- schema:"
    const newTableMatch = /^( *)- schema: public\n\1  table: orders/m.exec(content);
    expect(newTableMatch).not.toBeNull();
    // Check indent matches original
    const originalMatch = /^( *)- schema: public\n\1  table: users/m.exec(content);
    expect(originalMatch).not.toBeNull();
    expect(newTableMatch![1]).toBe(originalMatch![1]);
  });
});
