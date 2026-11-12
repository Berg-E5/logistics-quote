// pm2 进程配置 —— 物流报价后端
//
// 用法:
//   pm2 start deploy/ecosystem.config.js
//   pm2 save && pm2 startup     (开机自启)
//
// 也提供了 systemd 单元: deploy/quote-server.service

module.exports = {
  apps: [
    {
      name: 'quote-server',
      script: 'server/server.js',
      cwd: '/var/www/quote.byberg.store',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: '8792',
        HOST: '127.0.0.1',
      },
      out_file: '/var/log/pm2/quote-server-out.log',
      error_file: '/var/log/pm2/quote-server-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
