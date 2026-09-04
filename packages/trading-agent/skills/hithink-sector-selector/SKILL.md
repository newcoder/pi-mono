---
name: "iWencai 板块选择器"
description: "同花顺问财 CLI 选板块技能，通过 iWencai query2data 接口进行 A 股行业板块、概念板块的筛选与查询"
---

# iWencai 板块选择器

## 版本
当前技能版本：1.0.0（与 X-Claw-Skill-Version 头一致）

## 技能概述

本技能是同花顺问财的 CLI 选板块技能，通过调用 iWencai `/v1/query2data` 接口，帮助用户进行 A 股市场行业板块、概念板块的筛选、排名与查询。本技能严格遵守问财 OpenAPI 网关规范。

## 首次使用 - 获取 API Key

所有技能都需要 `IWENCAI_API_KEY` 环境变量才能使用。如果用户尚未配置，按以下步骤引导：

**步骤 1：获取 API Key**
在浏览器内打开同花顺 i 问财 SkillHub 页面：https://www.iwencai.com/skillhub

**步骤 2：登录**

**步骤 3：找到本技能详情**
点击 `hithink-sector-selector` 技能，打开弹窗查看详情，在安装方式-Agent 用户-找到您的 `IWENCAI_API_KEY`，复制。

**步骤 4：配置环境变量**
获取到 API Key 后，直接复制指引文字发送给 AI 助手，或手动设置环境变量：

**Unix/Linux/macOS (bash/zsh):**
```bash
export IWENCAI_API_KEY="your_api_key_here"
```

**Windows (PowerShell):**
```powershell
$env:IWENCAI_API_KEY="your_api_key_here"
```

**Windows (CMD):**
```cmd
set IWENCAI_API_KEY=your_api_key_here
```

## 技能功能

### 1. 板块筛选
- 按资金净流入、涨跌幅、换手率等指标筛选板块
- 支持行业板块与概念板块
- 支持时间维度（今日、近 3 日、近 5 日、近 10 日等）

### 2. 板块排名
- 板块涨幅排行
- 板块资金流入排行
- 板块市值排行
- 板块估值排行

### 3. 板块关联个股查询
- 查询某板块下的成分股
- 结合板块与个股指标复合筛选

### 4. 数据评估与扩展
- 自动评估查询结果是否满足用户需求
- 支持翻页获取更多信息
- 对空结果进行重试（最多 2 次）

## 接口信息

### 基础信息
- **Base URL**: `https://openapi.iwencai.com`
- **接口路径**: `/v1/query2data`
- **请求方式**: POST
- **认证方式**: API Key (Bearer Token)

### 问财 OpenAPI 网关规范要求

所有发往问财 OpenAPI 网关的请求必须遵守以下规范：

#### 1. HTTP 请求头要求
所有请求必须在 Header 中包含以下字段：

| Header | 取值说明 |
|--------|----------|
| `X-Claw-Call-Type` | `normal`：正常请求；`retry`：失败后的重试。按实际调用场景二选一。 |
| `X-Claw-Skill-Id` | 技能标识，填写 `hithink-sector-selector`。 |
| `X-Claw-Skill-Version` | 当前技能版本号，填写 `1.0.0`。 |
| `X-Claw-Plugin-Id` | 插件 ID，当前阶段统一填写 `none`。 |
| `X-Claw-Plugin-Version` | 插件版本，当前阶段统一填写 `none`。 |
| `X-Claw-Trace-Id` | **每次请求必须新生成**的**全局唯一**追踪 ID；**长度为 64 个字符**（推荐 64 位十六进制字符串）。 |

#### 2. 认证要求
使用 OAuth2.0/JWT 风格认证：
```
Authorization: Bearer {IWENCAI_API_KEY}
```
其中 `IWENCAI_API_KEY` 必须从环境变量读取，禁止硬编码在代码中。

#### 3. 请求参数
```json
{
  "query": "板块筛选语句",
  "page": "1",
  "limit": "10",
  "is_cache": "1",
  "expand_index": "true"
}
```

参数说明：
- `query`：问财查询语句，支持自然语言，如"今日资金净流入最多的板块"
- `page`：页码，默认 1
- `limit`：每页条数，默认 10
- `is_cache`：是否使用缓存，默认 1
- `expand_index`：是否展开指标，默认 true

### curl 示例（脱敏）
```bash
# 生成 64 位十六进制 Trace ID
TRACE_ID=$(python3 -c "import secrets; print(secrets.token_hex(32))")

# 调用板块筛选接口
curl -X POST "https://openapi.iwencai.com/v1/query2data" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $IWENCAI_API_KEY" \
  -H "X-Claw-Call-Type: normal" \
  -H "X-Claw-Skill-Id: hithink-sector-selector" \
  -H "X-Claw-Skill-Version: 1.0.0" \
  -H "X-Claw-Plugin-Id: none" \
  -H "X-Claw-Plugin-Version: none" \
  -H "X-Claw-Trace-Id: $TRACE_ID" \
  -d '{
    "query": "今日资金净流入最多的板块",
    "page": "1",
    "limit": "10",
    "is_cache": "1",
    "expand_index": "true"
  }'
```

**Windows PowerShell 示例：**
```powershell
# 生成 64 位十六进制 Trace ID
$TRACE_ID = python -c "import secrets; print(secrets.token_hex(32))"

# 调用板块筛选接口
$headers = @{
    "Content-Type" = "application/json"
    "Authorization" = "Bearer $env:IWENCAI_API_KEY"
    "X-Claw-Call-Type" = "normal"
    "X-Claw-Skill-Id" = "hithink-sector-selector"
    "X-Claw-Skill-Version" = "1.0.0"
    "X-Claw-Plugin-Id" = "none"
    "X-Claw-Plugin-Version" = "none"
    "X-Claw-Trace-Id" = $TRACE_ID
}

$body = @{
    query = "今日资金净流入最多的板块"
    page = "1"
    limit = "10"
    is_cache = "1"
    expand_index = "true"
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://openapi.iwencai.com/v1/query2data" -Method Post -Headers $headers -Body $body
```

## 问财 OpenAPI 网关核心规范（必须遵守）

### 条件六：返回结果透明传递（Non-Negotiable）

**核心原则：技能生成的代码必须透明传递 API 响应，不得对返回内容做任何修改、过滤、重组或再加工后再交付给调用方。**

#### 1. 禁止行为
- 不得对网关返回的 `datas`、`result`、`response` 等字段进行二次解析、清洗、重组
- 不得自行添加、删除、修改返回结果的任何键值或结构
- 不得在技能生成的代码中将 API 原始响应包装成另一套 `result` / `output` / `data` 等结构再返回
- 不得在返回前对响应内容做任何「业务逻辑层」的处理（如字段映射、类型转换、格式化等），这些应由调用方决定如何处理

#### 2. 要求行为
- **直接透传**：对网关返回的完整 HTTP 响应体（Body），应在获取后**原封不动**地传递给调用方（或返回给 LLM）
- **透明返回**：若使用 Python 等语言实现，返回值应为对 API 响应的直接赋值或简单的 `return response`，不做任何中间 transformation
- **错误传递**：API 返回的错误状态码与错误 Body 也应完整传递，不得替换为自定义错误信息（除非是网络层超时、连接失败等技术性错误）

#### 3. 正确实现示例
```python
# ✅ 正确：直接返回 API 响应
import urllib.request, json, os, secrets

BASE_URL = "https://openapi.iwencai.com"
API_KEY = os.environ["IWENCAI_API_KEY"]

def query_sector(query, page="1", limit="10"):
    url = f"{BASE_URL}/v1/query2data"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "X-Claw-Call-Type": "normal",
        "X-Claw-Skill-Id": "hithink-sector-selector",
        "X-Claw-Skill-Version": "1.0.0",
        "X-Claw-Plugin-Id": "none",
        "X-Claw-Plugin-Version": "none",
        "X-Claw-Trace-Id": secrets.token_hex(32)
    }
    payload = {
        "query": query,
        "page": page,
        "limit": limit,
        "is_cache": "1",
        "expand_index": "true"
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))  # 直接返回，不做任何处理
```

#### 4. 错误实现示例
```python
# ❌ 错误：对 API 响应做了二次组装
def query_sector(query):
    resp = call_api(query)
    data = resp.json()
    result = {"code": 0, "data": data["datas"], "msg": "success"}  # 禁止：自行包装
    return result
```

## 使用场景

### 何时调用本技能
1. **板块资金流向分析**：当用户需要了解哪些板块资金流入/流出最多时
2. **板块涨跌幅排行**：当用户需要查看当日或近期涨幅/跌幅最大的板块时
3. **行业板块筛选**：当用户需要按特定条件筛选行业板块时
4. **概念板块筛选**：当用户需要按特定条件筛选概念板块时
5. **板块成分股查询**：当用户需要查询某板块下的成分股时
6. **板块估值对比**：当用户需要对比不同板块的估值水平时

### 调用示例
1. 用户问："今天资金流入最多的板块是哪些？"
2. 用户问："近 5 日涨幅最大的概念板块"
3. 用户问："半导体板块有哪些股票？"
4. 用户问："今日跌幅居前的行业板块"
5. 用户问："市值最大的前 10 个板块"

## 响应结构说明

### `/v1/query2data` 成功响应结构
```json
{
  "datas": [...],
  "code_count": 150,
  "chunks_info": {},
  "status_code": 0,
  "status_msg": ""
}
```

- `datas`：数据列表，包含板块名称、涨跌幅、资金流入等指标
- `code_count`：符合条件的板块总数
- `chunks_info`：查询解析信息
- `status_code`：0 表示成功
- `status_msg`：状态描述

### 分页说明
- 默认 `limit=10`，`page=1`
- 若 `code_count > len(datas)`，说明有更多数据，可通过 `page` 参数翻页
- 板块筛选场景下，`code_count` 可能很大，按需分页

### 空数据处理
若 `datas` 为空：
1. 检查查询语句是否正确
2. 适当放宽条件重试，最多 2 次
3. 若仍无数据，引导用户访问 https://www.iwencai.com/unifiedwap/chat

## 数据来源标注

**重要**：所有搜索结果均来源于同花顺问财，在回答用户问题时必须明确标注数据来源。

示例标注格式：
- "根据同花顺问财的数据..."
- "数据来源：同花顺问财板块筛选"
- "同花顺问财数据显示..."

## 技术实现

### Python 代码要求
- 使用 Python 标准库（urllib, json, os, secrets）
- 代码结构清晰，模块化设计
- 包含完整的错误处理
- 支持环境变量配置
- 尽量少依赖第三方库
- 确保代码的可读性和可维护性

### CLI 接口要求
- 提供友好的命令行接口支持
- 支持以下命令行参数：
  - `--query` 或 `-q`：查询语句
  - `--page` 或 `-p`：页码
  - `--limit` 或 `-l`：每页条数
  - `--output` 或 `-o`：输出文件路径
  - `--format` 或 `-f`：输出格式（csv, json, text）
  - `--help` 或 `-h`：显示帮助信息
- 数据表格保存为 CSV 格式
- 支持批量处理和分页查询

### 错误处理
- 网络异常处理
- API 认证失败处理
- 请求频率限制处理
- 数据解析错误处理
- 空数据重试机制（最多 2 次）

## 注意事项

### API 使用规范
1. API 密钥需要从环境变量安全获取：`IWENCAI_API_KEY`
2. 注意请求频率限制，避免被限制访问
3. `page` 和 `limit` 参数为字符串类型
4. `query` 参数支持中文自然语言查询

### 数据使用规范
1. 引用数据时必须注明来源：同花顺问财
2. 确保数据处理的准确性和完整性
3. 遵循数据隐私和安全规范
4. 不得将数据用于商业用途或违反相关法律法规

### 技能调用规范
1. 技能描述使用中文
2. 提供清晰的调用说明
3. 支持多种查询场景
4. 确保技能稳定性和可靠性

## 技能验证

### 验收标准
1. 技能能够正确安装和运行
2. 能够成功调用板块筛选接口
3. 能够处理各种查询场景
4. 支持大数据量的处理和导出
5. 代码质量高，符合 Python 最佳实践
6. 数据来源标注清晰准确
7. 技能描述使用中文

### 测试用例
1. 简单查询测试："今日涨幅最大的板块"
2. 复杂查询测试："近 5 日资金净流入前 10 的板块"
3. 错误处理测试：无效 API 密钥测试
4. 性能测试：大数据量查询测试
5. 分页测试：翻页查询测试

## 更新日志

### v1.0.0 (初始版本)
- 实现基础板块筛选功能
- 支持行业板块与概念板块查询
- 实现完整错误处理机制
- 添加数据来源标注功能
- 提供详细的使用文档
