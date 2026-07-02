# Local Data 每日定时同步任务

## 简介

本任务负责在每天凌晨自动同步 A 股全市场数据到本地 SQLite 数据库 (`~/.trading-agent/data/market.db`)，为 `a-share-analysis` 等分析 skill 提供最新、最完整的数据。

## 同步内容

| 数据类型 | 目标表 | 数据来源 |
|---------|--------|---------|
| 股票列表 | `stocks` | mootdx TCP / akshare fallback |
| 实时行情 | `quotes` | mootdx TCP + 东方财富 |
| K线数据 | `klines` | mootdx TCP / akshare fallback |
| 财务报表 | `fundamentals` | mootdx 财务快照 + 东方财富 F10 |
| 行业分类 | `industries`, `stock_industries` | 东方财富 / akshare |
| 概念板块 | `concept_stocks` | 东方财富 / akshare |
| 个股新闻 | `stock_news` | 东方财富 / akshare |
| 市场新闻 | `market_news` | 财联社等 |

## 安装步骤

### 1. 验证脚本已就绪

确认以下文件已存在于 skill 目录：
```powershell
ls "$env:USERPROFILE\.agents\skills\local-data\scripts\daily_sync.py"
ls "$env:USERPROFILE\.agents\skills\local-data\scripts\sync_validator.py"
ls "$env:USERPROFILE\.agents\skills\local-data\scripts\setup_task.ps1"
```

### 2. 安装依赖

```bash
pip install akshare pandas requests beautifulsoup4 mootdx
```

### 3. 配置 Windows 定时任务

**以管理员身份**运行 PowerShell，执行：

```powershell
cd "$env:USERPROFILE\.agents\skills\local-data\scripts"
.\setup_task.ps1
```

或手动通过「任务计划程序」(`taskschd.msc`) 创建：
- **常规**: 名称 `A-Share-Daily-Sync`，勾选「使用最高权限运行」
- **触发器**: 每天 `01:20:00`
- **操作**: 程序 `python`，参数 `daily_sync.py`，起始于 `%USERPROFILE%\.agents\skills\local-data\scripts`
- **设置**: 失败重试 3 次，间隔 5 分钟

### 4. 手动测试运行

```powershell
cd "$env:USERPROFILE\.agents\skills\local-data\scripts"
python daily_sync.py --skip-fundamentals
```

首次运行建议先跑快速模式（跳过 fundamentals），确认各阶段正常后再跑完整同步。

## 用法

### 完整同步（所有阶段）
```bash
python daily_sync.py
```

### 仅运行验证
```bash
python daily_sync.py --validate-only
```

### 跳过基本面（快速模式，约 15 分钟）
```bash
python daily_sync.py --skip-fundamentals
```

### 仅运行指定阶段
```bash
python daily_sync.py --phase quotes --phase klines
python daily_sync.py --phase stock_news --phase market_news
```

### 单独运行验证器
```bash
python sync_validator.py
python sync_validator.py --output report.json
```

## 日志与报告

- **运行日志**: `~/.trading-agent/logs/sync_YYYYMMDD.log`
- **结果摘要**: `~/.trading-agent/logs/sync_summary_YYYYMMDD.json`

## 验证规则

同步完成后自动验证以下指标：

| 检查项 | PASS 标准 | WARN 标准 | FAIL 标准 |
|-------|----------|----------|----------|
| stocks | >= 4500 只 | - | < 4500 只 |
| quotes | 当天 4000+ | < 4000 | 当天无数据 |
| klines | 最新日期=最近交易日 | stale / <4000 只最新 | 无数据 |
| fundamentals | 3000+ 只股票 | < 3000 只 | 无数据 |
| industries | 3+ 标准, 4000+ 只 | < 3 标准 / <4000 只 | 无数据 |
| concepts | 100+ 概念 | < 100 概念 | 无数据 |
| news | 有数据即可 | 无数据 | - |

验证不通过时：
- `WARNING`: 记录到日志，脚本继续执行，退出码 0
- `FAIL`: 记录到日志和错误摘要，脚本退出码 1（便于任务计划程序触发重试或告警）

## 常见问题

### Q: fundamentals 阶段非常慢
全市场 5000+ 只股票逐个调用东方财富 F10 接口约 30-60 分钟。日常可 `--skip-fundamentals`，财报每季度才更新一次。

### Q: akshare 接口报错
```bash
pip install --upgrade akshare
```

### Q: 数据库被占用（database is locked）
确保同步时间设定在凌晨，此时没有其他 agent 写入 market.db。

### Q: 任务计划程序运行失败但手动运行正常
检查任务配置中的「起始于」是否指向正确的 scripts 目录，以及 Python 路径是否正确。

## 文件清单

| 文件 | 说明 |
|------|------|
| `daily_sync.py` | 主同步脚本 |
| `sync_validator.py` | 数据验证模块 |
| `setup_task.ps1` | Windows 定时任务配置脚本 |
| `README-daily-sync.md` | 本文档 |
