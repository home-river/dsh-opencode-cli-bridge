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
