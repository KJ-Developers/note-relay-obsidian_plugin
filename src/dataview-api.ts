export type DataviewApi = {
  tryQueryMarkdown: (query: string, origin: string, settings: { allowHtml: boolean }) => Promise<string>;
};

export function installedDataview(app: unknown): DataviewApi | null {
  if (!app || typeof app !== 'object') return null;
  const plugins = (app as { plugins?: { plugins?: Record<string, { api?: unknown }> } }).plugins?.plugins;
  const api = plugins?.dataview?.api as Partial<DataviewApi> | undefined;
  return typeof api?.tryQueryMarkdown === 'function' ? api as DataviewApi : null;
}
