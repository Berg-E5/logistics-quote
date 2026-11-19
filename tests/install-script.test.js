'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const install = fs.readFileSync(path.join(root, 'deploy', 'install.sh'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'deploy', 'bootstrap.sh'), 'utf8');

test('一键安装会自动处理系统依赖', () => {
  assert.match(install, /apt-get/);
  assert.match(install, /dnf/);
  assert.match(install, /yum/);
  assert.match(install, /setup_22\.x/);
  assert.match(install, /python3-openpyxl/);
  assert.match(install, /certbot/);
});

test('一键安装会自动申请证书并配置续签', () => {
  assert.match(install, /certbot --nginx/);
  assert.match(install, /certbot\.timer/);
  assert.match(install, /certbot renew/);
  assert.match(install, /--redirect/);
});

test('bootstrap 不再要求预装 Node，而是交给 install.sh', () => {
  assert.doesNotMatch(bootstrap, /请先装 Node/);
  assert.match(bootstrap, /bash deploy\/install\.sh/);
});
