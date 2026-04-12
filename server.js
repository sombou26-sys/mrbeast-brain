// v2.3 — deep MrB knowledge + platform-aware analysis — 1774628227
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

// ─── HTML ENTITY DECODE ───────────────────────────────────────────────────────
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d)))
    .replace(/&[a-zA-Z]+;/g, ' ');
}


const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const app = express();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = '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';
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = 'https://mr-b-brain.vercel.app/api/auth/callback';
const PORT = process.env.PORT || 3771;

// ─── IN-MEMORY SESSION STORE (swap for Redis in prod) ─────────────────────────
// Map<sessionId, { accessToken, refreshToken, expiry }>
// Tiny footprint — only stores tokens per connected user
const sessions = new Map();

// ─── RAW BODY PARSER — Vercel-compatible multipart (no disk, pure buffer) ────
// multer.memoryStorage works locally; on Vercel we parse multipart manually
const Busboy = require('busboy');

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let fileBuffer = null, fileMime = 'image/jpeg';
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 8*1024*1024 } });
    bb.on('file', (name, stream, info) => {
      fileMime = info.mimeType || 'image/jpeg';
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('close', () => resolve({ fields, fileBuffer, fileMime }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

// Dummy upload middleware shim (kept for route compatibility)
const upload = { single: () => (req, res, next) => next() };

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ─── PLATFORM DETECTION ──────────────────────────────────────────────────────
function detectPlatform(url) {
  const yt = url.match(/(?:v=|\/watch\?v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (yt) return { platform: 'youtube', id: yt[1] };
  const tt = url.match(/tiktok\.com\/@([^/]+)\/video\/(\d+)/);
  if (tt) return { platform: 'tiktok', id: tt[2], author: tt[1], url };
  const ig = url.match(/instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (ig) return { platform: 'instagram', id: ig[2], type: ig[1], url };
  const xm = url.match(/(?:twitter|x)\.com\/([^/]+)\/status\/(\d+)/);
  if (xm) return { platform: 'x', id: xm[2], author: xm[1], url };
  const fb1 = url.match(/facebook\.com\/watch\/\?v=(\d+)/);
  if (fb1) return { platform: 'facebook', id: fb1[1], url };
  const fb2 = url.match(/facebook\.com\/[^/]+\/videos\/(\d+)/);
  if (fb2) return { platform: 'facebook', id: fb2[1], url };
  const fb3 = url.match(/fb\.watch\/([A-Za-z0-9_-]+)/);
  if (fb3) return { platform: 'facebook', id: fb3[1], url };
  return null;
}

// ─── PLATFORM SCRAPERS ───────────────────────────────────────────────────────
async function scrapeTikTok(url, author) {
  try {
    // oEmbed first (title + author)
    const oe = await fetchOembed(url, 'tiktok').catch(() => null);
    const title = oe?.title || '';
    // Scrape page for description/views/duration
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow'
    });
    const html = await r.text();
    const descMatch = html.match(/"desc":"((?:[^"\\]|\\.)*)"/);
    const viewsMatch = html.match(/"playCount":(\d+)/);
    const durationMatch = html.match(/"duration":(\d+)/);
    const desc = descMatch ? descMatch[1].replace(/\\n/g,'\n').replace(/\\"/g,'"').substring(0,500) : title;
    const views = viewsMatch ? parseInt(viewsMatch[1]).toLocaleString() : '';
    const secs = durationMatch ? parseInt(durationMatch[1]) : 0;
    const duration = secs ? `${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}` : '';
    return {
      title: title || `@${author || 'creator'} on TikTok`,
      author: oe?.author_name || author || 'TikTok Creator',
      thumbnail: oe?.thumbnail_url || '',
      description: desc,
      viewCount: views,
      duration
    };
  } catch(e) {
    return { title: `TikTok Video`, author: author||'Unknown', thumbnail:'', description:'', viewCount:'', duration:'' };
  }
}

async function scrapeInstagram(url, id, type) {
  try {
    const oe = await fetchOembed(url, 'instagram').catch(() => null);
    if (oe) {
      return {
        title: oe.title || `Instagram ${type||'video'} by @${oe.author_name}`,
        author: oe.author_name || 'Instagram Creator',
        thumbnail: oe.thumbnail_url || '',
        description: oe.title || '',
        viewCount: '',
        duration: ''
      };
    }
    // Fallback: scrape public page
    const r = await fetch(url + '?__a=1&__d=dis', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await r.text();
    const captionMatch = html.match(/"caption":"((?:[^"\\]|\\.)*)"/);
    const authorMatch = html.match(/"username":"([^"]+)"/);
    return {
      title: `Instagram ${type||'video'} by @${authorMatch?.[1]||'creator'}`,
      author: authorMatch?.[1] || 'Instagram Creator',
      thumbnail: '',
      description: captionMatch ? captionMatch[1].replace(/\\n/g,'\n').substring(0,500) : '',
      viewCount: '',
      duration: ''
    };
  } catch(e) {
    return { title:'Instagram Video', author:'Unknown', thumbnail:'', description:'', viewCount:'', duration:'' };
  }
}

async function scrapeX(url, id, author) {
  try {
    const oe = await fetchOembed(url, 'x').catch(() => null);
    const tweetText = oe?.html ? oe.html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0,500) : '';
    const cleanTitle = tweetText ? decodeHtmlEntities(tweetText.substring(0,120)) : `Post by @${author||'user'} on X`;
    return {
      title: cleanTitle,
      author: oe?.author_name || author || 'X User',
      thumbnail: oe?.thumbnail_url || '',
      description: tweetText,
      viewCount: '',
      duration: ''
    };
  } catch(e) {
    return { title:'X/Twitter Video', author: author||'Unknown', thumbnail:'', description:'', viewCount:'', duration:'' };
  }
}

async function scrapeFacebook(url, id) {
  try {
    // Facebook oEmbed (public posts/videos)
    const fbOe = await fetch(`https://www.facebook.com/plugins/video/oembed.json/?url=${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (fbOe) {
      return {
        title: fbOe.title || `Facebook Video by ${fbOe.author_name||'creator'}`,
        author: fbOe.author_name || 'Facebook Creator',
        thumbnail: fbOe.thumbnail_url || '',
        description: fbOe.title || '',
        viewCount: '',
        duration: ''
      };
    }
    // Scrape open graph tags as fallback
    const r = await fetch(url, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }
    });
    const html = await r.text();
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] || '';
    const ogDesc  = html.match(/<meta property="og:description" content="([^"]+)"/)?.[1] || '';
    const ogImg   = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || '';
    return {
      title: ogTitle || 'Facebook Video',
      author: 'Facebook Creator',
      thumbnail: ogImg,
      description: ogDesc.substring(0,500),
      viewCount: '',
      duration: ''
    };
  } catch(e) {
    return { title:'Facebook Video', author:'Unknown', thumbnail:'', description:'', viewCount:'', duration:'' };
  }
}

// ─── YOUTUBE HELPERS ─────────────────────────────────────────────────────────
async function fetchYTOembed(id) {
  const r = await fetch(`https://www.youtube.com/oembed?url=https://youtube.com/watch?v=${id}&format=json`);
  if (!r.ok) throw new Error('Could not fetch video info');
  return r.json();
}

async function fetchYTPage(id) {
  const r = await fetch(`https://www.youtube.com/watch?v=${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  const h = await r.text();
  const g = (re) => { const m = h.match(re); return m ? m[1] : ''; };
  const desc = g(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  const secs = parseInt(g(/"lengthSeconds":"(\d+)"/)) || 0;
  const views = g(/"viewCount":"(\d+)"/);
  return {
    description: desc.replace(/\\n/g,'\n').replace(/\\"/g,'"').substring(0,2000),
    duration: secs ? `${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}` : '',
    durationSecs: secs,
    viewCount: views ? parseInt(views).toLocaleString() : '',
    tags: (h.match(/"keywords":\[(.*?)\]/) || ['',''])[1].replace(/"/g,'').split(',').slice(0,10)
  };
}

async function fetchOembed(url, platform) {
  const ep = { tiktok:`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, instagram:`https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(url)}`, x:`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true` };
  const r = await fetch(ep[platform], { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  return r.json();
}

// ─── GOOGLE OAUTH HELPERS ────────────────────────────────────────────────────
function getSession(req) {
  const sid = req.cookies?.mb_session;
  return sid ? sessions.get(sid) : null;
}

async function refreshIfNeeded(sess) {
  if (!sess || !sess.accessToken) return null;
  if (Date.now() < sess.expiry - 60000) return sess.accessToken;
  // refresh
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: sess.refreshToken, grant_type: 'refresh_token' })
  });
  const d = await r.json();
  if (d.access_token) {
    sess.accessToken = d.access_token;
    sess.expiry = Date.now() + (d.expires_in || 3600) * 1000;
  }
  return sess.accessToken;
}

// ─── OAUTH ROUTES ─────────────────────────────────────────────────────────────
app.get('/api/auth/youtube', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google OAuth not configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel dashboard.' });
  const state = uuidv4();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.readonly');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/api/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?auth_error=1');
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' })
    });
    const d = await r.json();
    if (!d.access_token) return res.redirect('/?auth_error=1');
    const sid = uuidv4();
    sessions.set(sid, { accessToken: d.access_token, refreshToken: d.refresh_token, expiry: Date.now() + (d.expires_in||3600)*1000 });
    res.cookie('mb_session', sid, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30*24*3600*1000 });
    res.redirect('/?connected=1');
  } catch(e) { res.redirect('/?auth_error=1'); }
});

app.get('/api/auth/status', (req, res) => {
  res.json({ connected: !!getSession(req) });
});

app.post('/api/auth/disconnect', (req, res) => {
  const sid = req.cookies?.mb_session;
  if (sid) sessions.delete(sid);
  res.clearCookie('mb_session');
  res.json({ ok: true });
});

// ─── RETENTION CURVE ─────────────────────────────────────────────────────────
app.post('/api/retention', async (req, res) => {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ error: 'Not connected. Connect YouTube first.' });
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  try {
    const token = await refreshIfNeeded(sess);
    // Get video duration first
    const vidRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${videoId}&fields=items(contentDetails/duration,statistics/viewCount)`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const vidData = await vidRes.json();
    const iso = vidData.items?.[0]?.contentDetails?.duration || 'PT0S';
    // ISO 8601 duration → seconds
    const durSecs = (iso.match(/(\d+)H/)?.[1]||0)*3600 + (iso.match(/(\d+)M/)?.[1]||0)*60 + (iso.match(/(\d+)S/)?.[1]||0)*1;

    // Fetch retention curve
    const today = new Date().toISOString().split('T')[0];
    const ytaUrl = `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=2020-01-01&endDate=${today}&metrics=audienceWatchRatio,relativeRetentionPerformance&dimensions=elapsedVideoTimeRatio&filters=video%3D%3D${videoId}&maxResults=100`;
    const ytaRes = await fetch(ytaUrl, { headers: { Authorization: `Bearer ${token}` } });
    const ytaData = await ytaRes.json();

    if (!ytaData.rows || ytaData.rows.length === 0) return res.status(404).json({ error: 'No retention data found for this video. It may be too new or have too few views.' });

    // Convert ratio → timestamp + percentage
    // rows: [[elapsedRatio, watchRatio, relativePerf], ...]
    // Downsample to ~50 points max using min-skip to keep memory tiny
    const rows = ytaData.rows;
    const step = Math.max(1, Math.floor(rows.length / 50));
    const curve = rows
      .filter((_, i) => i % step === 0)
      .map(([ratio, watchRatio, relPerf]) => {
        const s = Math.round(ratio * durSecs);
        return {
          ratio: +ratio.toFixed(3),
          timestamp: `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`,
          retentionPct: Math.round(watchRatio * 100),
          relativePerf: +relPerf.toFixed(2)
        };
      });

    // Find top 3 drop-off points (largest negative delta between consecutive points)
    const drops = [];
    for (let i = 1; i < curve.length; i++) {
      const delta = curve[i].retentionPct - curve[i-1].retentionPct;
      drops.push({ idx: i, delta, timestamp: curve[i].timestamp, retentionPct: curve[i].retentionPct });
    }
    drops.sort((a,b) => a.delta - b.delta); // most negative first
    const topDrops = drops.slice(0,3).map(d => ({ timestamp: d.timestamp, dropPct: Math.abs(d.delta), retentionPct: d.retentionPct }));

    res.json({ curve, topDrops, durSecs, videoId });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ─── MR B BRAIN KNOWLEDGE BASE ───────────────────────────────────────────────
const MRB_BRAIN = `
# MR B'S COMPLETE VIRAL FORMULA — DEEP KNOWLEDGE BASE

## THE THREE NUMBERS THAT DECIDE EVERYTHING
- **CTR (Click-Through Rate)** — Does the title+thumbnail FORCE the click? Target: >10%. Under 4% = dead on arrival.
- **AVD (Average View Duration)** — Are they staying? Under 40% = YouTube buries it. Over 60% = algorithm rocket fuel.
- **AVP (Average View Percentage)** — Same as AVD but expressed as % of video length. The platform's primary ranking signal.
These three numbers are the only report card that matters. Everything else is vanity.

## THE TITLE+THUMBNAIL CONTRACT
Title and thumbnail make a PROMISE to the viewer. The entire video must DELIVER that promise or die.
- Title = the STAKES. Make them extreme, specific, and create a curiosity gap.
- Thumbnail = the EMOTIONAL PROOF. Shows the peak moment, the reaction, the consequence.
- Together they must answer: "Why should I watch THIS video RIGHT NOW instead of anything else?"
- Bad contract examples: "I Tried Cooking" (no stakes), "My New Video" (no promise), "Day In My Life" (no curiosity)
- Good contract examples: "I Ate Nothing But X For 30 Days", "Last To Leave $1,000,000 Wins", "I Survived 100 Days In..."
- NEVER let the actual video contradict what title+thumbnail promised. Betrayal = mass drop-off + dislikes.

## THE 6-PART STRUCTURE (NON-NEGOTIABLE)

### PART 1: THE HOOK (0:00–1:00) — THE MOST IMPORTANT MINUTE
- Wow factor must hit by 0:30. If it hasn't, you've already lost 30% of viewers.
- NEVER start with: "Hey guys", intros, channel plugs, sponsor reads, backstory, or explaining what you're ABOUT to do.
- START IN THE ACTION. Best hooks start mid-scene, mid-consequence, or at peak visual energy.
- The first frame should be the most interesting thing you can possibly show.
- Pack maximum information density: show the scale, the stakes, the characters, the premise — all in 60 seconds.
- Emotional hook types that work: SHOCK ("I can't believe this happened"), SCALE ("$1,000,000 on the line"), CURIOSITY ("watch what happens when..."), IDENTITY ("only 1 in 1,000,000 people can..."), STAKES ("loser gets...").

### PART 2: CRAZY PROGRESSION (1:00–3:00)
- SHOW, don't tell. If you spent $10,000, show every dollar on camera.
- Escalate the stakes immediately after the hook. Don't coast on the hook's energy.
- Introduce the main characters/competitors/challenge parameters WITH PERSONALITY — viewers need someone to root for.
- Every 30 seconds should have a new development, reveal, or twist.
- Cut ruthlessly: zero dead air, zero repetition, zero scenes where nothing changes.

### PART 3: THE 3-MINUTE RE-ENGAGEMENT HOOK
- This is where most channels bleed viewers. The 3-minute cliff is real — drop-off spikes here without intervention.
- MUST INSERT: something unexpected, spectacular, funny, shocking, or emotionally escalating RIGHT at 3 minutes.
- Techniques: sudden twist reveal, raise the stakes higher than viewer expected, introduce a wildcard element, emotional gut-punch moment, spectacular visual, unexpected character development.
- This is not optional. If you don't do this, your retention curve falls off a cliff at 3:00 and never recovers.

### PART 4: STORY INVESTMENT (3:00–HALFWAY)
- By now viewers must CARE about the outcome. If they don't care who wins, they'll leave.
- Build character investment: show vulnerability, personality, funny moments, struggle, desire.
- ESCALATE the stakes continuously. Each scene should make the outcome matter MORE than the last.
- "Will they make it?" tension must be maintained. Never let the viewer feel the outcome is certain.
- Zero dull moments. If a scene doesn't advance stakes OR character investment, cut it.

### PART 5: THE HALFWAY RE-HOOK
- Exactly at the midpoint: raise the stakes to a new level. Create a "must see the end" moment.
- Techniques: sudden rule change, massive new consequence introduced, unexpected elimination/twist, emotional revelation, scale-up of the challenge.
- The viewer must feel: "I HAVE to see how this ends." If they feel "I get the idea, I can leave now," you've failed.
- This is the second biggest drop-off point after 3 minutes. Protect it.

### PART 6: BACK HALF + ENDING (HALFWAY–END)
- NEVER coast. The back half must maintain or INCREASE energy. Most creators relax here — this is fatal.
- Back half mistakes: repetitive challenge footage, padding, obvious outcome becoming visible too early, energy dips.
- The ENDING should be abrupt, at peak emotional energy, with the promise fully delivered.
- Do NOT wind down. Do NOT do long outro recaps. End at the CLIMAX.
- The last 30 seconds: deliver the payoff, make it satisfying, end it fast.

## THE 10 SCORING DIMENSIONS

### 1. TITLE STRENGTH (0-10)
- 10: Extreme stakes + curiosity gap + specific numbers/timeframe + emotional trigger
- 7-9: Clear stakes, good curiosity, missing one element
- 4-6: Stakes exist but generic, curiosity gap weak
- 1-3: Descriptive not compelling, no stakes, explains itself
- 0: No reason to click

### 2. THUMBNAIL POWER (0-10)
- 10: Peak emotional moment + faces with extreme expression + perfect text-image alignment + passes the blur test
- 7-9: Strong emotion, good composition, minor alignment issues
- 4-6: Face present but expression weak, text doesn't amplify the image
- 1-3: Generic, no face, no emotion, no story
- 0: Could be any video, no differentiator

### 3. HOOK EXECUTION 0:00–1:00 (0-10)
- 10: Starts in action, wow by 0:15, all stakes clear by 0:30, maximum density
- 7-9: Fast start, wow by 0:30, stakes clear within 1 min
- 4-6: Somewhat slow start, wow moment delayed past 0:45
- 1-3: Intro/greeting/backstory before action, wow moment missing or after 1:00
- 0: "Hey guys, so today I wanted to..."

### 4. CRAZY PROGRESSION (0-10)
- 10: Every 30s has new development, showing not telling, escalating stakes, character investment building
- 7-9: Good pace, mostly showing, minor slow spots
- 4-6: Some telling not showing, 60+ second dead zones, stakes don't escalate
- 1-3: Mostly narrated, slow reveals, flat stakes
- 0: Extended padding, nothing changes

### 5. RE-ENGAGEMENT AT 3:00 (0-10)
- 10: Spectacular unexpected twist/reveal/escalation precisely at 3-minute mark
- 7-9: Good re-hook within 30 seconds of 3:00 mark
- 4-6: Some attempt at re-engagement but weak
- 1-3: Minimal re-engagement, relies on momentum
- 0: Nothing — retention cliff at 3:00 will be visible in analytics

### 6. STORY INVESTMENT (0-10)
- 10: Viewer deeply cares who wins/what happens, characters are vivid, stakes feel personal
- 7-9: Good character moments, investment builds steadily
- 4-6: Some character but investment shallow, hard to care about outcome
- 1-3: No real characters, just actions
- 0: Complete absence of human stakes

### 7. HALFWAY RE-HOOK (0-10)
- 10: Major stake escalation/twist exactly at midpoint, viewer MUST see the end
- 7-9: Good midpoint escalation, creates forward pull
- 4-6: Mild escalation, easy to leave at midpoint
- 1-3: No deliberate midpoint hook
- 0: Energy actually drops at halfway

### 8. BACK HALF QUALITY (0-10)
- 10: Energy increases toward end, escalation continues, no dead zones, no coasting
- 7-9: Mostly maintained energy, one minor slow section
- 4-6: Noticeable energy drop, some padding or repetition
- 1-3: Clear back-half fatigue, creator visibly winding down
- 0: Extended padding, obvious filler to hit a length target

### 9. ENDING (0-10)
- 10: Abrupt end at peak energy, full promise delivered, satisfying and fast
- 7-9: Good payoff, slightly too long on the wind-down
- 4-6: Payoff exists but weak or delayed
- 1-3: Long outro, recapping what happened, or fading out slowly
- 0: Whimper ending — video just... stops without climax

### 10. WOW FACTOR (0-10)
- 10: Moment(s) that ONLY this creator in this niche could produce — unique, unreplicable
- 7-9: Strong wow moments, differentiated
- 4-6: Some impressive moments but others could have made this
- 1-3: Generic content, minimal distinctiveness
- 0: Anyone could make this

## PLATFORM-SPECIFIC INTELLIGENCE

### YOUTUBE (long-form, 8-30 min)
- Full 6-part structure required. AVD target: 50%+. Re-hooks at 3:00 AND halfway MANDATORY.
- Algorithm rewards: watch time volume (AVD × views), CTR, likes-to-views ratio.
- Biggest mistakes: slow intro, not monetizing the hook, energy death in back half.

### TIKTOK (short-form, 15-180 sec)
- Hook must hit in 0-2 SECONDS or swipe. There is no 30-second grace period.
- Loop plays matter: if they rewatch, algorithm rockets it. Design loops deliberately.
- Retention strategy: create confusion or curiosity in first 2 sec, resolve at the END.
- Text overlay must reinforce or contrast with what's visible — never redundant.
- TikTok-specific viral triggers: POV format, "watch until the end", unexpected transformation, relatability at scale.
- No traditional structure — it's one continuous hook. The ENTIRE video IS the hook.

### INSTAGRAM REELS (15-90 sec)
- Similar to TikTok but slightly higher production value expected.
- First frame must be visually arresting — Instagram is a visual-first platform.
- Caption matters more than TikTok — people actually read them.
- Saves are the most powerful signal — create content worth saving (tutorials, lists, insights).
- Watch-through rate is key: design the video so pausing feels like a loss.

### X/TWITTER VIDEO (variable, often 0:30-3:00)
- Native video on X is chronological + engagement-boosted. First 2 hours matter most.
- Muted autoplay is the default — VISUAL HOOK must work without sound. Text overlays critical.
- Controversy, surprise, and strong takes drive retweets which drive view counts.
- Shorter is almost always better. If it can be 30 seconds, don't make it 90.
- Viral X videos: shocking reveal, impossible skill, funny moment, strong contrarian take, emotional story with clear arc.

### FACEBOOK VIDEO (diverse age demo, feed-embedded)
- Silent autoplay in feed — same as X, visuals must convey the hook without sound.
- Older demographic (35+) responds to nostalgia, family, community, service.
- Videos get reshared more than YouTube or TikTok — design for shareability (emotional resolution, satisfying conclusion).
- Facebook Watch favors watch time, shares, and comments.
- Captions/subtitles are nearly mandatory — most FB video is watched silently.

## THE 5 VIRAL ACCELERATORS
1. **Extreme Scale** — The biggest, most expensive, longest, hardest version of anything = instant perception of value
2. **Real Stakes** — Actual money, real consequences, genuine competition — viewers sense fakeness and leave
3. **Character Investment** — Someone to root for + someone to root against. Two-sided narrative.
4. **The Impossible Premise** — "This shouldn't be possible / legal / survivable / real" = forced curiosity
5. **Emotion Density** — Joy, fear, surprise, awe, empathy — pack as many per minute as possible

## ANTI-PATTERNS (INSTANT VIRAL DEATH)
- Slow intro ("Hey guys, so before we get started...")
- Explaining what you're ABOUT to do instead of doing it
- Spending money off-camera (telling not showing)
- Energy death in back half — coasting on front-half momentum
- Generic thumbnail (no face, no emotion, no story)
- Title that gives away the entire premise (no curiosity gap)
- Winding down the ending — long recaps, slow outros
- Backstory before action (earn their attention FIRST)
- Promising something in title/thumbnail and not fully delivering
- Sub-challenge repetition without escalation (same thing 5 times)
- Creator fatigue visible on screen (viewer mirrors your energy)
`;

// ─── AI CALL (shared) ─────────────────────────────────────────────────────────
async function callClaude(messages, model = 'claude-3-haiku-20240307', maxTokens = 4000) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'AI failed');
  let raw = d.content[0].text.trim();
  // Strip markdown code fences anywhere in the string
  raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
  // Try direct parse first
  try { return JSON.parse(raw); } catch(e) {
    // Try to extract JSON object from within the text
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch(e2) {} }
    return { raw: raw, parseError: true };
  }
}

function buildAnalysisPrompt(title, author, viewCount, duration, description, niche, retentionContext = '', platform = 'youtube') {
  return `You are Mr B's Brain — an AI that fully embodies the viral video production philosophy.

${MRB_BRAIN}

${retentionContext}

ANALYZE THIS VIDEO:
Platform: ${platform || 'Unknown'}
Title: "${title}"
Creator: ${author}
Views: ${viewCount || 'Unknown'}
Duration: ${duration || 'Unknown'}
Niche: ${niche || 'General'}
Description/Caption: ${description ? description.substring(0,1000) : '(not available — infer from title, creator, and platform norms)'}

${!viewCount ? 'NOTE: View count not available. Base engagement assessment on title/thumbnail quality and platform norms.' : ''}
${!duration ? 'NOTE: Duration not available. Apply platform-appropriate structure expectations from the knowledge base.' : ''}
Apply the PLATFORM-SPECIFIC INTELLIGENCE section above for this platform. Different platforms have different viral formulas — use the right lens.

Respond ONLY with pure JSON (no markdown):
{
  "viralScore": <0-100>,
  "grade": "<S/A/B/C/D/F>",
  "verdict": "<2-3 sentence brutal honest summary>",
  "scores": {
    "titleStrength":       { "score":<0-10>, "analysis":"<specific>", "fix":"<if score<8>" },
    "thumbnailPower":      { "score":<0-10>, "analysis":"<specific>", "fix":"<if score<8>" },
    "hookExecution":       { "score":<0-10>, "analysis":"<specific>", "fix":"<if score<8>" },
    "crazyProgression":    { "score":<0-10>, "analysis":"<specific>", "fix":"<if score<8>" },
    "reEngagement3min":    { "score":<0-10>, "analysis":"<specific>", "fix":"<if score<8>" },
    "storyInvestment":     { "score":<0-10>, "analysis":"<specific>", "fix":"<if score<8>" },
    "halfwayReEngagement": { "score":<0-10>, "analysis":"<specific>", "fix":"<if score<8>" },
    "backHalfQuality":     { "score":<0-10>, "analysis":"<specific>", "fix":"<if score<8>" },
    "ending":              { "score":<0-10>, "analysis":"<specific>", "fix":"<if score<8>" },
    "wowFactor":           { "score":<0-10>, "analysis":"<specific>", "fix":"<if score<8>" }
  },
  "wowFactor": "<what the wow factor is or should be>",
  "stakes": "<are stakes clear and high enough?>",
  "promise": "<what title+thumbnail promised>",
  "promiseKept": <true/false>,
  "titleRewrite": "<viral rewrite>",
  "thumbnailDirection": "<exact thumbnail description>",
  "blueprintFix": [
    { "timestamp":"0:00-1:00",    "current":"<what probably happens>", "mrBVersion":"<formula prescription>" },
    { "timestamp":"1:00-3:00",    "current":"<what probably happens>", "mrBVersion":"<formula prescription>" },
    { "timestamp":"3:00",         "current":"<what probably happens>", "mrBVersion":"<formula prescription>" },
    { "timestamp":"3:00-halfway", "current":"<what probably happens>", "mrBVersion":"<formula prescription>" },
    { "timestamp":"halfway",      "current":"<what probably happens>", "mrBVersion":"<formula prescription>" },
    { "timestamp":"halfway-end",  "current":"<what probably happens>", "mrBVersion":"<formula prescription>" }
  ],
  "topKillers": ["<killer 1>","<killer 2>","<killer 3>"],
  "nicheTranslation": "<how viral formula applies to this exact niche>",
  "retentionInsights": ${retentionContext ? '[<see below>]' : 'null'}
}

${retentionContext ? `For retentionInsights, output an array like:
[{ "timestamp":"2:47", "dropPct":34, "diagnosis":"<why viewers left using the formula>", "fix":"<exact fix>" }]
One entry per major drop-off point identified in the retention data above.` : ''}`;
}

// ─── /api/analyze (existing — kept intact) ───────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { url, niche } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const p = detectPlatform(url);
  if (!p) return res.status(400).json({ error: 'Invalid URL. Paste a YouTube, TikTok, Instagram, X, or Facebook video URL.' });
  try {
    let title='Unknown',author='Unknown',thumbnail='',description='',viewCount='',duration='',videoId=p.id;
    if (p.platform === 'youtube') {
      const [oe, pg] = await Promise.allSettled([fetchYTOembed(videoId), fetchYTPage(videoId)]);
      title       = oe.status==='fulfilled' ? oe.value.title       : 'Unknown';
      author      = oe.status==='fulfilled' ? oe.value.author_name : 'Unknown';
      thumbnail   = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
      description = pg.status==='fulfilled' ? pg.value.description : '';
      viewCount   = pg.status==='fulfilled' ? pg.value.viewCount   : '';
      duration    = pg.status==='fulfilled' ? pg.value.duration    : '';
    } else {
      let meta;
      if (p.platform === 'tiktok')    meta = await scrapeTikTok(url, p.author);
      else if (p.platform === 'instagram') meta = await scrapeInstagram(url, p.id, p.type);
      else if (p.platform === 'x')    meta = await scrapeX(url, p.id, p.author);
      else if (p.platform === 'facebook') meta = await scrapeFacebook(url, p.id);
      if (meta) { title=meta.title; author=meta.author; thumbnail=meta.thumbnail; description=meta.description; viewCount=meta.viewCount; duration=meta.duration; }
    }
    const analysis = await callClaude([{ role:'user', content: buildAnalysisPrompt(title,author,viewCount,duration,description,niche,'',p.platform) }]);
    res.json({ videoId, title, author, thumbnail, viewCount, duration, analysis });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ─── /api/analyze-with-retention ─────────────────────────────────────────────
app.post('/api/analyze-with-retention', async (req, res) => {
  const { videoId, niche, retentionData } = req.body;
  if (!videoId || !retentionData) return res.status(400).json({ error: 'videoId and retentionData required' });
  try {
    const [oe, pg] = await Promise.allSettled([fetchYTOembed(videoId), fetchYTPage(videoId)]);
    const title       = oe.status==='fulfilled' ? oe.value.title       : 'Unknown';
    const author      = oe.status==='fulfilled' ? oe.value.author_name : 'Unknown';
    const thumbnail   = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    const description = pg.status==='fulfilled' ? pg.value.description : '';
    const viewCount   = pg.status==='fulfilled' ? pg.value.viewCount   : '';
    const duration    = pg.status==='fulfilled' ? pg.value.duration    : '';

    // Build retention context string for the prompt
    const { curve, topDrops } = retentionData;
    const retentionContext = `
REAL AUDIENCE RETENTION DATA (from YouTube Analytics):
Top 3 drop-off moments:
${topDrops.map((d,i)=>`  ${i+1}. ${d.timestamp} — dropped ${d.dropPct}% of remaining viewers (now at ${d.retentionPct}% watching)`).join('\n')}

Full curve (sampled):
${curve.slice(0,20).map(p=>`  ${p.timestamp}: ${p.retentionPct}% watching (relative perf: ${p.relativePerf})`).join('\n')}
...

Use this data to give surgical, timestamp-precise diagnosis and fixes in retentionInsights.`;

    const analysis = await callClaude(
      [{ role:'user', content: buildAnalysisPrompt(title,author,viewCount,duration,description,niche,retentionContext,'youtube') }],
      'claude-3-haiku-20240307', 4000
    );
    res.json({ videoId, title, author, thumbnail, viewCount, duration, analysis, hasRealRetention: true });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ─── /api/analyze-screenshot ─────────────────────────────────────────────────
app.post('/api/analyze-screenshot', async (req, res) => {
  let fileBuffer, fileMime, platform, niche;
  try {
    const parsed = await parseMultipart(req);
    fileBuffer = parsed.fileBuffer;
    fileMime   = parsed.fileMime;
    platform   = parsed.fields.platform || 'unknown';
    niche      = parsed.fields.niche    || '';
  } catch(e) { return res.status(400).json({ error: 'Could not parse upload: ' + e.message }); }
  if (!fileBuffer || !fileBuffer.length) return res.status(400).json({ error: 'No image uploaded' });
  try {
    // Step 1: Vision — extract retention data from screenshot
    const b64 = fileBuffer.toString('base64');
    const mime = fileMime;
    const extracted = await callClaude([{
      role: 'user',
      content: [
        { type:'image', source:{ type:'base64', media_type: mime, data: b64 } },
        { type:'text',  text: `This is a ${platform} analytics screenshot. Extract ALL visible retention/engagement data.
Return ONLY pure JSON:
{
  "avgWatchPct": <number or null>,
  "avgWatchTime": "<MM:SS or null>",
  "totalViews": "<number or null>",
  "dropPoints": [{ "timestamp":"<MM:SS>", "pct":<retention %> }],
  "peakPoints": [{ "timestamp":"<MM:SS>", "pct":<retention %> }],
  "insights": "<summary of what the curve shows>"
}` }
      ]
    }], 'claude-3-5-sonnet-20241022', 1000);

    if (extracted.parseError) return res.status(422).json({ error: 'Could not parse analytics from screenshot. Try a clearer image.' });

    // Step 2: Build retention context and run full analysis
    const retCtx = `
ANALYTICS DATA EXTRACTED FROM ${platform.toUpperCase()} SCREENSHOT:
Average watch %: ${extracted.avgWatchPct ?? 'Unknown'}%
Average watch time: ${extracted.avgWatchTime ?? 'Unknown'}
Total views: ${extracted.totalViews ?? 'Unknown'}
Drop-off points: ${extracted.dropPoints?.map(d=>`${d.timestamp} (${d.pct}%)`).join(', ') || 'None detected'}
Peak points: ${extracted.peakPoints?.map(d=>`${d.timestamp} (${d.pct}%)`).join(', ') || 'None detected'}
Summary: ${extracted.insights || 'N/A'}

Use this to give surgical timestamp-precise diagnosis in retentionInsights.`;

    const analysis = await callClaude(
      [{ role:'user', content: buildAnalysisPrompt('(From screenshot)', platform, extracted.totalViews||'', extracted.avgWatchTime||'', '', niche, retCtx) }],
      'claude-3-haiku-20240307', 4000
    );

    res.json({ platform, extracted, analysis, hasRealRetention: true });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Always listen (works locally + @vercel/node)
app.listen(PORT, () => console.log(`Mr B's Brain on :${PORT}`));
module.exports = app;
