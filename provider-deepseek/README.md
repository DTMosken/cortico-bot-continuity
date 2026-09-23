<!-- Owner: index.ts, pricing.ts, console/client.ts, console/server.ts, console/schedule-panel.ts, console/pricing-panel.ts, package.json -->

# cortico-provider-deepseek

`cortico-provider-deepseek` 是 Cortico 的 DeepSeek 模型供应商扩展，使用 DeepSeek Responses API。它是独立的 npm 包，不依赖 `cortico-bot-continuity`。

## 安装

要求 Cortico 模型供应商扩展 API 5。在 Cortico 仓库的 `extensions/` 目录安装：

```powershell
Set-Location "<Cortico 仓库路径>\extensions"
corepack pnpm add --ignore-workspace cortico-provider-deepseek
```

在 Cortico 控制台中新建 DeepSeek 端点，填写 API 密钥。默认模型为 `deepseek-flash`。

## 成本与计价

插件为 `deepseek-flash` 提供人民币模块价目。“成本与计价”面板显示峰谷单价和当前计价档位。端点自定义报价可按模型覆盖模块价目；未设置时使用模块价目。

| 每百万 tokens | 空闲时段 | 高峰时段 |
| --- | ---: | ---: |
| 输入，缓存命中 | ¥0.02 | ¥0.04 |
| 输入，缓存未命中 | ¥1 | ¥2 |
| 输出 | ¥4 | ¥8 |

默认高峰时段为北京时间周一至周五（不含例外日期）的 09:00–12:00、14:00–18:00。周末和例外日期全天为空闲时段。时间区间包含开始时刻，不包含结束时刻。

“当前计价时段”面板可调整两段高峰时间和例外日期；例外日期每行填写一个 `YYYY-MM-DD`。初始列表包含 2026 年中国法定节假日；后续年份需要按官方安排更新。保存后的时段设置用于新请求。

价格可能变化，发布的单价以 [DeepSeek 中文价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 为准。
