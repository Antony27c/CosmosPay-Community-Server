import {
  ADMIN_ROLES,
  parseAdminCredentials,
  roleSatisfies,
  verifyAdminBearer,
  type AdminCredential,
} from './admin-auth';
import { Logger } from '@nestjs/common';

describe('Admin auth spec (issue #34)', () => {
  const readCred: AdminCredential = {
    id: 'viewer',
    secret: 'read-secret-000000',
    role: 'read',
  };
  const writeCred: AdminCredential = {
    id: 'owner',
    secret: 'write-secret-00000',
    role: 'write',
  };
  const credentials = [readCred, writeCred];

  it('declares exactly read and write roles', () => {
    expect([...ADMIN_ROLES].sort()).toEqual(['read', 'write']);
  });

  describe('roleSatisfies', () => {
    it('lets write satisfy read and write', () => {
      expect(roleSatisfies('write', 'read')).toBe(true);
      expect(roleSatisfies('write', 'write')).toBe(true);
    });

    it('lets read satisfy only read', () => {
      expect(roleSatisfies('read', 'read')).toBe(true);
      expect(roleSatisfies('read', 'write')).toBe(false);
    });
  });

  describe('parseAdminCredentials', () => {
    it('returns [] for empty / invalid input (fail closed)', () => {
      expect(parseAdminCredentials(undefined)).toEqual([]);
      expect(parseAdminCredentials('')).toEqual([]);
      expect(parseAdminCredentials('not-json')).toEqual([]);
      expect(parseAdminCredentials('{}')).toEqual([]);
    });

    it('rejects the legacy plaintext marker "1" as a secret', () => {
      expect(
        parseAdminCredentials(
          JSON.stringify([{ id: 'legacy', secret: '1', role: 'write' }]),
        ),
      ).toEqual([]);
    });

    it('parses well-formed credentials', () => {
      expect(
        parseAdminCredentials(JSON.stringify([readCred, writeCred])),
      ).toEqual(credentials);
    });

    it('warns when JSON is malformed without leaking secrets', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      expect(parseAdminCredentials('{bad')).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('not valid JSON'),
      );
      warn.mockRestore();
    });

    it('warns when individual credentials are rejected', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      expect(
        parseAdminCredentials(
          JSON.stringify([
            { id: 'ok', secret: 'write-secret-00000', role: 'write' },
            { id: 'short', secret: '1', role: 'write' },
          ]),
        ),
      ).toEqual([
        { id: 'ok', secret: 'write-secret-00000', role: 'write' },
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('1 credential(s) rejected'),
      );
      warn.mockRestore();
    });
  });

  describe('verifyAdminBearer', () => {
    it('rejects missing / non-bearer authorization', () => {
      expect(verifyAdminBearer(undefined, credentials)).toBeNull();
      expect(verifyAdminBearer('Basic abc', credentials)).toBeNull();
      expect(verifyAdminBearer('Bearer', credentials)).toBeNull();
    });

    it('rejects unknown secrets', () => {
      expect(
        verifyAdminBearer('Bearer totally-wrong-secret', credentials),
      ).toBeNull();
    });

    it('accepts a valid read credential', () => {
      expect(
        verifyAdminBearer(`Bearer ${readCred.secret}`, credentials),
      ).toEqual({ id: 'viewer', role: 'read' });
    });

    it('accepts a valid write credential', () => {
      expect(
        verifyAdminBearer(`Bearer ${writeCred.secret}`, credentials),
      ).toEqual({ id: 'owner', role: 'write' });
    });

    it('fails closed when no credentials are configured', () => {
      expect(
        verifyAdminBearer(`Bearer ${writeCred.secret}`, []),
      ).toBeNull();
    });
  });
});
