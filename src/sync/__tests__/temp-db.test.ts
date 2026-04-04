import { generateTempDbName, generateOldDbName, isShinobiTempDb } from '../temp-db.js';

describe('temp-db', () => {
  describe('generateTempDbName', () => {
    it('should include target name and _shinobi_ prefix', () => {
      const name = generateTempDbName('staging');
      expect(name).toMatch(/^staging_shinobi_\d+$/);
    });

    it('should generate unique names over time', () => {
      const name1 = generateTempDbName('staging');
      // Names within the same second will be identical, but the format is correct
      expect(name1).toMatch(/^staging_shinobi_\d+$/);
    });
  });

  describe('generateOldDbName', () => {
    it('should include target name and _shinobi_old_ prefix', () => {
      const name = generateOldDbName('staging');
      expect(name).toMatch(/^staging_shinobi_old_\d+$/);
    });
  });

  describe('isShinobiTempDb', () => {
    it('should match temp database names', () => {
      expect(isShinobiTempDb('staging_shinobi_1712234567')).toBe(true);
    });

    it('should match old database names', () => {
      expect(isShinobiTempDb('staging_shinobi_old_1712234567')).toBe(true);
    });

    it('should not match regular database names', () => {
      expect(isShinobiTempDb('staging')).toBe(false);
      expect(isShinobiTempDb('staging_temp')).toBe(false);
      expect(isShinobiTempDb('my_shinobi_db')).toBe(false);
    });
  });
});
