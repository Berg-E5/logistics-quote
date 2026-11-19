'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../engine');
const db = require('../server/db');

test('起收重量边界按 >= 计算', () => {
  assert.equal(engine.checkWeight(0.1, 30, 0.09).ok, false);
  assert.equal(engine.checkWeight(0.1, 30, 0.1).ok, true);
  assert.equal(engine.checkWeight(0.1, 30, 0.1001).ok, true);
  assert.equal(engine.checkWeight(0.1, 30, 30).ok, true);
  assert.equal(engine.checkWeight(0.1, 30, 30.001).ok, false);
});

test('刚好等于起收重量时仍能正常报价', () => {
  const group = {
    sheet: '测试渠道',
    country: '美国',
    zone: '-',
    line: '-',
    mode: 'band',
    div: 6000,
  };
  const rule = {
    type: 'normal',
    minKg: 0.1,
    maxKg: 30,
    weightBlocks: true,
    div: 6000,
    price_normal: 10,
    fee_normal: 5,
  };
  const input = {
    kg: 0.1,
    L: 10,
    W: 10,
    H: 10,
    attr: '普货',
    buy: 0,
    recv: 0,
  };

  const exact = engine.quote(group, [], input, rule, false);
  assert.equal(exact.blocked, false);
  assert.equal(exact.matched, true);
  assert.ok(exact.total > 0);

  const below = engine.quote(group, [], { ...input, kg: 0.09 }, rule, false);
  assert.equal(below.blocked, true);
});

test('三个引擎副本必须完全一致', () => {
  const root = fs.readFileSync(path.join(__dirname, '..', 'engine.js'));
  assert.deepEqual(fs.readFileSync(path.join(__dirname, '..', 'public', 'engine.js')), root);
  assert.deepEqual(fs.readFileSync(path.join(__dirname, '..', '脚本', 'engine.js')), root);
});

test('未知附加费条件必须失败关闭', () => {
  const group = {
    sheet: '附加费测试', country: '美国', zone: '-', line: '-',
    mode: 'band', div: 6000, countryDiv: 6000,
  };
  const tiers = [{
    mode: 'band', lo: 0, hi: 10, price: 10, fee: 1,
  }];
  const input = { kg: 2, L: 10, W: 10, H: 10, attr: '普货' };
  group.sur = [{ name: '错误条件', fee: 100, cond: [{ typo_condition: 1 }] }];
  const unknown = engine.quote(group, tiers, input, null, true);
  assert.equal(unknown.surFee, 0);

  group.sur = [{ name: '正确条件', fee: 100, cond: [{ weight_gt: 1 }] }];
  const known = engine.quote(group, tiers, input, null, true);
  assert.equal(known.surFee, 100);
});

test('整表数据会补齐结构并拒绝重叠档位', () => {
  const data = db.normalizeData({
    tiers: [{
      sheet: '测试', country: '美国', zone: '-', line: '-', attr: '',
      mode: 'band', lo: 0, hi: 2, price: 10, fee: 0,
    }],
  });
  assert.equal(data.groups.length, 1);
  assert.equal(data.groups[0].currency, 'USD');
  assert.equal(data.countries[0].name, '美国');
  assert.equal(data.meta.tiers, 1);

  assert.throws(() => db.normalizeData({
    tiers: [
      { sheet: '测试', country: '美国', mode: 'band', lo: 0, hi: 2, price: 10, fee: 0 },
      { sheet: '测试', country: '美国', mode: 'band', lo: 2, hi: 5, price: 20, fee: 0 },
    ],
  }), /重量段重叠/);
});
