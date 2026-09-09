import { ResearchRepository } from "./repository";

let pluginRepository: ResearchRepository | undefined;

/** One repository per loaded plugin instance, shared by windows and services. */
export function getResearchRepository(): ResearchRepository {
  return (pluginRepository ??= new ResearchRepository());
}

/** Release cached Zotero item identity when the plugin shuts down. */
export function resetResearchRepositoryScope(): void {
  pluginRepository = undefined;
}
