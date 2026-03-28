import type { MaskingContext, MaskingStrategy } from '../types.js';

describe('masking types', () => {
  it('should allow constructing MaskingContext', () => {
    const ctx: MaskingContext = {
      schema: 'myapp',
      table: 'users',
      column: 'email',
      rowIndex: 0,
    };

    expect(ctx.table).toBe('users');
    expect(ctx.rowIndex).toBe(0);
  });

  it('should type-check MaskingStrategy interface', () => {
    const strategy: MaskingStrategy = {
      name: 'test-strategy',
      mask: jest.fn().mockReturnValue('masked'),
    };

    expect(strategy.name).toBe('test-strategy');
    expect(
      strategy.mask('original', { schema: 's', table: 't', column: 'c', rowIndex: 0 }, 'seed'),
    ).toBe('masked');
  });
});
