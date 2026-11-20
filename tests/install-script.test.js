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
  assert.match(install, /python3-venv/);
  assert.match(install, /--require-hashes/);
  assert.match(install, /openpyxl 3\.1\.5/);
  assert.doesNotMatch(install, /pip install[^\n]*openpyxl(?! --)/);
  assert.match(install, /fail2ban/);
  assert.match(install, /fallocate -l 2G \/swapfile/);
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

test('一键安装会配置每日加密备份和安全响应头', () => {
  assert.match(install, /quote-backup\.timer/);
  assert.match(install, /--require-hashes/);
  assert.match(install, /Content-Security-Policy/);
  assert.match(install, /Strict-Transport-Security/);
  const backup = fs.readFileSync(path.join(root, 'deploy', 'backup.sh'), 'utf8');
  assert.match(backup, /openssl enc -aes-256-cbc/);
  assert.match(backup, /tar -tzf/);
  assert.match(backup, /OFFSITE_GIT_DIR/);
  const nginx = fs.readFileSync(path.join(root, 'deploy', 'nginx-quote.conf'), 'utf8');
  assert.match(nginx, /\/etc\/letsencrypt\/live\//);
  assert.doesNotMatch(nginx, /\/etc\/nginx\/ssl\//);
});
