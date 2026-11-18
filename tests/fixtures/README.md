# 預算測試 fixtures

來源：2026-11 對兩個實機 LiteLLM proxy（正式、測試）以 virtual key 呼叫 `/key/info`、`/user/info`、`/team/info` 的回傳，脫敏後保存。

脫敏規則：
- 只保留預算相關欄位（spend、max_budget、budget_duration、budget_reset_at、budget_limits、model_max_budget(_usage)、rpm/tpm）與成員預算表。
- 所有 user_id 以一致假值（`member-N`）取代，**保留重疊關係**：同一人在名單與 membership 中是同一個假值。
- `team_id` 為 `REDACTED`；`keys`、`teams` 等含 token 雜湊與 email 的陣列整段移除。
- 無 email、token、主機名、key 別名、UUID。

已知實機情境（測試依此驗證）：
- key 與 user 的 `user_id` 都是 `member-10`，與 `test-team-info.json` 的 `key_user_id` 一致（測試會檢查這個對應）。
- `member-10` 在 `members_with_roles` 內，但不在 `team_memberships` 內：名單與關係表不同步，且團隊沒有成員預設上限，所以不顯示成員層。
- `member-1` 到 `member-8` 在 `team_memberships` 內，`max_budget` 皆為 null（成員無個別上限），團隊也沒有預設上限，所以同樣不顯示成員層。
