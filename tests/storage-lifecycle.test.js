'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function sampleData(price) {
  return {
    countries: [{ name: '美国', label: '美国' }],
    groups: [{
      sheet: '测试渠道', country: '美国', zone: '-', line: '-',
      attr: '', mode: 'band', div: 6000, countryDiv: 6000,
      countryDivSrc: 'sheet', cur: 'USD', lead: '', limits: '',
    }],
    tiers: [{
      sheet: '测试渠道', country: '美国', zone: '-', line: '-',
      attr: '', mode: 'band', lo: 0, hi: 999,
      price, fee: 0, nextkg: null, first_kg: null, next_kg: null,
    }],
    rules: [], divRules: {},
    meta: { channels: 1, groups: 1, tiers: 1, countries: 1, countriesAll: 1 },
  };
}

test('价格存储覆盖导入、改价、锁定、人工除数和改动日志', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-db-lifecycle-'));
  process.env.QUOTE_DATA_DIR = dataDir;
  const db = require('../server/db');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const imported = db.saveAll('tenant-a', sampleData(100), '首次导入', 'admin');
  assert.equal(imported.rev, 1);
  const loaded = db.load('tenant-a');
  assert.equal(loaded.data.tiers.length, 1);
  assert.ok(loaded.data.tiers[0].id);
  const id = loaded.data.tiers[0].id;

  const changed = db.updateRate('tenant-a', id, { price: 123.456, fee: 7 }, 'operator');
  assert.equal(changed.rev, 2);
  assert.equal(changed.tier.price, 123.46);
  assert.equal(changed.tier.fee, 7);

  const lock = db.setLock('tenant-a', id, true, 'operator');
  assert.equal(lock.locked, true);
  assert.equal(Object.keys(db.loadLocks('tenant-a')).length, 1);
  db.updateRate('tenant-a', id, { price: 150 }, 'operator');
  const locked = db.loadLocks('tenant-a')[id];
  assert.equal(locked.price, 150);

  const group = loaded.data.groups[0];
  const key = db.divKey(group);
  const divSet = db.setDiv('tenant-a', key, 7000, 'operator');
  assert.equal(divSet.div, 7000);
  assert.equal(db.loadView('tenant-a').data.groups[0].countryDiv, 7000);
  const divReset = db.setDiv('tenant-a', key, null, 'operator');
  assert.equal(divReset.div, 6000);

  const added = db.addRate('tenant-a', {
    sheet: '测试渠道', country: '加拿大', zone: '-', line: '-',
    attr: '', mode: 'band', lo: 0, hi: 999, price: 88, fee: 2,
  }, 'operator');
  assert.ok(added.rev >= 5);
  const afterAdd = db.load('tenant-a');
  assert.equal(afterAdd.data.tiers.length, 2);

  const changes = db.readChanges('tenant-a', 50, 0, { kind: 'update' });
  assert.equal(changes.length, 2);
  assert.equal(changes[0].by, 'operator');
  assert.equal(db.countChanges('tenant-a', { q: '测试渠道' }), 7);

  db.setLock('tenant-a', id, false, 'operator');
  assert.equal(Object.keys(db.loadLocks('tenant-a')).length, 0);

  const token = db.getToken();
  assert.match(token, /^[a-f0-9]{48}$/);
  assert.equal(db.checkToken(token), true);
  assert.equal(db.checkToken('wrong-token'), false);
});

test('账号生命周期持久化登录元数据和安全审计', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-user-lifecycle-'));
  process.env.QUOTE_DATA_DIR = dataDir;
  const users = require('../server/users');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const owner = users.createUser('owner', 'ReviewAdmin123', 'admin', { system: true });
  assert.equal(owner.system, true);
  assert.equal(users.findSystemAdmin().username, 'owner');
  assert.equal(users.verifyPassword('ReviewAdmin123', users.findUser('owner')), true);
  assert.equal(users.verifyPassword('bad-password', users.findUser('owner')), false);

  const member = users.createUser('member', 'ReviewUser123', 'user', {
    ownerAdmin: 'owner',
  });
  assert.equal(member.ownerAdmin, 'owner');
  assert.equal(users.findAdmins().length, 1);

  users.recordLogin('member', {
    ip: '203.0.113.9', userAgent: 'Review Browser',
  });
  const logged = users.findUser('member');
  assert.equal(logged.lastLoginIp, '203.0.113.9');
  assert.equal(logged.loginHistory.length, 1);

  users.adminResetPassword('member', 'ReviewReset123');
  assert.equal(users.findUser('member').mustChangePassword, true);
  users.setPassword('member', 'ReviewChanged123');
  assert.equal(users.findUser('member').mustChangePassword, false);
  users.setDisabled('member', true);
  assert.equal(users.findUser('member').disabled, true);
  users.setDisabled('member', false);
  assert.equal(users.findUser('member').disabled, false);
  users.revokeSessions('member');
  assert.ok(users.findUser('member').sessionVersion >= 1);

  users.appendAudit({
    actor: 'owner', action: 'account.test', target: 'member',
    ip: '203.0.113.9', userAgent: 'Review Browser',
    details: { result: 'ok' },
  });
  const audit = users.readAudit(10);
  assert.equal(audit[0].action, 'account.test');
  assert.equal(audit.some(x => x.action === 'login'), true);

  assert.throws(() => users.createUser('bad name', 'ReviewUser123', 'user'), /用户名/);
  assert.throws(() => users.adminResetPassword('member', 'short'), /至少 8 位/);
  const deleted = users.deleteUser('member');
  assert.equal(deleted.username, 'member');
  assert.equal(users.findUser('member'), null);
});
