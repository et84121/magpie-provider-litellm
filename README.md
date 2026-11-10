# magpie-provider-litellm

Magpie 原生 LiteLLM Proxy Provider 外掛。

讓任何 AI Coding Agent（Claude Code、Codex、OpenCode、Gemini CLI 等）透過 [Magpie](https://usemagpie.ai/) 使用自建或託管的 [LiteLLM](https://docs.litellm.ai/) 代理，支援**原生模型協定路由**、**動態模型探索**與**用量預算監控**。

---

## 核心特色

### 1. 原生協定路由（零雙重轉譯損耗）
- **Claude 系列模型**：自動指派 `@ai-sdk/anthropic` 協定，直接與 LiteLLM 的 `/v1/messages` 端點對話。
  - 當 Agent 為 **Claude Code** 時，純原生 Anthropic Messages 直通，完整保留 **Extended Thinking（思考過程）**、**Thought Signature** 與原生 **Tool Use** 結構。
  - 當 Agent 為 **Codex** 時，由 Magpie Gateway 負責將 Responses 轉為 Messages 協定，避免 LiteLLM 再次轉譯。
- **通用與開源模型**：DeepSeek、Qwen、Kimi、GLM、Llama 等自動走 `@ai-sdk/openai-compatible`，直達 LiteLLM 的 `/v1/chat/completions`。

### 2. 階層式模型動態探索
- **第一優先**：查詢 LiteLLM `/model/info`，精準解析 Context Window、Output Limit、定價資訊（每百萬 Token）、Tool Call、Reasoning 與 Vision 支援。
- **自動降級**：若 `/model/info` 無權限或為舊版，自動退回標準 `/v1/models`。
- **快取保全**：網路暫態失敗時保留既有模型列表，不中斷當前對話。

### 3. 雙重認證標頭補全
- 每次請求同時注入 `Authorization: Bearer <KEY>` 與 `x-api-key: <KEY>`。
- 解決走 Anthropic 協定時 LiteLLM Proxy 虛擬金鑰（Virtual Key）因 Header 不一致被拒絕認證的問題。

### 4. Magpie Quota 預算與花費監控
- 實作 Magpie 原生 `auth.usage` Hook，定期向 LiteLLM `/key/info` 取得花費金額（spend）、預算上限（max_budget）與重置週期。
- 支援於 Magpie 桌面端 Quota 卡片與 `magpie quota` 命令列中直觀檢視。

### 5. 健全的容錯與工作階段追蹤
- 精準識別 HTTP 401：金鑰過期標記 `expired` 觸發 Magpie 自動換號輪詢；特定模型未部署則標記 `kept` 避免誤停權。
- 自動將 Magpie 對話 `sessionID` 注入至 `x-litellm-session-id`，利於 LiteLLM 控制台審計。

---

## 安裝方式

Magpie 內建 Bun 執行環境，直接指向本專案原始碼目錄即可載入，無須事先編譯或安裝相依套件：

```bash
# 1. 將本地目錄加入 Magpie
magpie plugin add /Users/jimmyctchang/Code/magpie-provider-litellm

# 2. 檢視安裝狀態
magpie plugin
```

---

## 設定與登入

執行互動式登入命令：

```bash
magpie plugin login litellm
```

終端機會顯示輸入提示：
1. **LiteLLM Base URL**：輸入你的 LiteLLM 網址，例如 `http://127.0.0.1:4000` 或 `https://litellm.internal.example.com`（自動相容含或不含 `/v1`）。
2. **LiteLLM API Key**：輸入 Virtual Key 或 Master Key（以密碼遮罩輸入）。

外掛會自動探測 `/key/info` 驗證連線，並將帳號 ID 綁定為該 Key 的名稱或使用者 ID（支援多帳號共存與自動容錯輪詢）。

---

## 驗證與使用

```bash
# 測試連線與預設模型
magpie provider test litellm

# 測試 Claude 原生協定模型
magpie provider test litellm claude-3-7-sonnet

# 查看 LiteLLM 額度與花費
magpie quota
```

---

## 在 Coding Agents 中使用

登入完成後，LiteLLM 上的所有模型即可直接指派給各 Agent：

- **Claude Code**：模型設為 `litellm/claude-3-7-sonnet` 或 `litellm/deepseek-chat`。
- **Codex**：設定 `[model_providers]` 或於 Magpie GUI 切換為 `litellm/<model-name>`。
- **OpenCode**：直接於 `opencode.json` 或介面中選用 `litellm/<model-name>`。

---

## 本地測試

本專案使用 Bun 原生測試器（相容 Magpie 執行環境）：

```bash
cd /Users/jimmyctchang/Code/magpie-provider-litellm
bun test
```
