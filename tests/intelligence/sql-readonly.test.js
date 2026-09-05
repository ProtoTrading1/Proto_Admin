import { describe, it, expect } from 'vitest';
import { assertReadOnlySql } from '../../api/_sql-readonly.js';

describe('ERP SQL — read-only guard', () => {
  it('allows SELECT queries', () => {
    expect(() => assertReadOnlySql('SELECT TOP 1 CODE FROM dbo.STMAST')).not.toThrow();
  });

  it('blocks INSERT', () => {
    expect(() => assertReadOnlySql('INSERT INTO dbo.STMAST (CODE) VALUES (@x)')).toThrow(/SELECT/);
  });

  it('blocks UPDATE even inside a SELECT-looking string', () => {
    expect(() => assertReadOnlySql('UPDATE dbo.STMAST SET ONHAND = 0')).toThrow(/SELECT/);
  });

  it('blocks DELETE', () => {
    expect(() => assertReadOnlySql('DELETE FROM dbo.DBINVHD')).toThrow(/SELECT/);
  });

  it('blocks EXEC', () => {
    expect(() => assertReadOnlySql('EXEC sp_who')).toThrow(/Blocked SQL/);
  });
});
