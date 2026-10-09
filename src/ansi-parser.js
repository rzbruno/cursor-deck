/**
 * High-performance ANSI escape sequence to HTML & plain text converter.
 * Converts terminal colors and styles to sanitized HTML spans, and strips
 * raw cursor positioning/terminal control codes for mobile-friendly log rendering.
 */

const ANSI_COLOR_MAP = {
  // Standard 8 colors
  30: 'color-black',
  31: 'color-red',
  32: 'color-green',
  33: 'color-yellow',
  34: 'color-blue',
  35: 'color-magenta',
  36: 'color-cyan',
  37: 'color-white',
  // Bright 8 colors
  90: 'color-bright-black',
  91: 'color-bright-red',
  92: 'color-bright-green',
  93: 'color-bright-yellow',
  94: 'color-bright-blue',
  95: 'color-bright-magenta',
  96: 'color-bright-cyan',
  97: 'color-bright-white',
  // Background standard
  40: 'bg-black',
  41: 'bg-red',
  42: 'bg-green',
  43: 'bg-yellow',
  44: 'bg-blue',
  45: 'bg-magenta',
  46: 'bg-cyan',
  47: 'bg-white',
  // Background bright
  100: 'bg-bright-black',
  101: 'bg-bright-red',
  102: 'bg-bright-green',
  103: 'bg-bright-yellow',
  104: 'bg-bright-blue',
  105: 'bg-bright-magenta',
  106: 'bg-bright-cyan',
  107: 'bg-bright-white'
};

const ANSI_STYLE_MAP = {
  1: 'style-bold',
  2: 'style-dim',
  3: 'style-italic',
  4: 'style-underline',
  9: 'style-strikethrough'
};

/**
 * Escape HTML special characters
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strip all ANSI escape sequences and non-printable terminal controls
 */
export function stripAnsi(str) {
  if (!str) return '';
  return String(str)
    // Strip OSC sequences (e.g. \x1b]...\x07 or \x1b]...\x1b\)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    // Strip CSI sequences (e.g. \x1b[...m, \x1b[...K, \x1b[...A)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // Strip alternative ESC sequences
    .replace(/\x1b[@-Z\\-_]/g, '')
    // Replace \r\n or standalone \r
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * Convert raw terminal output with ANSI sequences into styled, safe HTML
 */
export function ansiToHtml(raw) {
  if (!raw) return '';

  // First normalize newlines and strip non-SGR sequences (cursor moves, clears)
  let cleaned = String(raw)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*([A-Za-ln-z])/g, '') // remove all CSI except 'm' (SGR)
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  // Tokenize by ANSI color sequences: \x1b[<codes>m
  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let result = '';
  let activeClasses = new Set();
  let activeCustomStyle = '';

  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    const textSegment = cleaned.substring(lastIndex, match.index);
    if (textSegment) {
      const escaped = escapeHtml(textSegment);
      if (activeClasses.size > 0 || activeCustomStyle) {
        const classAttr = activeClasses.size > 0 ? ` class="${Array.from(activeClasses).join(' ')}"` : '';
        const styleAttr = activeCustomStyle ? ` style="${activeCustomStyle}"` : '';
        result += `<span${classAttr}${styleAttr}>${escaped}</span>`;
      } else {
        result += escaped;
      }
    }

    // Process ANSI codes
    const codeStr = match[1] || '0';
    const codes = codeStr.split(';').map(c => parseInt(c, 10) || 0);

    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];

      if (code === 0) {
        // Reset all
        activeClasses.clear();
        activeCustomStyle = '';
      } else if (ANSI_STYLE_MAP[code]) {
        activeClasses.add(ANSI_STYLE_MAP[code]);
      } else if (code === 22) {
        // Normal intensity (unbold, undim)
        activeClasses.delete('style-bold');
        activeClasses.delete('style-dim');
      } else if (code === 23) {
        activeClasses.delete('style-italic');
      } else if (code === 24) {
        activeClasses.delete('style-underline');
      } else if (code === 29) {
        activeClasses.delete('style-strikethrough');
      } else if (ANSI_COLOR_MAP[code]) {
        // Remove previous fg or bg color class
        if (code >= 30 && code <= 37 || code >= 90 && code <= 97) {
          for (const cls of Array.from(activeClasses)) {
            if (cls.startsWith('color-')) activeClasses.delete(cls);
          }
        } else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) {
          for (const cls of Array.from(activeClasses)) {
            if (cls.startsWith('bg-')) activeClasses.delete(cls);
          }
        }
        activeClasses.add(ANSI_COLOR_MAP[code]);
      } else if (code === 39) {
        // Default text color
        for (const cls of Array.from(activeClasses)) {
          if (cls.startsWith('color-')) activeClasses.delete(cls);
        }
      } else if (code === 49) {
        // Default background
        for (const cls of Array.from(activeClasses)) {
          if (cls.startsWith('bg-')) activeClasses.delete(cls);
        }
      } else if (code === 38 && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
        // 256 color foreground: 38;5;n
        const colorIndex = codes[i + 2];
        i += 2;
        activeCustomStyle += `color: var(--ansi-256-${colorIndex}, currentColor);`;
      } else if (code === 48 && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
        // 256 color background: 48;5;n
        const colorIndex = codes[i + 2];
        i += 2;
        activeCustomStyle += `background-color: var(--ansi-256-${colorIndex}, transparent);`;
      }
    }

    lastIndex = regex.lastIndex;
  }

  // Trailing text
  const remaining = cleaned.substring(lastIndex);
  if (remaining) {
    const escaped = escapeHtml(remaining);
    if (activeClasses.size > 0 || activeCustomStyle) {
      const classAttr = activeClasses.size > 0 ? ` class="${Array.from(activeClasses).join(' ')}"` : '';
      const styleAttr = activeCustomStyle ? ` style="${activeCustomStyle}"` : '';
      result += `<span${classAttr}${styleAttr}>${escaped}</span>`;
    } else {
      result += escaped;
    }
  }

  return result;
}
