require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = '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';
const PORT = process.env.PORT || 3771;

// Detect platform and extract ID/URL info
function detectPlatform(url) {
  // YouTube
  const ytPatterns = [
    /(?:v=|\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /embed\/([a-zA-Z0-9_-]{11})/,
    /shorts\/([a-zA-Z0-9_-]{11})/
  ];
  for (const p of ytPatterns) {
    const m = url.match(p);
    if (m) return { platform: 'youtube', id: m[1] };
  }
  // TikTok
  const ttMatch = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
  if (ttMatch) return { platform: 'tiktok', id: ttMatch[1], url };
  // Instagram
  if (url.match(/instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/)) {
    const igMatch = url.match(/instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
    return { platform: 'instagram', id: igMatch[2], type: igMatch[1], url };
  }
  // X / Twitter
  const xMatch = url.match(/(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/);
  if (xMatch) return { platform: 'x', id: xMatch[1], url };

  return null;
}

// Legacy helper for YouTube only
function extractVideoId(url) {
  const r = detectPlatform(url);
  return (r && r.platform === 'youtube') ? r.id : null;
}

// Scrape metadata for non-YouTube platforms (best-effort via oEmbed)
async function fetchExternalOembed(url, platform) {
  const endpoints = {
    tiktok: `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
    instagram: `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(url)}`,
    x: `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`
  };
  const endpoint = endpoints[platform];
  if (!endpoint) throw new Error('Unsupported platform');
  const res = await fetch(endpoint, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('Could not fetch oEmbed for ' + platform);
  return await res.json();
}

// Fetch YouTube oEmbed data (title, author - no API key needed)
async function fetchYouTubeOembed(videoId) {
  const url = `https://www.youtube.com/oembed?url=https://youtube.com/watch?v=${videoId}&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not fetch video info');
  return await res.json();
}

// Fetch video description/transcript via YouTube page scrape
async function fetchVideoPage(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  const html = await res.text();
  
  // Extract description from page data
  let description = '';
  const descMatch = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (descMatch) {
    description = descMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').substring(0, 2000);
  }
  
  // Extract view count
  let viewCount = '';
  const viewMatch = html.match(/"viewCount":"(\d+)"/);
  if (viewMatch) viewCount = parseInt(viewMatch[1]).toLocaleString();
  
  // Extract like count (approximate)
  let duration = '';
  const durMatch = html.match(/"lengthSeconds":"(\d+)"/);
  if (durMatch) {
    const secs = parseInt(durMatch[1]);
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    duration = `${mins}:${s.toString().padStart(2,'0')}`;
  }
  
  // Extract tags
  let tags = [];
  const tagsMatch = html.match(/"keywords":\[(.*?)\]/);
  if (tagsMatch) {
    tags = tagsMatch[1].replace(/"/g, '').split(',').slice(0, 10);
  }
  
  return { description, viewCount, duration, tags };
}

const MRB_BRAIN = `
# Mr B's Brain — Complete Knowledge Base (Condensed for Analysis)

## CORE PHILOSOPHY
Goal: Make the best YOUTUBE videos — not best produced, funniest, or highest quality. Best for the PLATFORM.
Three metrics: CTR (Click-Through Rate), AVD (Average View Duration), AVP (Average View Percentage)

## PILLAR 1 — THE IDEA
- Title + thumbnail come FIRST. Everything built around them.
- Test: Would you click it? If "maybe" — not good enough.
- CTR formula: "I Survived" beats "I Spent". Extreme beats normal. Specific stakes beat vague.
- Idea formats that always work: extreme survival, $X vs $Y scale, last person wins, impossible challenge, record-breaking
- One sentence pitch test: can you explain it to a 10-year-old instantly?

## PILLAR 2 — THUMBNAIL
- 50+ variations tested per video. A/B tested live.
- Rules: one dominant human emotion (shock/joy/fear/disbelief), bold readable text (max 5 words), high contrast, curiosity gap
- Thumbnail + title = a CONTRACT with viewer. Break the contract = viewer leaves = AVD tanks = algorithm kills video
- Kill conditions: visual clutter, no human face, text that explains everything, doesn't match title

## PILLAR 3 — VIDEO STRUCTURE (Second-by-Second)

0:00-1:00 | THE HOOK (most critical)
- Front-load the most insane visual immediately
- Maximum density: visuals + music + effects + quick cuts
- Show "wow factor" by 0:30 — don't save it
- NEVER: "hey guys welcome back", slow intros, backstory before action
- WOW FACTOR RULE: Do something in first minute NO OTHER creator can do

1:00-3:00 | CRAZY PROGRESSION  
- Show, don't tell. Never explain what you're ABOUT to do.
- "Crazy progression" — cover multiple stages fast, not just the beginning
- Get to the stakes FAST. What is at risk? What could be lost?
- Introduce characters + give them a goal + obstacle = viewer picks a side

3:00 | FIRST RE-ENGAGEMENT HOOK
- Stop the 3-minute drop-off cliff
- Unexpected, shocking, or spectacular — something only YOU can do
- Resets the viewer's attention clock

3:00-HALFWAY | STORY INVESTMENT
- Present info fast AND visually — no long talking heads
- Stakes must ESCALATE — harder/bigger than when it started
- Character investment — viewers must care about specific people
- NO DULL MOMENTS doctrine: every second earns its place or gets cut

HALFWAY | SECOND RE-ENGAGEMENT
- Give clear reason to watch second half
- Raise stakes — "and now things get even harder because..."
- Create "I need to see how this ends" feeling

HALFWAY-END | THE BACK HALF
- Quality CANNOT drop — never coast
- Keep escalating every 30-60 seconds
- NEVER signal the end — no wind-down energy
- End ABRUPTLY at peak energy
- Payoff must feel EARNED by everything before it

## PILLAR 4 — 7 RETENTION STRATEGIES
1. Viral formats: tension builds, stakes rise, satisfying payoff
2. Never reuse formats back-to-back
3. Study storytelling: tension → relief → re-tension
4. Find your WOW FACTOR: what only YOU can do
5. Information diet: consume only the best content in your niche
6. Find a mentor/model: reverse engineer every decision
7. Always innovate: every video pushes something further

## PILLAR 5 — ANTI-PATTERNS (What kills videos)
- Slow intro / "Hey guys today I'm going to..."
- Explaining what you're ABOUT to do
- Energy drop in back half
- Winding down the ending
- Generic thumbnail (no face, no emotion, cluttered)
- Title that explains too much (no curiosity gap)
- Low-stakes premise
- Characters with no clear goal
- Money spent that doesn't appear on camera

## PILLAR 6 — THE 5 CORE QUESTIONS for any video
1. What is the WOW FACTOR? (What can this creator do no one else can?)
2. What are the STAKES? (What is at risk? What can be won/lost?)
3. Who is the CHARACTER? (Who do we root for? What do they want?)
4. What is the PROMISE? (What did title + thumbnail promise?)
5. Was the PROMISE KEPT? (Did the video deliver on every expectation set?)

## THE 10-DIMENSION SCORING RUBRIC (0-10 each = 100 total)
1. Title Strength — extreme, clear, curiosity gap, specific stakes
2. Thumbnail Power — emotion, contrast, alignment with title, click test
3. Hook Execution — first 60s, wow factor, front-loaded energy
4. Crazy Progression (1-3 min) — showing not telling, fast emotional investment
5. Re-engagement at 3min — spectacle, unexpected, attention reset
6. Story Investment (3min-halfway) — escalating stakes, character care, no dull moments
7. Halfway Re-engagement — reason to watch second half, stakes raised
8. Back Half Quality — energy maintained, escalation continues, no coasting
9. Ending — abrupt, peak energy, payoff delivered, promise kept
10. Wow Factor — something only THIS creator in THIS niche could do

## NICHE TRANSLATION
The formula works in ANY niche. Core emotional engine: Stakes + Character + Uncertainty = Engagement
Cooking, fitness, crypto, gaming, real estate, tech, education — same structure, different skin.
`;

app.post('/api/analyze', async (req, res) => {
  const { url, niche } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const platformInfo = detectPlatform(url);
  if (!platformInfo) return res.status(400).json({ error: 'Please paste a valid YouTube, TikTok, Instagram, or X (Twitter) video URL' });

  try {
    let title = 'Unknown Title', author = 'Unknown', thumbnail = '', description = '', viewCount = 'Unknown', duration = 'Unknown';

    if (platformInfo.platform === 'youtube') {
      const videoId = platformInfo.id;
      const [oembed, pageData] = await Promise.allSettled([
        fetchYouTubeOembed(videoId),
        fetchVideoPage(videoId)
      ]);
      title = oembed.status === 'fulfilled' ? oembed.value.title : 'Unknown Title';
      author = oembed.status === 'fulfilled' ? oembed.value.author_name : 'Unknown';
      thumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
      description = pageData.status === 'fulfilled' ? pageData.value.description : '';
      viewCount = pageData.status === 'fulfilled' ? pageData.value.viewCount : 'Unknown';
      duration = pageData.status === 'fulfilled' ? pageData.value.duration : 'Unknown';
    } else {
      // TikTok, Instagram, X — use oEmbed
      const oembed = await fetchExternalOembed(url, platformInfo.platform).catch(() => null);
      if (oembed) {
        title = oembed.title || oembed.author_name + ' video';
        author = oembed.author_name || 'Unknown';
        thumbnail = oembed.thumbnail_url || '';
      } else {
        title = platformInfo.platform.charAt(0).toUpperCase() + platformInfo.platform.slice(1) + ' Video';
        author = 'Unknown';
      }
    }

    // Build the analysis prompt
    const prompt = `You are Mr B's Brain — an AI that has fully internalized the complete viral video production philosophy from 20,000+ hours of YouTube study.

${MRB_BRAIN}

---

ANALYZE THIS VIDEO:
Title: "${title}"
Creator: ${author}
Views: ${viewCount}
Duration: ${duration}
Niche: ${niche || 'General/Unknown'}
Description (first 1000 chars): ${description.substring(0, 1000)}
Thumbnail: ${thumbnail || "N/A"}

---

Provide a FULL Mr B's Brain analysis. Be specific, surgical, and brutally honest. No generic advice.

FORMAT YOUR RESPONSE AS JSON (no markdown, pure JSON):
{
  "viralScore": <number 0-100>,
  "grade": "<S/A/B/C/D/F>",
  "verdict": "<2-3 sentence brutal honest summary of whether this video has viral DNA or not>",
  "scores": {
    "titleStrength": { "score": <0-10>, "analysis": "<specific analysis>", "fix": "<exact fix if score < 8>" },
    "thumbnailPower": { "score": <0-10>, "analysis": "<specific analysis>", "fix": "<exact fix if score < 8>" },
    "hookExecution": { "score": <0-10>, "analysis": "<specific analysis>", "fix": "<exact fix if score < 8>" },
    "crazyProgression": { "score": <0-10>, "analysis": "<specific analysis>", "fix": "<exact fix if score < 8>" },
    "reEngagement3min": { "score": <0-10>, "analysis": "<specific analysis>", "fix": "<exact fix if score < 8>" },
    "storyInvestment": { "score": <0-10>, "analysis": "<specific analysis>", "fix": "<exact fix if score < 8>" },
    "halfwayReEngagement": { "score": <0-10>, "analysis": "<specific analysis>", "fix": "<exact fix if score < 8>" },
    "backHalfQuality": { "score": <0-10>, "analysis": "<specific analysis>", "fix": "<exact fix if score < 8>" },
    "ending": { "score": <0-10>, "analysis": "<specific analysis>", "fix": "<exact fix if score < 8>" },
    "wowFactor": { "score": <0-10>, "analysis": "<specific analysis>", "fix": "<exact fix if score < 8>" }
  },
  "wowFactor": "<What is the wow factor of this video, or what it SHOULD be>",
  "stakes": "<What are the stakes? Are they clear and high enough?>",
  "promise": "<What promise did the title+thumbnail make?>",
  "promiseKept": <true/false>,
  "titleRewrite": "<Rewrite the title using the viral formula — make it 10x more viral>",
  "thumbnailDirection": "<Exact description of what the thumbnail should show to maximize CTR>",
  "blueprintFix": [
    { "timestamp": "0:00-1:00", "current": "<what probably happens>", "mrbeastVersion": "<exactly what the viral formula prescribes here>" },
    { "timestamp": "1:00-3:00", "current": "<what probably happens>", "mrbeastVersion": "<exactly what the viral formula prescribes here>" },
    { "timestamp": "3:00", "current": "<what probably happens>", "mrbeastVersion": "<exactly what the viral formula prescribes here>" },
    { "timestamp": "3:00-halfway", "current": "<what probably happens>", "mrbeastVersion": "<exactly what the viral formula prescribes here>" },
    { "timestamp": "halfway", "current": "<what probably happens>", "mrbeastVersion": "<exactly what the viral formula prescribes here>" },
    { "timestamp": "halfway-end", "current": "<what probably happens>", "mrbeastVersion": "<exactly what the viral formula prescribes here>" }
  ],
  "topKillers": ["<top 3 things killing this video's viral potential>"],
  "nicheTranslation": "<How would the viral formula approach this exact niche/topic? What would the optimized version look like?>"
}`;

    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured. Add it to .env file.' });
    }

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const aiData = await aiRes.json();
    if (!aiRes.ok) throw new Error(aiData.error?.message || 'AI request failed');

    let analysisText = aiData.content[0].text.trim();
    // Strip markdown code blocks if present
    analysisText = analysisText.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    
    let analysis;
    try {
      analysis = JSON.parse(analysisText);
    } catch(e) {
      analysis = { raw: analysisText, parseError: true };
    }

    res.json({
      videoId,
      title,
      author,
      thumbnail,
      viewCount,
      duration,
      analysis
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Mr B's Brain running on http://localhost:${PORT}`);
});
