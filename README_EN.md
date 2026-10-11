# ev-diagnosis-mcp

MCP server for **new energy vehicle (NEV / EV) repair diagnosis in Chinese**. It gives any MCP client the part that general-purpose models don't have: hands-on Chinese EV repair know-how, the full chain from fault code to cause to price, and model-specific failure patterns.

Zero dependencies. Local data only. No network, no model calls, no API key, no telemetry.

Chinese version: [README.md](README.md)

See real output samples online (no install needed): https://ev-intake.app.workbuddy.host/demo.html

---

## Why

Ask a general model "why does a BYD Han EV lose range in winter" and you get a textbook list of possible causes. What actually matters on the shop floor is this:

> After wading or heavy rain, insulation faults usually come from water in the connectors — not from the battery pack itself. Check the harness and interfaces first.
> On a Tesla, insulation faults are usually underbody impact or water in the charge port. Section-by-section megger testing is the way to find it.

That kind of judgment is not in general training data. This server ships 190 such Chinese field notes as searchable data, plus 896 standard DTC definitions, 146 Chinese fault-code entries, and 44 model-specific failure records.

## Install

```bash
npx -y ev-diagnosis-mcp
# or
node server.mjs
```

```json
{
  "mcpServers": {
    "ev-diagnosis": {
      "command": "npx",
      "args": ["-y", "ev-diagnosis-mcp"]
    }
  }
}
```

Supports MCP protocol versions 2024-11-05 / 2025-03-26 / 2025-06-18.

## Tools (7)

| Tool | What it does | Data |
|---|---|---|
| `diagnose_full` | Given brand + model + symptom + code, returns a structured conclusion: causes ranked by probability, check order (free first, paid later), price tiers, model-specific patterns, and a plain-language paragraph you can send to the car owner | combined |
| `lookup_fault_code` | Fault code lookup: exact / prefix / Chinese keyword. Causes, diagnostic steps, fixes, labor, price range, parts, pitfalls | 146 |
| `lookup_dtc` | Standard DTC definitions: original English text + term-level Chinese gloss + manufacturer, and whether a Chinese repair entry exists locally | 896 |
| `search_experience` | Search 190 Chinese field notes by keyword, no code required | 190 |
| `list_model_issues` | Model-specific failure patterns (model x fault code) | 44 |
| `symptom_to_codes` | Symptom → candidate fault codes | 40 |
| `kb_stats` | Dataset sizes, sources and provenance grades | — |

Also exposes `resources` (kb://datasets, kb://provenance, kb://fault-codes, kb://dtc-index, kb://experience) and 2 `prompts` (diagnose_intake, owner_explain).

## Sample output

`diagnose_full({"brand":"特斯拉","model":"Model 3","symptom":"涉水后无法上电，仪表报高压系统故障"})` returns, among other sections:

```
## 可能原因（按概率排序，启发式估计，非统计值）
1. 高压线束破损对地 — 约 21%
2. 涉水导致连接器进水 — 约 18%
3. 电池包内部绝缘下降 — 约 15%

## 检查与处理顺序（先不花钱的，后花钱的）
1. [排查·几乎不花钱] 用绝缘检测仪测整包正/负对地绝缘阻值(标准>500Ω/V)
2. [排查·几乎不花钱] 分段断开高压部件(电池、MCU、OBC、压缩机)分别测量定位漏点
...
6. [维修·换密封件 500-2000 元] 断开维修开关MSD并验电

## 报价分档
- 换密封件：500 - 2000 元
- 换 OBC：3000 - 8000 元
- 换壳体/拆包：8000 - 20000 元
```

## Data provenance

Stated explicitly, because you can't judge a result without it. Run `kb_stats` any time.

| Dataset | Count | Source | Grade |
|---|---|---|---|
| Standard DTC definitions | 896 | ModelScope `Never84/Vehicle_DTC_Diagnostic_Trouble_Code_Definitions` (Apache 2.0) | **A** |
| Models & battery types | 34 | Public vehicle specs | **A** |
| Chinese fault-code repair entries | 146 | Team repair knowledge base (incl. GB standards and public OEM manuals) | B |
| Field notes from experienced mechanics | 190 | Team repair knowledge base | B |
| Model-specific failure patterns | 44 | Team repair knowledge base | B |
| Symptom → code mapping | 40 | Team repair knowledge base | B |
| Common parts | 56 | Public parts info | B |

- **A** = public dataset or real work orders, traceable
- **B** = structured and organized; fields completed by industry convention, **not verified vehicle by vehicle**
- **C** = sample/synthetic (not included in this release)

Probabilities in `diagnose_full` are a heuristic ranking (whether field notes corroborate a cause, how cheap the check is), **not measured statistics** — this is stated in the output as well. Prices are industry ranges; calibrate by model year and local labor.

After importing real work orders, entries are tagged `source=real_workorder`, promoted to grade A, and counted separately in `kb_stats`. Import script: `tools/import_workorders.py` (CSV / Excel / JSON).

**Output is decision support, not a repair verdict. High-voltage work must follow OEM procedures.**

## Tests

```bash
npm test
```

37 assertions covering handshake, tool list, all 7 tools, resources, prompts, and bad input. All passing.

## License

Code: MIT. Data: 896 DTC entries from an Apache 2.0 dataset; the rest is the team's knowledge base, licensed for use within this service.
