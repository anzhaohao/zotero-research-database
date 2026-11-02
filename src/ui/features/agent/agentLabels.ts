import type { MinerUProfile } from "../../../services/mineru";

export function mineruModeLabel(mode: MinerUProfile["mode"]): string {
  if (mode === "official-api") return "MinerU 网页 API";
  return "Docker / 本地 API";
}
