import type { TableInfo } from '../../db/types.js';
import { ColumnNameDetector } from '../detectors/column-name-detector.js';

function makeTable(
  columns: Array<{
    name: string;
    dataType?: string;
    isPrimaryKey?: boolean;
    isForeignKey?: boolean;
  }>,
  tableName = 'users',
  schema = 'test_db',
): TableInfo {
  return {
    schema,
    name: tableName,
    columns: columns.map((c) => ({
      name: c.name,
      dataType: c.dataType ?? 'varchar',
      nullable: true,
      isPrimaryKey: c.isPrimaryKey ?? false,
      isForeignKey: c.isForeignKey ?? false,
      defaultValue: null,
      comment: null,
    })),
    foreignKeys: [],
    estimatedRowCount: 100,
  };
}

describe('ColumnNameDetector', () => {
  let detector: ColumnNameDetector;

  beforeEach(() => {
    detector = new ColumnNameDetector();
  });

  describe('email detection', () => {
    it.each(['email', 'Email', 'e_mail', 'email_address', 'user_email'])(
      'should detect "%s" as email',
      async (columnName) => {
        const tables = [makeTable([{ name: columnName }])];
        const results = await detector.detect(tables);
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe('email');
        expect(results[0]!.confidence).toBeGreaterThanOrEqual(0.9);
      },
    );
  });

  describe('name detection', () => {
    it.each(['full_name', 'display_name', 'username', 'customer_name'])(
      'should detect "%s" as name',
      async (columnName) => {
        const results = await detector.detect([makeTable([{ name: columnName }])]);
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe('name');
      },
    );

    it('should detect bare "name" with lower confidence', async () => {
      const results = await detector.detect([makeTable([{ name: 'name' }])]);
      expect(results).toHaveLength(1);
      expect(results[0]!.category).toBe('name');
      expect(results[0]!.confidence).toBeLessThan(0.9);
    });

    it.each(['first_name', 'firstname', 'given_name', 'fname'])(
      'should detect "%s" as first_name',
      async (columnName) => {
        const results = await detector.detect([makeTable([{ name: columnName }])]);
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe('first_name');
      },
    );

    it.each(['last_name', 'lastname', 'family_name', 'surname', 'lname'])(
      'should detect "%s" as last_name',
      async (columnName) => {
        const results = await detector.detect([makeTable([{ name: columnName }])]);
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe('last_name');
      },
    );
  });

  describe('phone detection', () => {
    it.each(['phone', 'phone_number', 'telephone', 'tel', 'mobile', 'fax'])(
      'should detect "%s" as phone',
      async (columnName) => {
        const results = await detector.detect([makeTable([{ name: columnName }])]);
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe('phone');
      },
    );
  });

  describe('address detection', () => {
    it.each(['address', 'street', 'city', 'state', 'zip_code', 'postal_code', 'country'])(
      'should detect "%s" as address',
      async (columnName) => {
        const results = await detector.detect([makeTable([{ name: columnName }])]);
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe('address');
      },
    );
  });

  describe('date_of_birth detection', () => {
    it.each(['birthday', 'birth_date', 'dob', 'date_of_birth'])(
      'should detect "%s" as date_of_birth',
      async (columnName) => {
        const results = await detector.detect([makeTable([{ name: columnName }])]);
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe('date_of_birth');
      },
    );
  });

  describe('ip_address detection', () => {
    it.each(['ip_address', 'ip_addr', 'ip', 'remote_addr', 'client_ip', 'source_ip'])(
      'should detect "%s" as ip_address',
      async (columnName) => {
        const results = await detector.detect([makeTable([{ name: columnName }])]);
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe('ip_address');
      },
    );
  });

  describe('credit_card detection', () => {
    it.each(['credit_card', 'card_number', 'cc_number', 'pan'])(
      'should detect "%s" as credit_card',
      async (columnName) => {
        const results = await detector.detect([makeTable([{ name: columnName }])]);
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe('credit_card');
      },
    );
  });

  describe('ssn detection', () => {
    it.each(['ssn', 'social_security', 'national_id', 'my_number'])(
      'should detect "%s" as ssn',
      async (columnName) => {
        const results = await detector.detect([makeTable([{ name: columnName }])]);
        expect(results).toHaveLength(1);
        expect(results[0]!.category).toBe('ssn');
      },
    );
  });

  describe('non-PII columns', () => {
    it('should not detect non-PII columns', async () => {
      const tables = [
        makeTable([
          { name: 'id' },
          { name: 'created_at' },
          { name: 'updated_at' },
          { name: 'status' },
          { name: 'amount' },
          { name: 'description' },
        ]),
      ];
      const results = await detector.detect(tables);
      expect(results).toHaveLength(0);
    });
  });

  describe('primary key and foreign key exclusion', () => {
    it('should skip primary key columns', async () => {
      const tables = [makeTable([{ name: 'email', isPrimaryKey: true }])];
      const results = await detector.detect(tables);
      expect(results).toHaveLength(0);
    });

    it('should skip foreign key columns', async () => {
      const tables = [makeTable([{ name: 'email', isForeignKey: true }])];
      const results = await detector.detect(tables);
      expect(results).toHaveLength(0);
    });
  });

  describe('multiple tables', () => {
    it('should detect PII across multiple tables', async () => {
      const tables = [
        makeTable([{ name: 'email' }, { name: 'phone' }], 'users'),
        makeTable([{ name: 'address' }, { name: 'status' }], 'orders'),
      ];
      const results = await detector.detect(tables);
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.column)).toEqual(['email', 'phone', 'address']);
    });

    it('should include correct schema and table info in results', async () => {
      const tables = [makeTable([{ name: 'email' }], 'customers', 'my_schema')];
      const results = await detector.detect(tables);
      expect(results[0]!.schema).toBe('my_schema');
      expect(results[0]!.table).toBe('customers');
    });
  });

  describe('result structure', () => {
    it('should return complete detection result', async () => {
      const tables = [makeTable([{ name: 'email' }])];
      const results = await detector.detect(tables);
      expect(results[0]!).toEqual({
        schema: 'test_db',
        table: 'users',
        column: 'email',
        category: 'email',
        confidence: expect.any(Number),
        reasoning: expect.stringContaining('email'),
        suggestedMaskingStrategy: expect.any(String),
      });
    });
  });
});
