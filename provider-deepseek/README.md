<!-- Owner: index.ts, pricing.ts, console/client.ts, console/server.ts, console/schedule-panel.ts, console/pricing-panel.ts, package.json -->

# cortico-provider-deepseek

DeepSeek Responses API Provider for Cortico. The package is independent of `cortico-bot-continuity`.

## Local installation

Build the console bundle in this package directory, then install the package in Cortico's `extensions/` directory:

```powershell
Set-Location "<provider-deepseek 仓库路径>"
corepack pnpm build:console
Set-Location "<Cortico 仓库路径>\extensions"
corepack pnpm add --ignore-workspace "<provider-deepseek 仓库路径>"
```

Configure an endpoint with `kind: "deepseek"` and its API key in Cortico's provider settings.

## Pricing

The Provider supplies official DeepSeek rates for `deepseek-flash`. The “成本与计价” panel shows those rates and the current band. An endpoint-specific quote overrides applicable module rates; leave it empty to use the module rates. The “峰谷计价” panel allows editing peak windows and exception dates in China Standard Time.

Peak time defaults to Monday through Friday, 09:00–12:00 and 14:00–18:00. Weekends and exception dates are off-peak for the full day. Windows use half-open boundaries: the start time is included and the end time is excluded.

| Token usage | Off-peak | Peak |
| --- | ---: | ---: |
| Input, cache hit | ¥0.02 / million | ¥0.04 / million |
| Input, cache miss | ¥1 / million | ¥2 / million |
| Output | ¥4 / million | ¥8 / million |

Enter exception dates one per line as `YYYY-MM-DD`. The initial exception list contains the 2026 Chinese statutory holidays; adjust it when official dates change. Saved schedule changes apply to new requests.
