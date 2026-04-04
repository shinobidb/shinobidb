import { rewriteDefiner } from '../mysql-sync.js';

describe('rewriteDefiner', () => {
  it('rewrites DEFINER in CREATE VIEW statement', () => {
    const input =
      'CREATE DEFINER=`source_user`@`localhost` SQL SECURITY DEFINER VIEW `mydb`.`v1` AS SELECT 1';
    const result = rewriteDefiner(input, 'target_user');
    expect(result).toBe(
      'CREATE DEFINER=`target_user`@`%` SQL SECURITY DEFINER VIEW `mydb`.`v1` AS SELECT 1',
    );
  });

  it('rewrites DEFINER in CREATE PROCEDURE statement', () => {
    const input = 'CREATE DEFINER=`admin`@`%` PROCEDURE `mydb`.`my_proc`() BEGIN SELECT 1; END';
    const result = rewriteDefiner(input, 'staging_user');
    expect(result).toBe(
      'CREATE DEFINER=`staging_user`@`%` PROCEDURE `mydb`.`my_proc`() BEGIN SELECT 1; END',
    );
  });

  it('handles DEFINER with spaces around equals and at', () => {
    const input = 'CREATE DEFINER = `root` @ `127.0.0.1` VIEW `v1` AS SELECT 1';
    const result = rewriteDefiner(input, 'newuser');
    expect(result).toBe('CREATE DEFINER=`newuser`@`%` VIEW `v1` AS SELECT 1');
  });

  it('returns unchanged SQL if no DEFINER clause', () => {
    const input = 'CREATE VIEW `v1` AS SELECT 1';
    const result = rewriteDefiner(input, 'user');
    expect(result).toBe(input);
  });

  it('only rewrites the first DEFINER occurrence', () => {
    // SQL SECURITY DEFINER is not a DEFINER=... clause, should be untouched
    const input = 'CREATE DEFINER=`old`@`host` SQL SECURITY DEFINER VIEW `v1` AS SELECT 1';
    const result = rewriteDefiner(input, 'new');
    expect(result).toBe('CREATE DEFINER=`new`@`%` SQL SECURITY DEFINER VIEW `v1` AS SELECT 1');
  });
});
