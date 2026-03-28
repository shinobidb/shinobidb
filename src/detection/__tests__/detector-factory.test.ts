import { createDefaultDetectors } from '../detector-factory.js';
import { ColumnNameDetector } from '../detectors/column-name-detector.js';

describe('createDefaultDetectors', () => {
  it('should return an array of detectors', () => {
    const detectors = createDefaultDetectors();
    expect(Array.isArray(detectors)).toBe(true);
    expect(detectors.length).toBeGreaterThan(0);
  });

  it('should include ColumnNameDetector', () => {
    const detectors = createDefaultDetectors();
    expect(detectors[0]).toBeInstanceOf(ColumnNameDetector);
  });
});
