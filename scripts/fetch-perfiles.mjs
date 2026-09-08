#!/usr/bin/env node
/**
 * Recolecta noticias recientes (Google News RSS) para cada perfil político
 * que aparece en las burbujas interactivas de la portada.
 *
 * El Dr. Carlos Palma Marín NO se incluye aquí: su perfil ya existe de forma
 * estática en index.html y no debe alterarse ni generarse automáticamente.
 *
 * Uso: node scripts/fetch-perfiles.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGoogleNewsRss, decodeEntities } from './fetch-news.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const GOOGLE_NEWS_BASE = 'https://news.google.com/rss/search';
const ITEMS_PER_PERFIL = 8;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_CONCURRENT_REQUESTS = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; ClaveMXNewsBot/1.0; +https://github.com/Palma007/CLAVE-MX)';

// Debe coincidir con los ids usados en PERFILES_CONFIG dentro de index.html.
const PERFILES = [
  { id: 'claudia-sheinbaum', query: '"Claudia Sheinbaum"' },
  { id: 'omar-garcia-harfuch', query: '"Omar García Harfuch"' },
  { id: 'ricardo-salinas-pliego', query: '"Ricardo Salinas Pliego"' },
  { id: 'hugo-eric-flores', query: '"Hugo Eric Flores"' },
  { id: 'donald-trump', query: '"Donald Trump" México' },
  { id: 'marco-rubio', query: '"Marco Rubio" México' },
];

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

async function fetchPerfil(perfil) {
  const url = `${GOOGLE_NEWS_BASE}?q=${encodeURIComponent(perfil.query)}&hl=es-419&gl=MX&ceid=MX:es`;
  try {
    const xml = await limit(() => fetchWithTimeout(url, REQUEST_TIMEOUT_MS));
    const items = parseGoogleNewsRss(xml)
      .slice(0, ITEMS_PER_PERFIL)
      .map((it) => ({ ...it, source: it.source ? decodeEntities(it.source) : '' }));
    return { id: perfil.id, updatedAt: new Date().toISOString(), status: 'ok', items };
  } catch (err) {
    return { id: perfil.id, updatedAt: new Date().toISOString(), status: 'error', error: String(err.message || err), items: [] };
  }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const results = await Promise.all(PERFILES.map(fetchPerfil));

  const perfiles = {};
  for (const r of results) {
    perfiles[r.id] = { updatedAt: r.updatedAt, status: r.status, items: r.items };
  }

  const output = { updatedAt: new Date().toISOString(), perfiles };
  await writeFile(path.join(DATA_DIR, 'perfiles-politicos.json'), JSON.stringify(output, null, 2));

  const total = results.reduce((sum, r) => sum + r.items.length, 0);
  const failed = results.filter((r) => r.status !== 'ok');
  console.log(`OK: ${total} notas recolectadas para ${results.length} perfiles.`);
  if (failed.length) {
    console.log(`Perfiles con error (${failed.length}):`, failed.map((f) => `${f.id}: ${f.error}`).join(' | '));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fallo general en fetch-perfiles:', err);
    process.exit(1);
  });
}
