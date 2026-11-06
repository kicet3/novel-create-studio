/**
 * TanStack Query key factory. Keys are hierarchical so a mutation can invalidate a whole novel
 * (`queryKeys.novel(id).all`) or one screen (`queryKeys.novel(id).tasks()`).
 * v1 live invalidation (FR-UI-08) maps activity `action` prefixes onto these keys.
 */
export const queryKeys = {
  health: ["health"] as const,
  novels: {
    all: ["novels"] as const,
    list: () => ["novels", "list"] as const,
  },
  novel: (novelId: string) => {
    const all = ["novels", novelId] as const;
    return {
      all,
      detail: () => [...all, "detail"] as const,
      home: () => [...all, "home"] as const,
      concept: () => [...all, "concept"] as const,
      cast: () => [...all, "cast"] as const,
      world: () => [...all, "world"] as const,
      structure: () => [...all, "structure"] as const,
      tasks: (filter?: Record<string, unknown>) => [...all, "tasks", filter ?? {}] as const,
      inbox: (filter?: Record<string, unknown>) => [...all, "inbox", filter ?? {}] as const,
      question: (questionId: string) => [...all, "questions", questionId] as const,
      episodes: () => [...all, "episodes"] as const,
      episode: (episodeNo: number) => [...all, "episodes", episodeNo] as const,
      entities: (filter?: Record<string, unknown>) => [...all, "entities", filter ?? {}] as const,
      entity: (entityId: string) => [...all, "entities", "detail", entityId] as const,
      setups: (filter?: Record<string, unknown>) => [...all, "setups", filter ?? {}] as const,
      activity: (filter?: Record<string, unknown>) => [...all, "activity", filter ?? {}] as const,
      settings: () => [...all, "settings"] as const,
    };
  },
  installSettings: ["settings", "install"] as const,
};
