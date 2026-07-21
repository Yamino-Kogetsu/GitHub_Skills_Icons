const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST_DIR = path.join(ROOT, 'dist');
const ICONS_DIR = path.join(ROOT, 'icons');
const MANIFEST_PATH = path.join(DIST_DIR, 'manifest.json');
const OUTPUT_PATH = path.join(DIST_DIR, 'skill-icons.svg');
const CONFIG_PATH = path.join(ROOT, 'config.json');

function env(name) {
  const value = process.env[name];
  return value == null || value === '' ? undefined : value;
}

function parseArgs(argv) {
  const result = new Map();
  const list = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < list.length; i++) {
    const arg = String(list[i]);
    if (!arg.startsWith('--')) continue;
    const stripped = arg.slice(2);
    const eq = stripped.indexOf('=');
    if (eq !== -1) {
      result.set(stripped.slice(0, eq).toLowerCase(), stripped.slice(eq + 1));
      continue;
    }
    const key = stripped.toLowerCase();
    const next = list[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      result.set(key, String(next));
      i += 1;
    } else {
      result.set(key, 'true');
    }
  }
  return result;
}

function cliArg(name, parsed) {
  const key = String(name).toLowerCase();
  return parsed.get(key) || parsed.get(key.replace(/_/g, '-')) || parsed.get(key.replace(/-/g, '_'));
}

function canonicalToken(value) {
  return String(value || '')
    .trim()
    .replace(/\.svg$/i, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

function parseInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min || i > max) return fallback;
  return i;
}

function splitRequestedIcons(value) {
  return String(value || '')
    .split(/[\s,;]+/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(canonicalToken)
    .filter(Boolean);
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}. Run npm run build first.`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function findMatchingSvgRoot(node) {
  if (!node) return null;
  if (node.type === 'element' && node.name.toLowerCase() === 'svg') return node;
  for (const child of node.children || []) {
    const found = findMatchingSvgRoot(child);
    if (found) return found;
  }
  return null;
}

function parseXml(input) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  const root = { type: 'root', children: [] };
  const stack = [root];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch !== '<') {
      let j = text.indexOf('<', i);
      if (j === -1) j = text.length;
      const value = text.slice(i, j);
      if (value) {
        stack[stack.length - 1].children.push({ type: 'text', value });
      }
      i = j;
      continue;
    }

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      const value = end === -1 ? text.slice(i + 4) : text.slice(i + 4, end);
      stack[stack.length - 1].children.push({ type: 'comment', value });
      i = end === -1 ? text.length : end + 3;
      continue;
    }

    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      const value = end === -1 ? text.slice(i + 9) : text.slice(i + 9, end);
      stack[stack.length - 1].children.push({ type: 'cdata', value });
      i = end === -1 ? text.length : end + 3;
      continue;
    }

    if (text.startsWith('<?', i)) {
      const end = findTagEnd(text, i + 2);
      const value = text.slice(i + 2, end).trim();
      stack[stack.length - 1].children.push({ type: 'pi', value });
      i = end + 1;
      continue;
    }

    if (text.startsWith('<!', i)) {
      const end = findTagEnd(text, i + 2);
      const value = text.slice(i + 2, end).trim();
      stack[stack.length - 1].children.push({ type: 'doctype', value });
      i = end + 1;
      continue;
    }

    if (text.startsWith('</', i)) {
      const end = findTagEnd(text, i + 2);
      const raw = text.slice(i + 2, end).trim();
      const name = raw.split(/\s+/)[0] || '';
      for (let s = stack.length - 1; s >= 0; s--) {
        const current = stack[s];
        if (current.type === 'element' && current.name === name) {
          stack.length = s;
          break;
        }
      }
      i = end + 1;
      continue;
    }

    const end = findTagEnd(text, i + 1);
    const raw = text.slice(i + 1, end);
    const parsed = parseStartTag(raw);
    if (!parsed.name) {
      i = end + 1;
      continue;
    }

    const node = {
      type: 'element',
      name: parsed.name,
      attrs: parsed.attrs,
      children: [],
      selfClosing: parsed.selfClosing
    };
    stack[stack.length - 1].children.push(node);
    if (!parsed.selfClosing) {
      stack.push(node);
    }
    i = end + 1;
  }

  return root.children;
}

function findTagEnd(text, start) {
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return text.length - 1;
}

function parseStartTag(raw) {
  let value = String(raw || '').trim();
  let selfClosing = false;
  if (value.endsWith('/')) {
    selfClosing = true;
    value = value.slice(0, -1).trimEnd();
  }

  const nameMatch = value.match(/^([^\s/>]+)/);
  if (!nameMatch) {
    return { name: '', attrs: [], selfClosing };
  }

  const name = nameMatch[1];
  const rest = value.slice(name.length);
  const attrs = parseAttributes(rest);
  return { name, attrs, selfClosing };
}

function parseAttributes(raw) {
  const attrs = [];
  const text = String(raw || '');
  let i = 0;

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;

    const nameStart = i;
    while (i < text.length && !/[\s=/>]/.test(text[i])) i++;
    const name = text.slice(nameStart, i);
    while (i < text.length && /\s/.test(text[i])) i++;

    let value = true;
    if (text[i] === '=') {
      i++;
      while (i < text.length && /\s/.test(text[i])) i++;
      const quote = text[i] === '"' || text[i] === "'" ? text[i] : null;
      if (quote) {
        i++;
        const valueStart = i;
        while (i < text.length && text[i] !== quote) i++;
        value = text.slice(valueStart, i);
        if (text[i] === quote) i++;
      } else {
        const valueStart = i;
        while (i < text.length && !/[\s>]/.test(text[i])) i++;
        value = text.slice(valueStart, i);
      }
    }

    if (name) {
      attrs.push({ name, value });
    }
  }

  return attrs;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function serializeNode(node) {
  switch (node.type) {
    case 'text':
      return escapeText(node.value);
    case 'cdata':
      return `<![CDATA[${node.value}]]>`;
    case 'comment':
      return `<!--${node.value}-->`;
    case 'pi':
      return `<?${node.value}?>`;
    case 'doctype':
      return `<!${node.value}>`;
    case 'element': {
      const attrText = (node.attrs || [])
        .map((attr) => {
          if (attr.value === true) return attr.name;
          return `${attr.name}="${escapeAttribute(attr.value)}"`;
        })
        .join(' ');
      const open = attrText ? `<${node.name} ${attrText}` : `<${node.name}`;
      if ((!node.children || !node.children.length) && node.name.toLowerCase() !== 'svg' && node.name.toLowerCase() !== 'style' && node.name.toLowerCase() !== 'script') {
        return `${open}/>`;
      }
      const children = (node.children || []).map(serializeNode).join('');
      return `${open}>${children}</${node.name}>`;
    }
    default:
      return '';
  }
}

function collectIds(node, ids = []) {
  if (!node || node.type !== 'element') return ids;
  for (const attr of node.attrs || []) {
    if (attr.name === 'id' && typeof attr.value === 'string' && attr.value) {
      ids.push(attr.value);
    }
  }
  for (const child of node.children || []) collectIds(child, ids);
  return ids;
}

function replaceReferences(value, idEntries) {
  let out = String(value);
  for (const [from, to] of idEntries) {
    if (from === to) continue;
    const escaped = escapeRegExp(from);
    out = out
      .replace(new RegExp(`url\\(#${escaped}\\)`, 'g'), `url(#${to})`)
      .replace(new RegExp(`\\b${escaped}\\.begin\\b`, 'g'), `${to}.begin`)
      .replace(new RegExp(`\\b${escaped}\\.end\\b`, 'g'), `${to}.end`)
      .replace(new RegExp(`(^|[^A-Za-z0-9_-])#${escaped}(?![A-Za-z0-9_-])`, 'g'), `$1#${to}`)
      .replace(new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=[\\s,;:)}\\]]|$)`, 'g'), `$1${to}`);
  }
  return out;
}

function rewriteTree(node, idEntries, ancestorNames = []) {
  if (!node) return node;

  if (node.type === 'element') {
    const nextAncestors = ancestorNames.concat(node.name.toLowerCase());
    node.attrs = (node.attrs || []).map((attr) => {
      if (attr.name === 'id' && typeof attr.value === 'string') {
        return { name: attr.name, value: replaceReferences(attr.value, idEntries) };
      }
      if (typeof attr.value === 'string') {
        return { name: attr.name, value: replaceReferences(attr.value, idEntries) };
      }
      return attr;
    });

    node.children = (node.children || []).map((child) => rewriteTree(child, idEntries, nextAncestors));
    return node;
  }

  if ((node.type === 'text' || node.type === 'cdata') && ancestorNames.includes('style')) {
    return { ...node, value: replaceReferences(node.value, idEntries) };
  }

  return node;
}

function canonicalizeViewBox(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseSize(value) {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const num = Number(raw.replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(num) ? num : undefined;
}

function inferViewBox(svgRoot) {
  const vb = svgRoot.attrs?.find((attr) => attr.name === 'viewBox' && typeof attr.value === 'string');
  if (vb && vb.value.trim()) return canonicalizeViewBox(vb.value);
  const width = svgRoot.attrs?.find((attr) => attr.name === 'width' && typeof attr.value === 'string');
  const height = svgRoot.attrs?.find((attr) => attr.name === 'height' && typeof attr.value === 'string');
  const w = parseSize(width && width.value) ?? 24;
  const h = parseSize(height && height.value) ?? 24;
  return `0 0 ${w} ${h}`;
}

function buildAttrMap(attrs) {
  const map = new Map();
  for (const attr of attrs || []) map.set(attr.name, attr.value);
  return map;
}

function createNormalizedFragment(svgSource, token, index, x, y, size) {
  const doc = parseXml(svgSource);
  const root = findMatchingSvgRoot({ type: 'root', children: doc });
  if (!root) {
    throw new Error(`Invalid SVG: missing root <svg> for ${token}`);
  }

  const ids = [...new Set(collectIds(root))];
  const idEntries = ids.map((oldId, idIndex) => [oldId, `${token}_${index}_${idIndex}`]);

  const rewritten = rewriteTree(root, idEntries, []);
  const rootAttrs = buildAttrMap(rewritten.attrs || []);

  const copiedAttrs = [];
  const excluded = new Set([
    'xmlns',
    'xmlns:xlink',
    'width',
    'height',
    'viewBox',
    'x',
    'y'
  ]);

  for (const attr of rewritten.attrs || []) {
    if (excluded.has(attr.name)) continue;
    copiedAttrs.push({ name: attr.name, value: attr.value });
  }

  const viewBox = inferViewBox(rewritten);
  const fragment = {
    type: 'element',
    name: 'svg',
    attrs: [
      { name: 'xmlns', value: 'http://www.w3.org/2000/svg' },
      { name: 'xmlns:xlink', value: 'http://www.w3.org/1999/xlink' },
      { name: 'x', value: String(x) },
      { name: 'y', value: String(y) },
      { name: 'width', value: String(size) },
      { name: 'height', value: String(size) },
      { name: 'viewBox', value: viewBox },
      { name: 'preserveAspectRatio', value: 'xMidYMid meet' },
      ...copiedAttrs
    ],
    children: rewritten.children || [],
    selfClosing: false
  };

  return serializeNode(fragment);
}

function resolveThemeFile(manifest, family, theme) {
  const candidates = [];
  if (theme === 'dark') candidates.push('dark', 'auto', 'base', 'light');
  else if (theme === 'light') candidates.push('light', 'auto', 'base', 'dark');
  else candidates.push('auto', 'base', 'dark', 'light');

  for (const key of candidates) {
    if (family.files && family.files[key]) return path.join(ICONS_DIR, family.files[key]);
  }

  const fallback = family.sourceFiles && family.sourceFiles[0];
  return fallback ? path.join(ICONS_DIR, fallback) : null;
}

function buildLookup(manifest) {
  const lookup = new Map();
  for (const family of manifest.families || []) {
    lookup.set(family.key, family.key);
  }
  for (const [alias, candidates] of Object.entries(manifest.aliases || {})) {
    lookup.set(alias, Array.isArray(candidates) ? candidates.slice() : [candidates]);
  }
  return lookup;
}

function suggestMatches(token, manifest) {
  const universe = new Set();
  for (const family of manifest.families || []) universe.add(family.key);
  for (const alias of Object.keys(manifest.aliases || {})) universe.add(alias);

  const target = canonicalToken(token);
  const scored = [];
  for (const candidate of universe) {
    const score = similarity(target, candidate);
    if (score > 0) scored.push([candidate, score]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return scored.slice(0, 5).map(([name]) => name);
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.startsWith(b) || b.startsWith(a)) return 0.92;
  const dist = levenshtein(a, b);
  const max = Math.max(a.length, b.length);
  return Math.max(0, 1 - dist / max);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function resolveCandidates(token, manifest) {
  const lookup = buildLookup(manifest);
  const canonical = canonicalToken(token);
  const raw = lookup.get(canonical);
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function loadRequestedIcons(parsedArgs, config) {
  const cliIcons = cliArg('icons', parsedArgs) || cliArg('icon', parsedArgs);
  if (cliIcons) return splitRequestedIcons(cliIcons);

  const iconEnv = env('ICON') || env('INPUT_ICON') || env('ICONS') || env('INPUT_ICONS');
  if (iconEnv) return splitRequestedIcons(iconEnv);

  if (Array.isArray(config.icons) && config.icons.length) {
    return config.icons.map(canonicalToken).filter(Boolean);
  }

  return [];
}

function loadOptionValue(parsedArgs, names, envNames, configValue) {
  for (const name of names) {
    const value = cliArg(name, parsedArgs);
    if (value != null && value !== '') return value;
  }
  for (const envName of envNames) {
    const value = env(envName);
    if (value != null && value !== '') return value;
  }
  return configValue;
}

function main() {
  const manifest = loadManifest();
  const parsedArgs = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const requested = loadRequestedIcons(parsedArgs, config);

  if (!requested.length) {
    throw new Error('No icons requested. Example: ICON=js,php,python or --icons js,php,python');
  }

  const iconSize = parseInteger(loadOptionValue(parsedArgs, ['icon-size', 'iconsize'], ['ICON_SIZE', 'INPUT_ICON_SIZE'], config.iconSize ?? 64), 64, 8, 512);
  const perLine = parseInteger(loadOptionValue(parsedArgs, ['per-line', 'perline'], ['PER_LINE', 'INPUT_PER_LINE'], config.perLine ?? 6), 6, 1, 50);
  const gapX = parseInteger(loadOptionValue(parsedArgs, ['gap-x', 'gapx'], ['GAP_X', 'INPUT_GAP_X'], config.gapX ?? 24), 24, 0, 512);
  const gapY = parseInteger(loadOptionValue(parsedArgs, ['gap-y', 'gapy'], ['GAP_Y', 'INPUT_GAP_Y'], config.gapY ?? 24), 24, 0, 512);
  const marginX = parseInteger(loadOptionValue(parsedArgs, ['margin-x', 'marginx'], ['MARGIN_X', 'INPUT_MARGIN_X'], config.marginX ?? 24), 24, 0, 1024);
  const marginY = parseInteger(loadOptionValue(parsedArgs, ['margin-y', 'marginy'], ['MARGIN_Y', 'INPUT_MARGIN_Y'], config.marginY ?? 24), 24, 0, 1024);
  const align = String(loadOptionValue(parsedArgs, ['align'], ['ALIGN', 'INPUT_ALIGN'], config.align ?? 'left')).toLowerCase();
  const theme = String(loadOptionValue(parsedArgs, ['theme'], ['THEME', 'INPUT_THEME'], config.theme ?? 'auto')).toLowerCase();

  if (!['left', 'center', 'right'].includes(align)) {
    throw new Error('ALIGN must be left, center, or right');
  }
  if (!['auto', 'dark', 'light'].includes(theme)) {
    throw new Error('THEME must be auto, dark, or light');
  }

  const resolved = [];
  const missing = [];

  for (const token of requested) {
    const candidates = resolveCandidates(token, manifest);
    let found = null;
    for (const candidate of candidates) {
      const family = (manifest.families || []).find((item) => item.key === candidate);
      if (!family) continue;
      const sourceFile = resolveThemeFile(manifest, family, theme);
      if (sourceFile && fs.existsSync(sourceFile)) {
        found = { token, family, sourceFile, svg: fs.readFileSync(sourceFile, 'utf8') };
        break;
      }
    }

    if (found) {
      resolved.push(found);
      continue;
    }

    missing.push({ token, suggestions: suggestMatches(token, manifest) });
  }

  if (missing.length) {
    const details = missing
      .map((entry) => {
        const suggestionText = entry.suggestions.length ? ` (did you mean: ${entry.suggestions.join(', ')})` : '';
        return `${entry.token}${suggestionText}`;
      })
      .join('; ');
    throw new Error(`Unknown icon(s): ${details}`);
  }

  const perRow = Math.min(perLine, Math.max(1, resolved.length));
  const rows = Math.ceil(resolved.length / perRow);
  const rowWidths = [];
  for (let row = 0; row < rows; row++) {
    const count = Math.min(perRow, resolved.length - row * perRow);
    rowWidths.push(count * iconSize + Math.max(0, count - 1) * gapX);
  }
  const maxRowWidth = Math.max(...rowWidths);
  const width = maxRowWidth + marginX * 2;
  const height = rows * iconSize + Math.max(0, rows - 1) * gapY + marginY * 2;

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="skill icons">`
  );

  resolved.forEach((item, index) => {
    const row = Math.floor(index / perRow);
    const col = index % perRow;
    const countThisRow = Math.min(perRow, resolved.length - row * perRow);
    const rowWidth = countThisRow * iconSize + Math.max(0, countThisRow - 1) * gapX;
    let xStart = marginX;
    if (align === 'center') xStart += Math.max(0, (maxRowWidth - rowWidth) / 2);
    if (align === 'right') xStart += Math.max(0, maxRowWidth - rowWidth);

    const x = xStart + col * (iconSize + gapX);
    const y = marginY + row * (iconSize + gapY);
    const prefix = `${item.token}_${index}`;
    lines.push(createNormalizedFragment(item.svg, prefix, index, x, y, iconSize));
  });

  lines.push('</svg>');

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, lines.join('\n'));
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Rendered ${resolved.length} icons at ${width}x${height} (theme=${theme}, align=${align}, perLine=${perLine})`);
}

main();
