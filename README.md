# Signal — Industry Leader Video Digest

A daily digest of **speeches, keynotes, press releases and interviews** from
industry leaders (Elon Musk, NVIDIA's Jensen Huang, Sam Altman, Satya Nadella,
Tim Cook, Sundar Pichai, Mark Zuckerberg — and anyone you add).

It runs entirely on GitHub, for free, with **no API keys**:

```
 ┌──────────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
 │  GitHub Actions      │     │  data/digest.json   │     │  GitHub Pages    │
 │  (scheduled daily)   │ ──► │  (committed by the  │ ──► │  static frontend │
 │  scripts/scrape.mjs  │     │   workflow)         │     │  index.html      │
 └──────────────────────┘     └─────────────────────┘     └──────────────────┘
        pulls YouTube                 real data               you read it
        channel RSS feeds          (no fake demo)          in the browser
```

A scheduled **GitHub Action** runs the scraper server-side (so there are no
browser CORS problems and no third-party proxies). It reads each leader's
YouTube channel RSS feed, scans conference/podcast channels (TED, Davos/WEF,
Y Combinator, a16z, Stanford GSB, Lex Fridman, Bloomberg) for any tracked
leader, classifies each video as **Keynote / Speech / Press / Interview /
Talk**, and writes [`data/digest.json`](data/digest.json). The static page in
[`index.html`](index.html) reads that file and renders the digest.

## One-time setup

1. **Push this repo to GitHub** (you're reading it there already if it's on the
   default branch).

2. **Enable GitHub Pages**
   *Settings → Pages → Build and deployment → Source: **Deploy from a branch** →
   Branch: `main` / `/ (root)` → Save.*
   Your site appears at `https://<you>.github.io/<repo>/`.

3. **Allow the Action to commit** (usually already on)
   *Settings → Actions → General → Workflow permissions → **Read and write
   permissions** → Save.*

4. **Generate the first digest now** instead of waiting for the schedule
   *Actions tab → **Daily Digest** → **Run workflow**.*
   When it finishes it commits `data/digest.json`, Pages redeploys, and the
   site fills in.

That's it. After this the digest refreshes automatically every day at 11:00 UTC
(change the `cron` in [`.github/workflows/daily-digest.yml`](.github/workflows/daily-digest.yml)).

## Adding or changing leaders

Edit [`config/leaders.json`](config/leaders.json). Each leader needs a YouTube
channel **@handle** (no API key, no channel ID hunting — handles are resolved
automatically):

```json
{
  "id": "lisa-su",
  "name": "Lisa Su",
  "title": "CEO — AMD",
  "color": "#6e1a3a",
  "aliases": ["Lisa Su"],
  "channels": ["@AMD"]
}
```

- `channels` — the leader's own / company channels. **Every** recent video is
  included.
- `aliases` — names used to attribute videos found on the shared
  `watchChannels` (conferences, podcasts) to this leader.

Commit the change. The workflow re-runs automatically on edits to
`config/leaders.json` (and you can always trigger it manually).

> **Tip:** if a handle ever fails to resolve you can put the raw channel ID
> (`UC…`) in `channels` instead. Find it via the channel's RSS URL:
> `https://www.youtube.com/feeds/videos.xml?channel_id=UC…`

## Running locally

```bash
node scripts/scrape.mjs        # fetch live data → data/digest.json
npm test                       # offline parser/classifier self-test
python3 -m http.server 8000    # then open http://localhost:8000
```

`scripts/scrape.mjs` uses only the Node standard library (Node 20+, built-in
`fetch`) — there are no dependencies to install.

## How classification works

Each video's title and description are matched against keyword groups in
`config/leaders.json → classify` (e.g. `keynote`, `unveils`, `commencement`,
`fireside`). First match wins; anything unmatched is tagged **Talk**. Tune the
keyword lists to fit the kind of "thought leadership" you care about.

## Notes & limits

- YouTube channel RSS returns roughly the **15 most recent** videos per
  channel; `lookbackDays` (default 45) bounds how far back the digest reaches.
- "Saved" videos are stored in your browser's `localStorage` (per-device).
- This is a read-only aggregator of public YouTube uploads — it embeds the
  official player and links back to YouTube.

## Files

| Path | Purpose |
|------|---------|
| `index.html` | Static frontend (the dashboard) |
| `config/leaders.json` | Who to track + classification keywords |
| `scripts/scrape.mjs` | The scraper (RSS → `digest.json`) |
| `data/digest.json` | Generated digest data (committed by the Action) |
| `.github/workflows/daily-digest.yml` | Scheduled scrape + commit |

## License

MIT
