#!/usr/bin/env node
// Signal — daily digest scraper.
//
// Runs in GitHub Actions (or locally) where it has full internet access.
// It pulls each tracked leader's YouTube channel RSS feeds (no API key
// required), scans a set of third-party "watch" channels (conferences,
// podcasts) for any tracked leader, classifies every video as a
// Keynote / Speech / Press / Interview / Talk, and writes data/digest.json
// which the static front-end reads.
//
// Usage:
//   node scripts/scrape.mjs            # scrape and write data/digest.json
//   node scripts/scrape.mjs --self-test  # offline parser sanity check

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONFIG_PATH = join(ROOT, 'config', 'leaders.json');
const OUT_PATH = join(ROOT, 'data', 'digest.json');

const UA =
  'Mozilla/5.0 (compatible; SignalDigestBot/1.0; +https://github.com/topics/youtube-rss)';

// ─── tiny helpers ────────────────────────────────────────────────────────────

function decodeEntities(s = '') {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&'); // last, so we don't double-decode
}

async function fetchText(url, { timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ─── channel handle → channelId resolution ──────────────────────────────────

const handleCache = new Map();

async function resolveChannelId(ref) {
  // Already a channel ID.
  if (/^UC[\w-]{20,}$/.test(ref)) return ref;
  const key = ref.toLowerCase();
  if (handleCache.has(key)) return handleCache.get(key);

  const handle = ref.startsWith('@') ? ref : '@' + ref;
  const html = await fetchText(`https://www.youtube.com/${handle}`);
  const id =
    html.match(/"externalId":"(UC[\w-]+)"/)?.[1] ||
    html.match(/"channelId":"(UC[\w-]+)"/)?.[1] ||
    html.match(/channel\/(UC[\w-]+)/)?.[1] ||
    null;
  if (!id) throw new Error(`could not resolve channel id for ${ref}`);
  handleCache.set(key, id);
  return id;
}

// ─── RSS (Atom) parsing ──────────────────────────────────────────────────────

function parseFeed(xml) {
  const entries = [];
  const blocks = xml.split('<entry>').slice(1);
  for (const raw of blocks) {
    const block = raw.split('</entry>')[0];
    const videoId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    if (!videoId) continue;
    const title = decodeEntities(block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || '');
    const published = block.match(/<published>([^<]+)<\/published>/)?.[1] || null;
    const author = decodeEntities(
      block.match(/<author>[\s\S]*?<name>([^<]+)<\/name>/)?.[1]?.trim() || ''
    );
    const description = decodeEntities(
      block.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1]?.trim() || ''
    );
    entries.push({ videoId, title, published, author, description });
  }
  return entries;
}

async function fetchChannelVideos(channelId) {
  const xml = await fetchText(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
  );
  return parseFeed(xml);
}

// ─── classification ──────────────────────────────────────────────────────────

function classify(text, rules) {
  const hay = text.toLowerCase();
  for (const [label, words] of Object.entries(rules)) {
    if (words.some((w) => hay.includes(w.toLowerCase()))) return label;
  }
  return 'Talk';
}

function aliasInText(aliases, text) {
  const hay = text.toLowerCase();
  return aliases.some((a) => hay.includes(a.toLowerCase()));
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const lookbackMs = (cfg.lookbackDays || 45) * 86400000;
  const cutoff = Date.now() - lookbackMs;
  const maxPer = cfg.maxPerChannel || 15;

  const byVideo = new Map(); // videoId -> record (dedup)
  const warnings = [];

  const addVideo = (leader, entry, sourceName) => {
    if (!entry.published) return;
    if (new Date(entry.published).getTime() < cutoff) return;
    if (byVideo.has(entry.videoId)) return;
    byVideo.set(entry.videoId, {
      videoId: entry.videoId,
      leaderId: leader.id,
      leaderName: leader.name,
      title: entry.title,
      published: entry.published,
      source: sourceName,
      type: classify(`${entry.title} ${entry.description}`, cfg.classify || {}),
      thumb: `https://i.ytimg.com/vi/${entry.videoId}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${entry.videoId}`,
    });
  };

  // 1) Each leader's own / company channels — include every recent video.
  for (const leader of cfg.leaders) {
    for (const ch of leader.channels || []) {
      try {
        const channelId = await resolveChannelId(ch);
        const vids = (await fetchChannelVideos(channelId)).slice(0, maxPer);
        let added = 0;
        for (const v of vids) {
          const before = byVideo.size;
          addVideo(leader, v, v.author || ch);
          if (byVideo.size > before) added++;
        }
        console.log(`✓ ${leader.name} · ${ch} (${channelId}) → ${added} recent`);
      } catch (e) {
        warnings.push(`${leader.name} · ${ch}: ${e.message}`);
        console.warn(`⚠ ${leader.name} · ${ch}: ${e.message}`);
      }
    }
  }

  // 2) Third-party watch channels — attribute videos to a leader by alias.
  for (const wc of cfg.watchChannels || []) {
    const ref = wc.handle || wc.id;
    try {
      const channelId = await resolveChannelId(ref);
      const vids = (await fetchChannelVideos(channelId)).slice(0, maxPer);
      let matched = 0;
      for (const v of vids) {
        const text = `${v.title} ${v.description}`;
        const leader = cfg.leaders.find((l) => aliasInText(l.aliases || [l.name], text));
        if (!leader) continue;
        const before = byVideo.size;
        addVideo(leader, v, wc.name || ref);
        if (byVideo.size > before) matched++;
      }
      console.log(`✓ watch · ${wc.name || ref} (${channelId}) → ${matched} matched`);
    } catch (e) {
      warnings.push(`watch · ${wc.name || ref}: ${e.message}`);
      console.warn(`⚠ watch · ${wc.name || ref}: ${e.message}`);
    }
  }

  const videos = [...byVideo.values()].sort(
    (a, b) => new Date(b.published) - new Date(a.published)
  );

  const digest = {
    generatedAt: new Date().toISOString(),
    lookbackDays: cfg.lookbackDays || 45,
    leaders: cfg.leaders.map(({ id, name, title, color }) => ({ id, name, title, color })),
    videos,
    warnings,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(digest, null, 2) + '\n');
  console.log(
    `\nWrote ${videos.length} videos for ${digest.leaders.length} leaders → data/digest.json`
  );
  if (warnings.length) console.log(`(${warnings.length} channel warning(s))`);
}

// ─── offline self-test ───────────────────────────────────────────────────────

function selfTest() {
  const sample = `<?xml version="1.0"?><feed>
    <entry>
      <yt:videoId>abc12345678</yt:videoId>
      <title>GTC 2026 Keynote: Jensen Huang unveils Rubin</title>
      <author><name>NVIDIA</name></author>
      <published>2026-06-16T10:00:00+00:00</published>
      <media:group><media:description>Jensen Huang keynote.</media:description></media:group>
    </entry>
    <entry>
      <yt:videoId>xyz98765432</yt:videoId>
      <title>Tom &amp; Jerry &#39;fun&#39;</title>
      <published>2026-06-15T10:00:00+00:00</published>
    </entry>
  </feed>`;
  const parsed = parseFeed(sample);
  console.assert(parsed.length === 2, 'should parse 2 entries');
  console.assert(parsed[0].videoId === 'abc12345678', 'videoId');
  console.assert(parsed[0].author === 'NVIDIA', 'author');
  console.assert(parsed[1].title === "Tom & Jerry 'fun'", `entity decode got: ${parsed[1].title}`);
  const label = classify(parsed[0].title, {
    Press: ['unveils'],
    Keynote: ['keynote'],
  });
  console.assert(label === 'Press', `classify precedence got: ${label}`);
  console.assert(aliasInText(['Jensen Huang'], parsed[0].title), 'alias match');
  console.log('self-test passed ✓');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
