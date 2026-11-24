/**
 * E1.5 — RBAC Permission Matrix Lock
 *
 * Trava explicitamente a matriz de permissões RBAC para evitar regressões futuras.
 * Testa hasPermission() diretamente para todos os 5 roles × 7 permissões (ADR-0206).
 *
 * @since E1.5 (2026-03-14)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasPermission } from '../../src/security/rbac.js';
import type { TenantRole } from '../../src/api/tenantKeyRegistry.js';
import type { Permission } from '../../src/security/rbac.js';

const ALL_PERMISSIONS: Permission[] = [
  'receipts:write',
  'receipts:read',
  'accounting:read',
  'admin:flush',
  'admin:chain-head',
  'admin:tal-summary',
  'admin:keys',
];

const ALL_ROLES: TenantRole[] = ['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER'];

// Canonical permission matrix — mirrors ROLE_PERMISSIONS in rbac.ts
const CANONICAL_MATRIX: Record<TenantRole, Permission[]> = {
  OWNER: [
    'receipts:write', 'receipts:read', 'accounting:read',
    'admin:flush', 'admin:chain-head', 'admin:tal-summary', 'admin:keys',
  ],
  ADMIN: [
    'receipts:write', 'receipts:read', 'accounting:read',
    'admin:flush', 'admin:chain-head', 'admin:tal-summary',
  ],
  OPERATOR: [
    'receipts:write', 'receipts:read', 'accounting:read',
    'admin:flush', 'admin:chain-head', 'admin:tal-summary',
  ],
  MEMBER: [
    'receipts:write', 'receipts:read', 'accounting:read',
  ],
  VIEWER: [
    'receipts:read', 'accounting:read',
  ],
};

describe('E1.5 — RBAC Permission Matrix Lock', () => {

  describe('OWNER — possui todas as 7 permissões', () => {
    for (const perm of ALL_PERMISSIONS) {
      it(`OWNER has ${perm}`, () => {
        assert.equal(hasPermission('OWNER', perm), true);
      });
    }
  });

  describe('ADMIN — possui 6 permissões (sem admin:keys)', () => {
    const granted: Permission[] = [
      'receipts:write', 'receipts:read', 'accounting:read',
      'admin:flush', 'admin:chain-head', 'admin:tal-summary',
    ];
    for (const perm of granted) {
      it(`ADMIN has ${perm}`, () => {
        assert.equal(hasPermission('ADMIN', perm), true);
      });
    }
    it('ADMIN does NOT have admin:keys', () => {
      assert.equal(hasPermission('ADMIN', 'admin:keys'), false);
    });
  });

  describe('OPERATOR — possui 6 permissões (sem admin:keys)', () => {
    const granted: Permission[] = [
      'receipts:write', 'receipts:read', 'accounting:read',
      'admin:flush', 'admin:chain-head', 'admin:tal-summary',
    ];
    for (const perm of granted) {
      it(`OPERATOR has ${perm}`, () => {
        assert.equal(hasPermission('OPERATOR', perm), true);
      });
    }
    it('OPERATOR does NOT have admin:keys', () => {
      assert.equal(hasPermission('OPERATOR', 'admin:keys'), false);
    });
  });

  describe('MEMBER — possui receipts + accounting, sem admin ops', () => {
    const granted: Permission[] = ['receipts:write', 'receipts:read', 'accounting:read'];
    for (const perm of granted) {
      it(`MEMBER has ${perm}`, () => {
        assert.equal(hasPermission('MEMBER', perm), true);
      });
    }
    const denied: Permission[] = ['admin:flush', 'admin:chain-head', 'admin:tal-summary', 'admin:keys'];
    for (const perm of denied) {
      it(`MEMBER does NOT have ${perm}`, () => {
        assert.equal(hasPermission('MEMBER', perm), false);
      });
    }
  });

  describe('VIEWER — somente leitura, sem write nem admin', () => {
    const granted: Permission[] = ['receipts:read', 'accounting:read'];
    for (const perm of granted) {
      it(`VIEWER has ${perm}`, () => {
        assert.equal(hasPermission('VIEWER', perm), true);
      });
    }
    const denied: Permission[] = [
      'receipts:write',
      'admin:flush', 'admin:chain-head', 'admin:tal-summary', 'admin:keys',
    ];
    for (const perm of denied) {
      it(`VIEWER does NOT have ${perm}`, () => {
        assert.equal(hasPermission('VIEWER', perm), false);
      });
    }
  });

  describe('Invariante — OWNER é superset de todos os outros roles', () => {
    const otherRoles: TenantRole[] = ['ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER'];
    for (const role of otherRoles) {
      it(`OWNER tem tudo que ${role} tem`, () => {
        for (const perm of ALL_PERMISSIONS) {
          if (hasPermission(role, perm)) {
            assert.equal(
              hasPermission('OWNER', perm),
              true,
              `OWNER deveria ter ${perm} (${role} tem)`
            );
          }
        }
      });
    }
  });

  describe('Invariante — matriz canônica exata (sem permissões extras ou faltantes)', () => {
    for (const role of ALL_ROLES) {
      it(`${role}: permissões concedidas são exatamente as canônicas`, () => {
        const expected = new Set(CANONICAL_MATRIX[role]);
        for (const perm of ALL_PERMISSIONS) {
          const shouldHave = expected.has(perm);
          const actuallyHas = hasPermission(role, perm);
          assert.equal(
            actuallyHas,
            shouldHave,
            `${role}.${perm}: esperado=${shouldHave}, obtido=${actuallyHas}`
          );
        }
      });
    }
  });

  describe('Invariante — nenhum role tem permissão desconhecida', () => {
    it('ALL_PERMISSIONS cobre exatamente o conjunto canônico de 7 permissões', () => {
      assert.equal(ALL_PERMISSIONS.length, 7);
      const expected = [
        'receipts:write', 'receipts:read', 'accounting:read',
        'admin:flush', 'admin:chain-head', 'admin:tal-summary', 'admin:keys',
      ];
      for (const p of expected) {
        assert.ok(ALL_PERMISSIONS.includes(p as Permission), `Permissão ausente: ${p}`);
      }
    });
  });

  describe('Hierarquia — ADMIN = OPERATOR (mesmas permissões)', () => {
    it('ADMIN e OPERATOR têm exatamente o mesmo conjunto de permissões', () => {
      for (const perm of ALL_PERMISSIONS) {
        assert.equal(
          hasPermission('ADMIN', perm),
          hasPermission('OPERATOR', perm),
          `Divergência em ${perm}: ADMIN=${hasPermission('ADMIN', perm)}, OPERATOR=${hasPermission('OPERATOR', perm)}`
        );
      }
    });
  });

  describe('Hierarquia — MEMBER ⊂ OPERATOR ⊂ ADMIN ⊂ OWNER', () => {
    it('MEMBER não tem nada que OPERATOR não tenha', () => {
      for (const perm of ALL_PERMISSIONS) {
        if (hasPermission('MEMBER', perm)) {
          assert.equal(hasPermission('OPERATOR', perm), true, `OPERATOR deveria ter ${perm}`);
        }
      }
    });
    it('OPERATOR não tem nada que ADMIN não tenha', () => {
      for (const perm of ALL_PERMISSIONS) {
        if (hasPermission('OPERATOR', perm)) {
          assert.equal(hasPermission('ADMIN', perm), true, `ADMIN deveria ter ${perm}`);
        }
      }
    });
    it('ADMIN não tem nada que OWNER não tenha', () => {
      for (const perm of ALL_PERMISSIONS) {
        if (hasPermission('ADMIN', perm)) {
          assert.equal(hasPermission('OWNER', perm), true, `OWNER deveria ter ${perm}`);
        }
      }
    });
  });

  describe('admin:keys — exclusividade OWNER', () => {
    it('apenas OWNER possui admin:keys', () => {
      const rolesWithAdminKeys = ALL_ROLES.filter(r => hasPermission(r, 'admin:keys'));
      assert.deepEqual(rolesWithAdminKeys, ['OWNER']);
    });
  });

});
