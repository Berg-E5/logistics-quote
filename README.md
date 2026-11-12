# 物流报价网站

按渠道 / 国家 / 重量 / 尺寸算运费、毛利和建议售价的物流报价系统。

前端纯原生 JS + 后端 Node 原生 http，**零第三方运行时依赖**（不需要 `npm install`），
数据用 JSON 文件存，支持多用户各自独立的价格表。

---

## 一条命令装起来

```bash
docker run -d --name quote --restart unless-stopped \
  -p 127.0.0.1:8792:8792 \
  -v /var/lib/quote/data:/app/data \
  -e ADMIN_PASSWORD='你的密码' \
  utism/quote:latest
```

目标服务器只要装了 docker，**不用装 node / nginx / python**。
镜像在 [Docker Hub](https://hub.docker.com/r/utism/quote) 上，公开仓库，直接拉。

起好之后：

- 前台报价：<http://服务器:8792/>
- 后台改价：<http://服务器:8792/admin>
- 改动记录：<http://服务器:8792/admin/changes>
- 用户管理：<http://服务器:8792/admin/users>

首次启动会自动建 `admin` 账号，密码看 `docker logs quote`。

**镜像里不含任何数据** —— 报价表原件、价格快照、账号密码都不在镜像里。
要装一个有数据的站，用 volume 挂载数据目录，或者装完在后台网页上传报价表做整表导入。

## 不用 Docker

```bash
git clone https://github.com/<你的账号>/<仓库名>.git
cd <仓库名>
sudo bash deploy/install.sh <你的域名>
```

会装 systemd 单元、nginx 反代、申请证书、建 admin 账号。

或者在你自己的电脑上远程装：

```bash
bash deploy/install-remote.sh root@新服务器 quote.example.com
```

---

## 功能

**前台**（报价用）

- 选国家 → 选重量和尺寸 → 实时算出各渠道的定价成本、建议售价、当地售价、毛利
- 运费 / 挂号费 / 体积除数逐档可见，按定价成本升序排
- 「只显示可发的」默认勾上，不可发的渠道不参与最低价
- 最低价用**绿色**标出来；不可发行显示 `–`、点不动、给出不可发原因
- **空运 / 海运分类**：按报价表的「参考时效」自动分 —— 时效落在 18-30 这一档算海运，
  其它算空运（云途/4PX 的空运专线写「工作日」，海运大包专线写自然天）
- 成本对比图只画最便宜的 4 条，并写明「共 N 个可发渠道」
- 汇率取**中国银行现汇卖出价**，服务端每 60 秒刷新一次，中行挂了才退回国际源

**后台**

- 改价页：按 23 个渠道分组折叠，翻页按渠道算；运费 / 挂号费 / 体积数在表格里直接改
- 顶部紧凑仪表条 + 23 根渠道分布柱（柱高 = 档位数，点柱子筛该渠道）
- 锁定费率：被锁的档位整表导入时不会被覆盖
- 整表导入：选报价表 → 七步管道抽取 → 逐条差异明细（新增 / 变动 / 删除）
- 改动记录：谁在什么时候把哪一档从多少改成多少
- 用户管理：账号独立数据、登录失败锁 IP、管理员解封

**计算规则**

- 定价成本 = 运费 + 挂号费 + 附加费 + 采购价
- 三档售价 = 定价成本 ÷ 0.7 / 0.65 / 0.6，再 ÷ 0.85
- 体积重 = 长 × 宽 × 高(cm) ÷ 国家除数；计费重取实际重量与体积重的较大值
- 专线三线（÷6000 / ÷10000 / ÷18000）在报价表里是三条独立产品线，
  网站**分行显示**并标「线内最低」，而不是合并成一个 MIN 价

规则骨架来自一份《物流定价计算器》，实际价格来自盛途的渠道报价表。
两套口径都有回归验证：原计算器口径 264 组 0 不一致，报价表口径 401 组 0 不一致。

---

## 技术栈

| 部分 | 用什么 |
|---|---|
| 后端 | Node.js（只用内置模块，`http`/`fs`/`crypto`/`path`/`os`/`child_process`） |
| 前台 | 原生 JavaScript（单表单表格，离线要能双击 `file://` 打开） |
| 后台三页 | Vue 3 global build（vendored 在 `public/`，不用构建步骤） |
| 数据抽取 | Python 3 + openpyxl（读报价表 xlsx） |
| 样式 | 原生 CSS，令牌单一来源在 `public/ui-common.css` |

**没有 `package.json`，没有 `node_modules`，没有构建步骤。**
改完刷新就生效。前台支持离线双击，所以不能用 ESM / Vite。

## 目录

```
├── server/          后端: server.js / db.js / user.js / 三个后台页 / dash.css
├── public/          前台页面 + 引擎 + 样式 + Vue global build
├── 脚本/            数据抽取管道 (Python) + 验证脚本 (Node)
├── deploy/          install.sh / install-remote.sh / release.sh / Dockerfile 等
├── engine.js        计算引擎 (浏览器和 Node 共用一份)
└── index.html       离线版 (双击即用)
```

## 脚本

| 脚本 | 作用 |
|---|---|
| `deploy/install.sh` | 在一台新服务器上装（依赖检查 → systemd → nginx → 证书 → admin） |
| `deploy/install-remote.sh` | 在本地跑一条命令，远程装到别的服务器 |
| `deploy/release.sh [--push]` | 打包 + build 镜像 + 更新发布目录 + 可选推 Docker Hub |
| `deploy/docker-push.sh` | 推镜像到 Docker Hub |
| `脚本/verify_calc.js` | 原计算器口径回归（264 组） |
| `脚本/verify_rates.js` | 报价表口径交叉验证（401 组，独立实现） |
| `脚本/sync_copies.py` | 多副本同步 + 一致性检查 |
| `脚本/run_pipeline.py` | 整表导入的七步管道 |

## 关于这个仓库

**仓库里只有程序代码**，不含：

- 账号、密码哈希、`secret.key`、管理令牌
- 报价表原件（商业数据）
- 价格数据快照

`.gitignore` 已经把这些全部排除。需要这些数据的人从
[Docker Hub](https://hub.docker.com/r/utism/quote) 装镜像，或从发布服务器取安装包。

## 许可

代码 MIT。报价表和价格数据不包含在内。
