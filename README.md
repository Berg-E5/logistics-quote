# 物流报价网站

按渠道 / 国家 / 重量 / 尺寸算运费、毛利和建议售价的物流报价系统。

前端纯原生 JS + 后端 Node 原生 http，**Node 端零第三方依赖**（不需要 `npm install`），
数据用 JSON 文件存。总管理员可以创建多个独立管理员，每个管理员维护自己的价格表；
普通账号由所属管理员创建，只读访问该管理员的价格表，不能看到其他管理员的数据。

整表导入额外需要 Python 3 和 `openpyxl`；Docker 镜像和一键安装脚本会自动安装。

---

## 一条命令装起来

在一台新服务器上运行。脚本会自动安装 Node 18+、nginx、Python 3、openpyxl 和 certbot：

```bash
curl -fsSL https://raw.githubusercontent.com/Berg-E5/logistics-quote/main/deploy/bootstrap.sh \
  | sudo bash -s -- <你的域名>
```

脚本会下载程序包、安装系统依赖、配置 systemd 和 nginx、申请 HTTPS 证书、
启用自动续签，并创建全新的 admin 账号。没有域名的测试环境可在末尾加 `skip-ssl`。

起好之后：

- 前台报价：<https://你的域名/>
- 后台改价：<https://你的域名/admin>
- 改动记录：<https://你的域名/admin/changes>
- 用户管理：<https://你的域名/admin/users>

## 其它方式

**在你自己的电脑上远程装**（自动传包 + 远程安装）：

```bash
bash deploy/install-remote.sh root@新服务器 quote.example.com
```

**手动三步**：

```bash
git clone https://github.com/Berg-E5/logistics-quote.git
cd logistics-quote
sudo bash deploy/install.sh <你的域名>
```

**想用 Docker**（从源码 build，不依赖任何镜像仓库）：

```bash
git clone https://github.com/Berg-E5/logistics-quote.git
cd logistics-quote && docker compose up -d
```

### Windows 桌面客户端

`desktop/` 下是 Electron + Node + Python 的桌面版。首次运行可选择：

- **本机独立模式**：在本机创建管理员，数据保存在本机；
- **中央服务器模式（默认推荐）**：预填 `https://quote.byberg.store`，不创建本机管理员，
  直接登录中央服务器。连接失败时显示重试、检查设置和复制服务器地址。

中央服务器保存总管理员、多个独立管理员、各自普通用户和价格表。管理员 A 的普通用户
只能读取 A 的价格表，管理员 B 的普通用户只能读取 B 的价格表。窗口不会打开浏览器。

后台顶部固定显示当前工作区和价格表版本。用户管理分为“管理员账号”和“普通用户”：
管理员只能管理自己名下成员，总管理员可以创建管理员。新建或重置的临时密码首次登录
必须修改；账号支持停用、启用、重置密码和退出所有设备。

服务端后台已升级为工作台布局：左侧提供工作区总览、价格表、导入中心、成员管理、
改动记录；总管理员另有管理员与工作区、登录与安全页面。导入中心会先展示新增、删除和
价格变化预览，确认后才会发布价格。

```powershell
cd desktop
npm install
npm start
```

构建 Windows 安装程序：

```powershell
cd desktop
npm run dist
```

安装包输出到 `desktop/dist/LogisticsQuote-Setup-*.exe`。随包携带 Python 3.12
和 openpyxl，客户电脑不需要另外安装 Node、Python 或 nginx。

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
| `deploy/install.sh` | 自动装依赖 → systemd → nginx → 证书续签 → admin |
| `deploy/install-remote.sh` | 在本地跑一条命令，远程装到别的服务器 |
| `deploy/release.sh` | 打包 + 更新发布目录 |
| `deploy/bootstrap.sh` | 一条命令安装 (curl \| bash) |
| `脚本/verify_calc.js` | 原计算器口径回归（264 组） |
| `脚本/verify_rates.js` | 报价表口径交叉验证（401 组，独立实现） |
| `脚本/sync_copies.py` | 多副本同步 + 一致性检查 |
| `脚本/run_pipeline.py` | 整表导入的七步管道 |

## 测试

不需要商业报价数据或第三方 Node 模块；集成测试会调用系统 Python 3 和内置的假导入管道：

```bash
node --test
```

测试覆盖起收重量边界、并发导入的数据隔离，以及管理令牌是否真正写入 `admin` 作用域。

## 安全相关环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `QUOTE_REGISTRATION_OPEN` | `1` | 设为 `0` 关闭公开注册，仅管理员可建号 |
| `QUOTE_IMPORT_CONCURRENCY` | `2` | 同时运行的导入任务数 |
| `QUOTE_IMPORT_MAX_MB` | `40` | 单个 XLSX 文件大小上限 |
| `QUOTE_IMPORT_MAX_UNCOMPRESSED_MB` | `500` | XLSX 解压后总大小上限 |
| `QUOTE_IMPORT_TIMEOUT_MS` | `600000` | 单次导入超时时间 |
| `QUOTE_IMPORT_MAX_TIERS` | `200000` | JSON 导入的最大费率档数量 |
| `QUOTE_IMPORT_STALE_HOURS` | `24` | 启动时清理多久以前的临时导入目录 |
| `QUOTE_CHANGELOG_MAX_BYTES` | `8388608` | 单个改动日志文件轮转大小 |

公开部署前必须确认 `admin` 密码没有出现在源码、脚本或 Git 历史中。密码一旦泄露，
除了改密码，还应轮换生产环境的 `data/secret.key`，否则已经签发的会话仍可继续使用。
发布包不包含账号库、`secret.key` 或管理令牌，每个新站会生成自己的管理员账号和签名密钥。

## 关于这个仓库

**仓库里只有程序代码**，不含：

- 账号、密码哈希、`secret.key`、管理令牌
- 报价表原件（商业数据）
- 价格数据快照

`.gitignore` 已经把这些全部排除。需要这些数据的人从发布服务器
(`/root/quote-release/`) 取带数据的安装包，或装完后在后台网页上传报价表做整表导入。

## 许可

代码 MIT。报价表和价格数据不包含在内。
