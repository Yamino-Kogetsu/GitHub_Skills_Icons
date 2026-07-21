const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ICONS_DIR = path.join(ROOT, 'icons');
const DIST_DIR = path.join(ROOT, 'dist');
const MANIFEST_PATH = path.join(DIST_DIR, 'manifest.json');
const CUSTOM_ALIASES_PATH = path.join(ROOT, 'aliases.json');

function canonicalToken(value) {
  return String(value || '')
    .trim()
    .replace(/\.svg$/i, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

function stripThemeSuffix(name) {
  return String(name || '').replace(/(?:[-_ ]?)(dark|light|auto)$/i, '');
}

function detectTheme(name) {
  const match = String(name || '').match(/(?:[-_ ]?)(dark|light|auto)$/i);
  return match ? match[1].toLowerCase() : 'base';
}

function scanSvgFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current, rel = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const nextRel = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(abs, nextRel);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.svg')) {
        out.push(nextRel.split(path.sep).join('/'));
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.localeCompare(b));
}

function splitWords(value) {
  const cleaned = String(value || '')
    .replace(/\.svg$/i, '')
    .replace(/(?:[-_ ]?)(dark|light|auto)$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned.split(/\s+/).filter(Boolean);
}

function aliasFormsFromName(value) {
  const words = splitWords(value).map((word) => word.toLowerCase());
  if (!words.length) return [];

  const forms = new Set();
  const joined = words.join('');
  forms.add(joined);
  if (words.length > 1) {
    forms.add(words.join('-'));
    forms.add(words.join('_'));
    forms.add(words.join(' '));
  }
  return [...forms].map(canonicalToken).filter(Boolean);
}

function loadCustomAliases() {
  if (!fs.existsSync(CUSTOM_ALIASES_PATH)) return {};
  const raw = fs.readFileSync(CUSTOM_ALIASES_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const out = {};
  for (const [alias, target] of Object.entries(parsed)) {
    const aliasToken = canonicalToken(alias);
    if (!aliasToken) continue;

    const values = Array.isArray(target) ? target : [target];
    const candidates = values.map(canonicalToken).filter(Boolean);
    if (!candidates.length) continue;

    out[aliasToken] = [...new Set(candidates)];
  }
  return out;
}

function addAlias(map, alias, target) {
  const key = canonicalToken(alias);
  const value = canonicalToken(target);
  if (!key || !value) return;
  if (!map[key]) map[key] = [];
  if (!map[key].includes(value)) map[key].push(value);
}

function main() {
  if (!fs.existsSync(ICONS_DIR)) {
    throw new Error(`icons directory not found: ${ICONS_DIR}`);
  }

  const files = scanSvgFiles(ICONS_DIR);
  const families = new Map();
  const aliases = {};

  for (const relativeFile of files) {
    const rawBase = path.basename(relativeFile, '.svg');
    const familyKey = canonicalToken(stripThemeSuffix(rawBase));
    const theme = detectTheme(rawBase);
    if (!familyKey) continue;

    if (!families.has(familyKey)) {
      families.set(familyKey, {
        key: familyKey,
        files: {},
        sourceFiles: []
      });
    }

    const family = families.get(familyKey);
    family.sourceFiles.push(relativeFile);
    family.files[theme] = relativeFile;

    addAlias(aliases, familyKey, familyKey);
    for (const form of aliasFormsFromName(rawBase)) {
      addAlias(aliases, form, familyKey);
    }
  }

  const customAliases = loadCustomAliases();
  for (const [alias, candidates] of Object.entries(customAliases)) {
    aliases[alias] = [...new Set([...(aliases[alias] || []), ...candidates])];
  }

  const manifest = {
    version: 6,
    generatedAt: 'deterministic',
    iconsDir: 'icons',
    families: [...families.values()].sort((a, b) => a.key.localeCompare(b.key)),
    aliases,
    files
  };

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${MANIFEST_PATH}`);
  console.log(`Indexed ${files.length} SVG files across ${families.size} icon families`);
}

main();
