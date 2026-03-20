export type ThemeId = 'catppuccin' | 'monochrome' | 'claude';

export interface XtermThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const XTERM_THEMES: Record<ThemeId, XtermThemeColors> = {
  catppuccin: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#585b70',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
  monochrome: {
    background: '#080808',
    foreground: '#e0e0e0',
    cursor: '#ffffff',
    selectionBackground: '#333333',
    black: '#2e2e2e',
    red: '#ff5555',
    green: '#d0d0d0',
    yellow: '#cccccc',
    blue: '#b0b0b0',
    magenta: '#c0c0c0',
    cyan: '#b8b8b8',
    white: '#aaaaaa',
    brightBlack: '#555555',
    brightRed: '#ff5555',
    brightGreen: '#e0e0e0',
    brightYellow: '#dddddd',
    brightBlue: '#c0c0c0',
    brightMagenta: '#d0d0d0',
    brightCyan: '#c8c8c8',
    brightWhite: '#999999',
  },
  claude: {
    background: '#F5F0E8',
    foreground: '#3D3429',
    cursor: '#3D3429',
    selectionBackground: '#D5CCBC',
    black: '#3D3429',
    red: '#C4533A',
    green: '#5A8A4C',
    yellow: '#B8912D',
    blue: '#DA7756',
    magenta: '#B5647A',
    cyan: '#4A9588',
    white: '#EDE6D9',
    brightBlack: '#9A8C7C',
    brightRed: '#CF6659',
    brightGreen: '#7DAA6E',
    brightYellow: '#D4A84B',
    brightBlue: '#E08A6A',
    brightMagenta: '#C97A8D',
    brightCyan: '#6AAB9E',
    brightWhite: '#F5F0E8',
  },
};

export const THEME_OPTIONS: Array<{ value: ThemeId; label: string }> = [
  { value: 'catppuccin', label: 'Catppuccin Mocha' },
  { value: 'monochrome', label: 'Monochrome' },
  { value: 'claude', label: 'Claude' },
];
