#!/usr/bin/env node
/**
 * Consulta Google News (RSS, sin API key) filtrado por dominio para cada medio
 * configurado y genera los JSON que consume la web en /data.
 *
 * Google News RSS es el mecanismo elegido porque es estable y funciona igual
 * para todos los medios, incluso aquellos que discontinuaron su propio feed
 * RSS (p. ej. Reuters, AP, Washington Post) o que no publican uno.
 *
 * Uso: node scripts/fetch-news.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const GOOGLE_NEWS_BASE = 'https://news.google.com/rss/search';
const ITEMS_PER_SOURCE = 6;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_CONCURRENT_REQUESTS = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; ClaveMXNewsBot/1.0; +https://github.com/Palma007/CLAVE-MX)';

// Limita cuántas solicitudes a Google News corren en paralelo, para no
// disparar 27 peticiones simultáneas desde la misma IP del runner.
function createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= maxConcurrent || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

const limit = createLimiter(MAX_CONCURRENT_REQUESTS);

// ---------------------------------------------------------------------------
// Configuración de medios por bloque
// ---------------------------------------------------------------------------

const NACIONAL = [
  { name: 'El Universal', domain: 'eluniversal.com.mx' },
  { name: 'Milenio', domain: 'milenio.com' },
  { name: 'Reforma', domain: 'reforma.com' },
  { name: 'Excélsior', domain: 'excelsior.com.mx' },
  { name: 'El Financiero', domain: 'elfinanciero.com.mx' },
  { name: 'El Economista', domain: 'eleconomista.com.mx' },
  { name: 'Proceso', domain: 'proceso.com.mx' },
  { name: 'Animal Político', domain: 'animalpolitico.com' },
  { name: 'Aristegui Noticias', domain: 'aristeguinoticias.com' },
];

const INTERNACIONAL = [
  { name: 'BBC Mundo', domain: 'bbc.com/mundo' },
  { name: 'CNN en Español', domain: 'cnnespanol.cnn.com' },
  { name: 'Reuters', domain: 'reuters.com' },
  { name: 'Associated Press', domain: 'apnews.com' },
  { name: 'The New York Times', domain: 'nytimes.com' },
  { name: 'The Washington Post', domain: 'washingtonpost.com' },
  { name: 'The Guardian', domain: 'theguardian.com' },
  { name: 'El País', domain: 'elpais.com' },
  { name: 'France 24', domain: 'france24.com/es' },
  { name: 'Deutsche Welle', domain: 'dw.com/es' },
];

const REGIONAL_LOCAL_TEHUACAN = [
  { name: 'Primera Línea', domain: 'primeralinea.com.mx' },
  { name: 'Noticias Tehuacán', domain: 'noticiastehuacan.com' },
  { name: 'El Uno', domain: 'diarioelunodetehuacan.com' },
  { name: 'Municipios Puebla (Tehuacán)', domain: 'municipiospuebla.mx', extraTerm: 'Tehuacán' },
];

const REGIONAL_ESTATAL_PUEBLA = [
  { name: 'El Sol de Puebla', domain: 'oem.com.mx/elsoldepuebla' },
  { name: 'Diario Cambio', domain: 'diariocambio.com.mx' },
  { name: 'E-consulta', domain: 'e-consulta.com' },
  { name: 'La Jornada de Oriente', domain: 'lajornadadeoriente.com.mx' },
  { name: 'Intolerancia Diario', domain: 'intoleranciadiario.com' },
  { name: 'Periódico Central', domain: 'periodicocentral.mx' },
  { name: 'Ambas Manos', domain: 'ambasmanos.mx' },
  { name: '24 Horas Puebla', domain: '24horaspuebla.com' },
];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

export function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function stripHtml(str) {
  // El texto de <description> suele venir con doble escape: el XML escapa
  // una cadena que ya es HTML (con sus propias entidades). Se decodifica,
  // se quitan las etiquetas y se vuelve a decodificar por si quedaron
  // entidades anidadas (p. ej. "&amp;nbsp;").
  const onceDecoded = decodeEntities(str || '');
  const withoutTags = onceDecoded.replace(/<[^>]*>/g, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

export function parseGoogleNewsRss(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const rawTitle = extractTag(block, 'title');
    const link = extractTag(block, 'link').trim();
    const pubDate = extractTag(block, 'pubDate').trim();
    const description = stripHtml(extractTag(block, 'description'));
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const source = sourceMatch ? decodeEntities(sourceMatch[1]) : '';
    let title = decodeEntities(rawTitle);
    const suffix = ` - ${source}`;
    if (source && title.endsWith(suffix)) {
      title = title.slice(0, -suffix.length).trim();
    }
    if (!title || !link) continue;
    items.push({ title, link, pubDate, description, source });
  }
  return items;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/rss+xml, application/xml, text/xml' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSource(source) {
  const query = source.extraTerm ? `site:${source.domain} ${source.extraTerm}` : `site:${source.domain}`;
  const url = `${GOOGLE_NEWS_BASE}?q=${encodeURIComponent(query)}&hl=es-419&gl=MX&ceid=MX:es`;
  try {
    const xml = await limit(() => fetchWithTimeout(url, REQUEST_TIMEOUT_MS));
    const items = parseGoogleNewsRss(xml).slice(0, ITEMS_PER_SOURCE).map((it) => ({
      ...it,
      source: it.source || source.name,
      outlet: source.name,
      domain: source.domain,
    }));
    return { name: source.name, domain: source.domain, status: 'ok', count: items.length, items };
  } catch (err) {
    return { name: source.name, domain: source.domain, status: 'error', error: String(err.message || err), count: 0, items: [] };
  }
}

function sortByDateDesc(items) {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.pubDate) || 0;
    const tb = Date.parse(b.pubDate) || 0;
    return tb - ta;
  });
}

async function buildBlock(sources, group) {
  const results = await Promise.all(sources.map(fetchSource));
  const items = sortByDateDesc(results.flatMap((r) => (group ? r.items.map((it) => ({ ...it, group })) : r.items)));
  return {
    updatedAt: new Date().toISOString(),
    sources: results.map(({ items: _items, ...meta }) => meta),
    items,
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const [nacional, internacional, regionalLocal, regionalEstatal] = await Promise.all([
    buildBlock(NACIONAL),
    buildBlock(INTERNACIONAL),
    buildBlock(REGIONAL_LOCAL_TEHUACAN, 'local'),
    buildBlock(REGIONAL_ESTATAL_PUEBLA, 'estatal'),
  ]);

  const regional = {
    updatedAt: new Date().toISOString(),
    sources: [...regionalLocal.sources, ...regionalEstatal.sources],
    items: sortByDateDesc([...regionalLocal.items, ...regionalEstatal.items]),
  };

  await writeFile(path.join(DATA_DIR, 'noticias-nacional.json'), JSON.stringify(nacional, null, 2));
  await writeFile(path.join(DATA_DIR, 'noticias-internacional.json'), JSON.stringify(internacional, null, 2));
  await writeFile(path.join(DATA_DIR, 'noticias-regional.json'), JSON.stringify(regional, null, 2));

  const totalItems = nacional.items.length + internacional.items.length + regional.items.length;
  const failed = [...nacional.sources, ...internacional.sources, ...regional.sources].filter((s) => s.status !== 'ok');
  console.log(`OK: ${totalItems} notas recolectadas.`);
  if (failed.length) {
    console.log(`Fuentes con error (${failed.length}):`, failed.map((f) => `${f.name}: ${f.error}`).join(' | '));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fallo general en fetch-news:', err);
    process.exit(1);
  });
}
