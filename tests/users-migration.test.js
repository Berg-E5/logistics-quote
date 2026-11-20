'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('旧账号库自动迁移为总管理员和租户归属', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-users-migration-'));
  process.env.QUOTE_DATA_DIR = tempRoot;
  const usersFile = path.join(tempRoot, 'users.json');
  fs.writeFileSync(usersFile, JSON.stringify([
    {
      username: 'legacyOwner', role: 'admin',
      salt: '00', hash: '00', sessionVersion: 0,
    },
    {
      username: 'legacyViewer', role: 'user',
      salt: '00', hash: '00', sessionVersion: 0,
    },
  ], null, 2));

  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const users = require('../server/users');
  users.migrateUsers();

  const migrated = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  assert.equal(migrated.find(u => u.username === 'legacyOwner').system, true);
  assert.equal(migrated.find(u => u.username === 'legacyViewer').ownerAdmin, 'legacyOwner');
  assert.equal(users.findSystemAdmin().username, 'legacyOwner');

  users.createUser('adminA', 'ReviewUser123', 'admin', { system: false });
  users.createUser('viewerA', 'ReviewUser123', 'user', { ownerAdmin: 'adminA' });
  const adminA = users.findUser('adminA');
  const viewerA = users.findUser('viewerA');
  assert.equal(adminA.role, 'admin');
  assert.equal(adminA.system, false);
  assert.equal(viewerA.role, 'user');
  assert.equal(viewerA.ownerAdmin, 'adminA');
});
