/**
 * @fileoverview LiteLLM 模型列表端點的 runtime 契約（/model/info 與 /v1/models）。
 * 規格出處：
 * - /model/info 與 model_name／litellm_params.model 的關係：https://docs.litellm.ai/docs/proxy/model_management
 * - /v1/models 回傳 data[].id、wildcard 與 discoverable：https://docs.litellm.ai/docs/proxy/model_discovery
 * - model_info.mode 的合法值（ModelInfoBase）：https://github.com/BerriAI/litellm/blob/main/litellm/types/utils.py
 * LiteLLM 對未知欄位常回傳 null，因此可選數值與字串一律 nullish；型別錯誤的 metadata 欄位視為沒有證據（catch 成 undefined），
 * 不因此丟掉整個模型。只有 model_name／id 缺失或不合法的列才會被略過。
 */

import { z } from "zod";

/** 可選的 metadata：不合型別時視為沒有證據，不讓整列失效 */
const optionalString = z.string().nullish().catch(undefined);
const optionalBoolean = z.boolean().nullish().catch(undefined);
const optionalPositive = z.number().positive().nullish().catch(undefined);
const optionalNonNegative = z.number().nonnegative().nullish().catch(undefined);

/**
 * 可作為 wire model ID 的字串：不得為空、頭尾不得有空白（wire ID 必須與 proxy 上的名稱完全一致，不做 trim），
 * 也不得含 `*`（wildcard 只是路由規則，不是可呼叫的模型）。內部空白合法：LiteLLM 接受任意 model_name 字串。
 */
export const ModelIdSchema = z
  .string()
  .min(1)
  .refine((id) => id.trim() === id && !id.includes("*"), {
    message: "模型 ID 不得為空、頭尾含空白或含 wildcard",
  });

const ModelInfoMetaSchema = z.object({
  mode: optionalString,
  base_model: optionalString,
  litellm_provider: optionalString,
  max_tokens: optionalPositive,
  max_input_tokens: optionalPositive,
  max_output_tokens: optionalPositive,
  input_cost_per_token: optionalNonNegative,
  output_cost_per_token: optionalNonNegative,
  cache_read_input_token_cost: optionalNonNegative,
  cache_creation_input_token_cost: optionalNonNegative,
  supports_function_calling: optionalBoolean,
  supports_vision: optionalBoolean,
  supports_pdf_input: optionalBoolean,
  supports_reasoning: optionalBoolean,
  supported_endpoints: z.array(z.unknown()).nullish().catch(undefined),
});

/** 單列 /model/info 項目（依 LiteLLM 文件的欄位名稱） */
export const ModelInfoRowSchema = z.object({
  model_name: ModelIdSchema,
  litellm_params: z
    .object({
      model: optionalString,
      custom_llm_provider: optionalString,
    })
    .nullish()
    .catch(undefined),
  model_info: ModelInfoMetaSchema.nullish().catch(undefined),
});

/** /v1/models 單列：OpenAI 形狀，只需要 id */
export const ModelsListRowSchema = z.object({ id: ModelIdSchema });

/** 兩個端點共用的外層信封：data 必須是陣列，其餘欄位忽略 */
export const ListEnvelopeSchema = z.object({ data: z.array(z.unknown()) });

/** 正規化後的一列；/v1/models 只有 model_name，沒有 metadata */
export type LiteLLMModelInfoEntry = z.infer<typeof ModelInfoRowSchema>;
