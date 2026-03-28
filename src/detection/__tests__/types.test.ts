import type { PiiCategory, PiiDetectionResult, PiiDetector } from '../types.js';

describe('detection types', () => {
  it('should allow all PiiCategory values', () => {
    const categories: PiiCategory[] = [
      'email',
      'name',
      'first_name',
      'last_name',
      'phone',
      'address',
      'date_of_birth',
      'ip_address',
      'credit_card',
      'ssn',
      'free_text',
      'unknown',
    ];

    expect(categories).toHaveLength(12);
  });

  it('should allow constructing PiiDetectionResult', () => {
    const result: PiiDetectionResult = {
      schema: 'myapp',
      table: 'users',
      column: 'email',
      category: 'email',
      confidence: 0.95,
      reasoning: 'Column name matches email pattern',
      suggestedMaskingStrategy: 'faker-email',
    };

    expect(result.confidence).toBe(0.95);
    expect(result.category).toBe('email');
  });

  it('should type-check PiiDetector interface', () => {
    const mockDetector: PiiDetector = {
      detect: jest.fn().mockResolvedValue([]),
    };

    expect(mockDetector.detect).toBeDefined();
  });
});
