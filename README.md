# magpie-provider-litellm

Magpie 原生 LiteLLM Proxy Provider 外掛。

讓 AI Coding Agent（Claude Code、Codex、OpenCode 等）透過 [Magpie](https://usemagpie.ai/) 使用自建或託管的 [LiteLLM](https://docs.litellm.ai/) 代理，支援**原生模型協定路由**、**動態模型探索**與**用量預算監控**。

---

## 核心特色

### 1. 原生協定路由

- 依模型族系選協定：
  - Claude 系列（`claude*`）：`@ai-sdk/anthropic`，呼叫 `/v1/messages`。
  - OpenAI Responses 族系（依 `isOpenAIResponsesFamily` 判定）：`@ai-sdk/openai`，呼叫 `/v1/responses`。
  - 其餘對話模型（DeepSeek、Qwen、Llama 等）：`@ai-sdk/openai-compatible`，呼叫 `/v1/chat/completions`。
- Anthropic 路由若請求沒有 `anthropic-version`，外掛補上 `2023-06-01`。

### 2. 動態模型探索

- 第一優先：查詢 LiteLLM `/model/info`，讀取 Context Window、Output Limit、定價（每百萬 Token，含快取讀取／寫入單價）、Tool Call、Reasoning、Vision 與 PDF 輸入支援；Vision 或 PDF 任一支援即開啟 `attachment`。
- 次之：`/model/info` 不可用時改查 `/v1/models`。
- 規則（權威性由強到弱）：
  - `/model/info` 傳輸失敗、非 2xx、非 JSON、信封格式不合，或沒有任何可用列（全是損毀或 wildcard 列）→ 改查 `/v1/models`。
  - 信封合法且 `data: []` → 權威的空清單，清空模型，**不再降級**到 `/v1/models`。
  - 有可用列 → 權威結果。即使全是非對話模型，也**不會**從 `/v1/models` 補回（避免把 embedding 誤當成對話模型）。
  - 兩個端點都不可用 → 保留 Magpie 既有的模型清單。
- 非對話模型（`model_info.mode` 為 `embedding`、`image_generation`、`audio_transcription`、`audio_speech`、`ocr`、`realtime`、`rerank`、`moderation`、`extraction`、`completion`）會被略過；其他或缺漏的 mode 仍視為對話模型，不依模型名稱猜測。
- 決策模型（`decides`）只認 `mode` 為 `evaluation`／`decisions`，或沒有 mode 時名稱為 `Decision-1`；有明確其他 mode 時不依名稱判定。
- **Wire model ID 一律是 LiteLLM 的 `model_name`**：呼叫與 key／team 的 models 白名單都比對它。`litellm_params.model`（上游部署名）只用來查外部上限與目錄，**不會送上 proxy**。
- 上限來源：LiteLLM 明確數值優先；缺值時查 models.dev 目錄；仍缺輸出上限時使用保底值 4096，並在終端機警告。
- models.dev 目錄快取於 `~/.cache/magpie-provider-litellm/models-dev.json`，TTL 24 小時。快取損毀或形狀不合會重新下載；下載失敗時保留既有有效快取（即使已過期），不覆寫。

### 3. 認證標頭補全

- 模型呼叫請求（經外掛 loader 的 `fetch`）同時注入 `Authorization: Bearer <KEY>` 與 `x-api-key: <KEY>`，並帶 `x-litellm-source: magpie`，避免 LiteLLM Virtual Key 在 Anthropic 路由因標頭不一致被拒絕。
- 模型探索與 quota 查詢只帶 `Authorization`。

### 4. Magpie Quota 預算與花費監控

- 實作 Magpie 原生 `auth.usage` Hook，同時查詢 LiteLLM `/key/info`、`/user/info`、`/team/info`，把各層預算展開為 Magpie 視窗。
- 支援的層級（以 virtual key 即可讀取）：
  - **Key**：總額上限（`max_budget` + `budget_duration`）、多視窗（`budget_limits`）、單模型上限（`model_max_budget`，以字串摘要顯示）。
  - **User**：個人上限（`max_budget` + `budget_duration`）。
  - **Team**：僅當金鑰屬於 team（`team_id`）時查詢團隊上限。
  - **Team 成員**：成員個別上限（`team_memberships` 的 `litellm_budget_table.max_budget`）優先，沒有則套團隊預設（優先讀 `/team/info` 的 `team_member_budget_table`，相容平坦欄位 `team_member_budget`）；兩者都沒有就不顯示。
- 週期中文化：`1h` 每小時、`24h`／`1d` 每日、`7d` 每週、`30d`／`1mo` 每月、`12mo` 每年。
- 團隊金鑰不套用個人（User）預算：該層標示「（團隊金鑰不計）」、設為 `aside`（僅展示，不擋請求），且不計入剩餘額度。
- 剩餘額度（balance）以剩餘金額最少、會擋請求的上限為準，並標明是哪一層。上限用量讀不到時，以上限為上界。
- 任一層讀取失敗會列出「（讀取失敗）」視窗、不計入剩餘額度，且 balance 前面加「最多」，代表它只是上界。團隊金鑰的 User 層失敗不影響結果。
- 每個上限視窗帶 `span`（週期秒數）；不擋請求的資訊列帶 `aside: true`。
- 於 Magpie 桌面端 Quota 卡片與 `magpie quota` 命令列檢視。
- 團隊與金鑰的 TPM（每分鐘 token 上限）會列在帳號 Quota 卡片上。這些數字不是即時剩餘量，也不參與 Magpie 路由。

### 5. 401、429 與工作階段追蹤

- **401**：只有確認的 key 失效才標記 `X-Magpie-Sign-In: expired`，觸發 Magpie 換號輪詢。判定優先序：
  1. LiteLLM 錯誤類型為 `expired_key` 或 `token_not_found_in_db` → `expired`。`auth_error` 是兜底類型（預算預扣失敗等也會用），不單獨作為證據。
  2. 上游供應商錯誤（`<Provider>Exception -`）→ 無法判定，`kept`，不標記使用者帳號。
  3. 明確的「invalid／expired／blocked … key」字樣 → `expired`（即使同一訊息也提到模型）。
  4. 模型不被提供（如 `model_not_found`）→ `kept`。
  5. 其餘、內文空白、不可讀、超過 64 KiB，或讀取超過 250 毫秒 → `kept`。
  - 401 的原始內文與狀態保持不變；重新包裝時移除過時的 `content-length`、`content-encoding`。
- **429**：有明確證據時，在 `error.message` 後補上限流來源與維度（RPM／TPM／並發等），並說明伺服器建議的重試秒數。判定來源包括 gateway 限流（`rate_limit_type`／`rate_limited_by` 標頭，或 `Rate limit exceeded for` 前綴）、上游供應商、部署冷卻與預算路由。內文超過 64 KiB、讀取超過 250 毫秒，或無法解析時原樣轉傳。保留原始 `Retry-After`。外掛不自動重試，備援切換交由 Magpie。
- **工作階段**：`chat.headers` Hook 會把 Magpie 的 `sessionID` 注入 `x-litellm-session-id`（僅限此 provider）。

---

## 安裝方式

Magpie 的外掛執行環境為 Bun（實測版本 1.4.2，由 Magpie 自行下載）。

```bash
# 方式 A：本地目錄（開發／除錯）
magpie plugin add /path/to/magpie-provider-litellm

# 方式 B：Git 來源（會自動安裝 zod 執行期依賴）
magpie plugin add git+file:///path/to/magpie-provider-litellm.git   # 本地 git 來源
# magpie plugin add github:et84121/magpie-provider-litellm          # 尚未驗證，見下方「未驗證項目」

# 檢視安裝狀態
magpie plugin
```

---

## 設定與登入

```bash
magpie plugin login litellm
```

1. **LiteLLM Base URL**：例如 `http://127.0.0.1:4000` 或 `https://litellm.internal.example.com`，留空使用預設 `http://127.0.0.1:4000`。含或不含 `/v1` 皆可。
2. **LiteLLM API Key**：Virtual Key 或 Master Key。

登入行為（已實測）：

- 登入本身**不會發出任何請求，也不驗證金鑰**；輸入後直接儲存，錯誤的金鑰同樣顯示「signed in」。
- 模型清單在之後的 Magpie 讀取時探索（例如 `magpie models`、`magpie plugin`、`magpie provider test`），探索成功才會更新為 LiteLLM 的模型；失敗時保留既有清單。金鑰是否有效要由第一次請求或 `magpie quota` 確認。

Base URL 優先序（每次呼叫時解析）：

1. Key 欄位的複合格式 `https://host <key>`（分隔符可為空白、逗號、`#` 或 `|`）。
2. 登入時儲存的 Base URL。
3. 環境變數 `LITELLM_BASE_URL`。
4. 預設 `http://127.0.0.1:4000`。

---

## 驗證與使用

```bash
# 列出模型（以 litellm/<model_name> 形式）
magpie models

# 測試連線與協定（<model> 換成 LiteLLM 上的模型名）
magpie provider test litellm <model>

# 查看 LiteLLM 額度與花費
magpie quota
```

---

## 在 Coding Agents 中使用

登入完成後，LiteLLM 上的模型以 `litellm/<model_name>` 形式出現，可指派給 Agent：

- **Claude Code**：`litellm/<claude 模型名>`，走 Anthropic Messages 路由。
- **Codex**：於 Magpie 切換為 `litellm/<model-name>`。（未實測。）
- **OpenCode**：於 `opencode.json` 或介面中選用 `litellm/<model-name>`。（未實測，見下方。）

---

## 本地測試

```bash
cd /path/to/magpie-provider-litellm
bun install --frozen-lockfile
bun check
bun run lint
bun fmt --check src tests
bun test
```

CI 使用 Bun 1.4.5（見 `.github/workflows`）。

---

## 驗證狀態

只列已實際驗證的項目；其餘以程式碼與單元測試為準，並明確標示。

### 已在隔離環境實測（Magpie CLI + 假 LiteLLM 伺服器）

測試環境：

- Magpie CLI 0.1.4584；插件 host 執行環境 Bun 1.4.2（由 Magpie 下載）。
- 以 `HOME`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME`、`XDG_DATA_HOME` 指向暫存目錄，不影響使用者的 Magpie 設定、資料與背景程序。
- 假 LiteLLM 伺服器綁定 `127.0.0.1` 的隨機埠，記錄收到的 header 與 wire model ID。

| 項目                                                                | 結果                                                                                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地目錄安裝（`magpie plugin add <path>`）                          | 通過                                                                                                                                                                        |
| Git 來源安裝（`git+file://` 本地 bare repo，未推送分支）            | 通過；`zod@4.6.7` 安裝至 plugins 目錄並可載入                                                                                                                               |
| 模型探索（`/model/info`）；embedding 列被略過                       | 通過                                                                                                                                                                        |
| Anthropic 協定（`/v1/messages`，含串流）經 Magpie CLI               | 通過；wire model 為 `model_name`，帶 `x-api-key`、`anthropic-version: 2023-06-01`、`x-litellm-source: magpie`                                                               |
| OpenAI 相容協定（`/v1/chat/completions`，含串流）經 Magpie CLI      | 通過                                                                                                                                                                        |
| OpenAI Responses（`/v1/responses`）                                 | 僅直接呼叫外掛 loader 通過（含串流）。經 Magpie CLI 無法選用：`magpie model api … responses` 回報 litellm 沒有 responses 端點，需在 Magpie 編輯器的 More endpoints 另外設定 |
| Quota（`magpie quota`）讀取 `/key/info`、`/user/info`、`/team/info` | 通過                                                                                                                                                                        |
| 401 金鑰失效（`auth_error` 類型）                                   | `X-Magpie-Sign-In: expired`                                                                                                                                                 |
| 401 「invalid api key」字樣                                         | `expired`                                                                                                                                                                   |
| 401 模型不可用（`model_not_found`）                                 | `X-Magpie-Sign-In: kept`                                                                                                                                                    |
| 401 內文不可判定（純文字 `Unauthorized`）                           | `X-Magpie-Sign-In: kept`                                                                                                                                                    |
| 429 含 `Retry-After: 7`                                             | 狀態與 `Retry-After` 保留；`error.message` 附上 RPM 說明與建議秒數                                                                                                          |

以上 401/429 結果來自直接呼叫外掛 loader 的 wire 測試；Magpie CLI 的 `provider test` 同樣顯示 401 訊息與 429 說明。

### 未驗證或僅由單元測試涵蓋

- **OpenCode 實際執行環境**：本機未安裝 OpenCode，未測試。
- **GitHub 遠端安裝**（`github:et84121/magpie-provider-litellm`）：尚未推送，未測試。
- **`x-litellm-session-id` 端到端**：Magpie CLI 的 `provider test` 不會帶入 `sessionID`，未經 Magpie gateway 驗證；由 `tests/plugin.test.ts` 涵蓋 Hook 本身。
- **`LITELLM_BASE_URL` 與複合 key 格式**：由程式碼與單元測試涵蓋，未在 Magpie 中實際操作。
- **401 判定規則調整（`auth_error` 不再單獨判定 expired、新增 `blocked` 字樣）**：上表的 wire 測試早於此調整，新規則只由 `tests/sign-in.test.ts` 與 `tests/fetch-interceptor.test.ts` 涵蓋。
- **401 後 Magpie 帳號的實際狀態變化**（換號、標記需重新登入）：只驗證了外掛送出的標頭。

### 已知的執行環境差異

- Bun 1.3.x 上先讀 `res.body` 再 `clone()` 會讓已整包收到的 401 內文變空；外掛改為先 `clone()` 再讀，本機 Bun 1.3.14、1.4.4 與 1.4.5 的單元測試皆確認內文完整。OpenCode 內嵌的 Bun 版本仍未實測。
- 外掛使用 `Bun.file`、`Bun.write`（`src/limits.ts`），因此只能在 Bun 下執行。
