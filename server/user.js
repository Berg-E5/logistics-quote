/*
 * 用户管理命令行
 *
 *   node server/user.js list
 *   node server/user.js add <用户名> [密码]
 *   node server/user.js passwd <用户名> [密码]
 *   node server/user.js del <用户名>
 *   node server/user.js locks      看被限流的 IP
 *   node server/user.js unlock     解封全部 IP (管理员连密码都忘了时的兜底)
 *
 * 不给密码时, 密码随机生成并打印出来 (只显示一次)。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const users = require('./users');

function rand() { return crypto.randomBytes(9).toString('base64url'); }

function main() {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  switch (cmd) {
    case 'list': {
      const list = users.listUsers();
      if (!list.length) { console.log('还没有用户'); break; }
      console.log('用户名'.padEnd(16) + '角色'.padEnd(10) + '创建时间');
      for (const u of list) {
        console.log(u.username.padEnd(16) + (u.role || 'admin').padEnd(10) +
          (u.createdAt || '').slice(0, 19).replace('T', ' '));
      }
      break;
    }
    case 'add': {
      if (!arg1) { console.log('用法: node server/user.js add <用户名> [密码]'); process.exit(1); }
      const pw = arg2 || rand();
      const u = users.createUser(arg1, pw, 'admin');
      console.log('已创建用户:', u.username);
      console.log('密码:', pw);
      console.log('(密码只显示这一次, 请记好)');
      break;
    }
    case 'passwd': {
      if (!arg1) { console.log('用法: node server/user.js passwd <用户名> [密码]'); process.exit(1); }
      const pw = arg2 || rand();
      users.setPassword(arg1, pw);
      console.log('已改密码:', arg1);
      console.log('新密码:', pw);
      console.log('(密码只显示这一次, 请记好)');
      break;
    }
    case 'del': {
      if (!arg1) { console.log('用法: node server/user.js del <用户名>'); process.exit(1); }
      const u = users.deleteUser(arg1);
      console.log('已删除用户:', u.username);
      break;
    }
    case 'locks':
    case 'unlock': {
      // 锁定状态在【运行中的服务进程】内存里, 所以必须通过 HTTP 问它,
      // 不能直接改本地 Map (那是另一个进程的副本)。
      const url = process.env.QUOTE_URL || ('http://127.0.0.1:' + (process.env.PORT || 8792));
      const tokenFile = path.join(__dirname, '..', 'data', 'admin.token');
      if (!fs.existsSync(tokenFile)) {
        console.log('找不到管理令牌:', tokenFile);
        process.exit(1);
      }
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      const req = http.request(url + '/api/rate-locks' + (cmd === 'unlock' ? '' : ''), {
        method: cmd === 'unlock' ? 'DELETE' : 'GET',
        headers: { 'x-admin-token': token },
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(body); } catch (e) { j = null; }
          if (res.statusCode !== 200) {
            console.log('服务没答应 (' + res.statusCode + '): ' + body.slice(0, 200));
            console.log('服务在跑吗? systemctl status quote-server');
            process.exit(1);
          }
          if (cmd === 'unlock') {
            console.log('已解封', (j && j.cleared) || 0, '条 IP 锁定');
          } else {
            const locks = (j && j.locks) || [];
            if (!locks.length) { console.log('没有被锁的 IP'); return; }
            console.log('IP'.padEnd(40) + '原因'.padEnd(14) + '次数'.padEnd(8) + '剩余');
            for (const l of locks) {
              console.log(l.ip.padEnd(40) +
                (l.kind === 'login' ? '登录失败' : '注册频繁').padEnd(14) +
                String(l.count).padEnd(8) + l.remainSec + ' 秒');
            }
          }
        });
      });
      req.on('error', (e) => {
        console.log('连不上服务:', e.message);
        console.log('服务在跑吗? systemctl status quote-server');
        process.exit(1);
      });
      req.end();
      break;
    }
    default:
      console.log('用户管理');
      console.log('  node server/user.js list');
      console.log('  node server/user.js add <用户名> [密码]');
      console.log('  node server/user.js passwd <用户名> [密码]');
      console.log('  node server/user.js del <用户名>');
      console.log('  node server/user.js locks      看被限流的 IP');
      console.log('  node server/user.js unlock     解封全部 IP');
  }
}

main();
