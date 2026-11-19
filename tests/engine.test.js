'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine');

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
