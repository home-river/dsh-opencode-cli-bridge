import type { DshLlmModelReasoningInfo, DshLlmReasoningEffortInfo } from "./dsh-types.js";

export interface CatalogModel {
  id: string;
  name: string;
  description?: string;
}

/** 解析 `opencode models` 输出：一行一个 provider/model id（2026-10-17 实测）。 */
export function parseModelsOutput(stdout: string): CatalogModel[] {
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const id = raw.trim();
    if (id === "" || !id.includes("/")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: id });
  }
  return out;
}

/** 目录失败时的静态保底（已实测可调用）。 */
export const STATIC_MODELS: readonly CatalogModel[] = [
  { id: "opencode/mimo-v2.6-flash-free", name: "MiMo v2.6 Flash (free)" },
];

/** 目录与真实可用性有漂移：任何来源的结果都并入已验证模型。 */
export function mergeVerified(models: readonly CatalogModel[]): CatalogModel[] {
  const out = [...models];
  const seen = new Set(out.map((m) => m.id));
  for (const model of STATIC_MODELS) {
    if (!seen.has(model.id)) out.push({ ...model });
    seen.add(model.id);
  }
  return out;
}

export function toModelInfo(
  provider: string,
  model: CatalogModel,
): { provider: string; id: string; name: string; description?: string; inputModalities: readonly string[] } {
  return {
    provider,
    id: model.id,
    name: model.name,
    description: model.description,
    inputModalities: ["text"],
  };
}

/**
 * 向 DSH 声明的思考强度档位（ISSUE-003 问题 2 决策修订，2026-10-18）：
 * 声明 `reasoning.efforts` 并把 `GenerateOptions.reasoningEffort` 透传给
 * `opencode run --variant`（`off` 除外）。不声明会让 DSH 0.2.1 的
 * `resolveCallWithInfo` 在 provider I/O 前对携带 effort 的请求抛
 * `UNSUPPORTED_REASONING_EFFORT`（agent loop 的 prepareCall / UI 模型选择 /
 * headless API 全部命中，`llm/stream` waterfall 拦不住这些路径）。
 * ⚠️ 诚实边界：`opencode run --variant` 对任意档位静默接受、CLI 不校验；
 * 模型是否响应因 provider 而异（`mimo-v2.6-flash-free` 2026-10-17 实测不响应）。
 * 档位清单取 `--variant` 词汇（minimal/high/max）+ DSH 生态常用 id（off/low/medium）。
 * 不设 `defaultEffort`：请求不带 effort 时不注入任何默认值。
 */
export const REASONING_EFFORTS: readonly DshLlmReasoningEffortInfo[] = [
  { id: "off", name: "关闭", description: "不开启思考强度（不传 --variant）" },
  { id: "minimal", name: "Minimal", description: "透传 opencode run --variant minimal；模型是否响应待实测" },
  { id: "low", name: "低", description: "透传 opencode run --variant low；模型是否响应待实测" },
  { id: "medium", name: "中", description: "透传 opencode run --variant medium；模型是否响应待实测" },
  { id: "high", name: "高", description: "透传 opencode run --variant high；模型是否响应待实测" },
  { id: "max", name: "最高", description: "透传 opencode run --variant max；模型是否响应待实测" },
];

/** resolveModel / prepareCall 返回面：`LlmModelInfo` + reasoning 元数据（LlmResolvedModelInfo）。 */
export type ResolvedModelInfo = ReturnType<typeof toModelInfo> & { reasoning: DshLlmModelReasoningInfo };

/** 每次返回新副本，避免共享可变状态被运行时或调用方改动。 */
export function modelReasoningInfo(): DshLlmModelReasoningInfo {
  return { efforts: REASONING_EFFORTS.map((e) => ({ ...e })) };
}

/** reasoningEffort → `opencode run --variant` 参数值；`off` 与缺省不传。 */
export function variantForEffort(effort: string | undefined): string | undefined {
  if (effort === undefined || effort === "off") return undefined;
  return effort;
}
