import type { Appearance } from './protocol';

export const appearanceColors = [
  '--background-primary', '--background-secondary', '--background-secondary-alt',
  '--background-primary-alt', '--background-modifier-border', '--background-modifier-border-hover',
  '--background-modifier-form-field', '--text-normal', '--text-muted', '--text-faint',
  '--text-accent', '--text-accent-hover', '--interactive-accent', '--interactive-accent-hover',
  '--table-border-color', '--table-header-bg', '--table-row-bg', '--table-row-alt-bg',
  '--checkbox-color', '--checkbox-marker-color', '--blockquote-border-color',
  '--blockquote-background-color', '--h1-color', '--h2-color', '--h3-color',
] as const;

export const appearanceFonts = ['--font-text', '--font-interface', '--font-monospace'] as const;

export function safeColor(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const color = value.trim();
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) return color.toLowerCase();
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d{1,3}))?\s*\)$/i.exec(color);
  if (!rgb) return null;
  const channels = rgb.slice(1).map(Number);
  if (channels.slice(0, 3).some(channel => channel > 255)) return null;
  const alpha = rgb[4] === undefined ? '' : Math.round(Number(rgb[4]) * 255).toString(16).padStart(2, '0');
  return `#${channels.slice(0, 3).map(channel => channel.toString(16).padStart(2, '0')).join('')}${alpha}`;
}

export function safeFont(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 160) return null;
  const font = value.trim();
  if (!font || !/^[a-zA-Z0-9 _,'"-]+$/.test(font)) return null;
  if ((font.match(/'/g)?.length ?? 0) % 2 || (font.match(/"/g)?.length ?? 0) % 2) return null;
  return font;
}

export function safeAppearance(input: unknown): Appearance {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const supplied = source.tokens && typeof source.tokens === 'object' && !Array.isArray(source.tokens)
    ? source.tokens as Record<string, unknown> : {};
  const tokens: Record<string, string> = {};
  for (const name of appearanceColors) {
    const color = safeColor(supplied[name]);
    if (color) tokens[name] = color;
  }
  for (const name of appearanceFonts) {
    const font = safeFont(supplied[name]);
    if (font) tokens[name] = font;
  }
  return { mode: source.mode === 'dark' ? 'dark' : 'light', tokens };
}
