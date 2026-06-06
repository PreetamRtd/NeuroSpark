/**
 * NeuroSpark Tool: FSRS Smart Review
 * Each vector chunk = an Anki-style spaced-repetition card.
 * Uses FSRS v4 algorithm to schedule reviews.
 * AI selects cards using RAG (topic similarity) + FSRS states.
 * AI generates Front/Back flashcards; user self-grades using FSRS buttons (Again, Hard, Good, Easy).
 * Immediately updates IndexedDB on each rating action.
 *
 * Isolated IIFE — zero external dependencies.
 */
(function () {
    if (!window.NeuroSparkTools) window.NeuroSparkTools = [];

    /* ══════════════════════════════════════════════════════
       FSRS v4  —  https://github.com/open-spaced-repetition
     ══════════════════════════════════════════════════════ */
    const W = [0.4072,1.1829,3.1262,15.4722,7.2102,0.5316,1.0651,0.0589,
               1.5330,0.1544,1.0070,1.9395,0.1100,0.2900,2.2700,0.3000,2.5200];
    const DECAY             = -0.5;
    const FACTOR            = Math.pow(0.9, 1 / DECAY) - 1; // ≈ 0.2342
    const DESIRED_RETENTION = 0.9;
    const MAX_SESSION       = 20; // max cards per session

    function fsrsInit() {
        return { stability: 0, difficulty: 5, due: new Date().toISOString(),
                 reps: 0, lapses: 0, state: 0, lastReview: null };
    }

    function fsrsR(stability, elapsedDays) {
        if (!stability) return 0;
        return Math.pow(1 + FACTOR * elapsedDays / stability, DECAY);
    }

    function fsrsInterval(stability) {
        return Math.max(1, Math.round(stability / FACTOR * (Math.pow(DESIRED_RETENTION, 1 / DECAY) - 1)));
    }

    /** rating: 1=Again 2=Hard 3=Good 4=Easy */
    function fsrsSchedule(card, rating) {
        const now     = new Date();
        const elapsed = card.lastReview
            ? Math.max(0, (now - new Date(card.lastReview)) / 86400000) : 0;
        const R = card.state === 0 ? 1 : fsrsR(card.stability, elapsed);

        let S, D;
        if (card.state === 0) {
            S = W[rating - 1];
            D = Math.min(10, Math.max(1, W[4] - W[5] * (rating - 3)));
        } else {
            D = Math.min(10, Math.max(1,
                card.difficulty - W[6] * (rating - 3) + W[7] * (W[4] - card.difficulty)));
            if (rating === 1) {
                S = W[11] * Math.pow(D, -W[12])
                    * (Math.pow(card.stability + 1, W[13]) - 1)
                    * Math.exp(W[14] * (1 - R));
            } else {
                const hp = rating === 2 ? W[15] : 1;
                const eb = rating === 4 ? W[16] : 1;
                S = card.stability * (Math.exp(W[8]) * (11 - D)
                    * Math.pow(card.stability, -W[9])
                    * (Math.exp(W[10] * (1 - R)) - 1) * hp * eb + 1);
            }
        }
        S = Math.max(0.1, Math.round(S * 100) / 100);
        D = Math.round(D * 100) / 100;
        const interval = rating === 1 ? 1 : fsrsInterval(S);
        const due      = new Date(now.getTime() + interval * 86400000);
        return {
            stability: S, difficulty: D,
            due: due.toISOString(),
            reps: (card.reps || 0) + 1,
            lapses: rating === 1 ? (card.lapses || 0) + 1 : (card.lapses || 0),
            state: rating === 1 && card.state > 0 ? 3 : rating === 1 ? 1 : 2,
            lastReview: now.toISOString()
        };
    }

    /* ══════════════════════════════════════════════════════
       ICONS
     ══════════════════════════════════════════════════════ */
    const TOOL_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;

    /* ══════════════════════════════════════════════════════
       AI HELPER
     ══════════════════════════════════════════════════════ */
    async function callAI(prompt, images = []) {
        const apiConfig = await (window.dbStore ? window.dbStore.get('apiConfig') : null);
        const mode      = await (window.dbStore ? window.dbStore.get('executionMode') : 'cloud');

        if (mode === 'cloud' && apiConfig && apiConfig.key) {
            const provider = apiConfig.provider || 'gemini';
            const key      = apiConfig.key;
            const model    = apiConfig.model || (provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash');

            /* Gemini */
            if (provider === 'gemini') {
                const fm   = model.includes('/') ? model : `models/${model}`;
                const parts = [{ text: prompt }];
                images.forEach(img => {
                    if (img) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
                });
                const r = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/${fm}:generateContent?key=${key}`,
                    { method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ contents: [{ parts }],
                        generationConfig: { temperature: 0.2, maxOutputTokens: 3000 } }) }
                );
                if (!r.ok) throw new Error(`Gemini ${r.status}`);
                return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
            }

            /* OpenAI */
            if (provider === 'openai') {
                const content = [{ type: 'text', text: prompt }];
                images.forEach(img => {
                    if (img) content.push({ type: 'image_url',
                        image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
                });
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, messages: [{ role: 'user', content }],
                        max_tokens: 3000, temperature: 0.2 })
                });
                if (!r.ok) throw new Error(`OpenAI ${r.status}`);
                return (await r.json()).choices?.[0]?.message?.content || '';
            }

            /* Anthropic */
            if (provider === 'anthropic') {
                const content = [{ type: 'text', text: prompt }];
                images.forEach(img => {
                    if (img) content.push({
                        type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data }
                    });
                });
                const r = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01',
                               'anthropic-dangerous-direct-browser-access': 'true',
                               'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, max_tokens: 3000,
                        messages: [{ role: 'user', content }] })
                });
                if (!r.ok) throw new Error(`Anthropic ${r.status}`);
                return (await r.json()).content?.[0]?.text || '';
            }
        }
        throw new Error('No AI provider configured. Set up an API key in Settings → Cloud API (Online).');
    }

    function parseJSON(raw) {
        const t = raw.trim()
            .replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
        const s = t.indexOf('{'), e = t.lastIndexOf('}');
        if (s === -1 || e === -1) throw new Error('AI did not return valid JSON.');
        return JSON.parse(t.slice(s, e + 1));
    }

    /* ══════════════════════════════════════════════════════
       DUE CARD DISCOVERY & RAG SEARCH
     ══════════════════════════════════════════════════════ */
    function ensureFSRS(chunk) {
        if (!chunk.fsrs) chunk.fsrs = fsrsInit();
        return chunk;
    }

    function cosineSimilarity(vecA, vecB) {
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dot += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
    }

    function keywordMatchScore(text, query) {
        const words = query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
        if (words.length === 0) return 0;
        const textLower = text.toLowerCase();
        let matches = 0;
        words.forEach(w => {
            if (textLower.includes(w)) matches++;
        });
        return matches / words.length;
    }

    async function getRAGChunks(deck, query, k) {
        if (!query || k <= 0) return [];
        
        const allChunks = [];
        (deck.sources || []).forEach((src, si) => {
            (src.chunks || []).forEach((chunk, ci) => {
                allChunks.push({
                    srcIdx: si, chunkIdx: ci,
                    text: chunk.text,
                    embedding: chunk.embedding,
                    fsrs: chunk.fsrs || fsrsInit(),
                    sourceName: src.name
                });
            });
        });

        if (allChunks.length === 0) return [];

        try {
            const apiConfig = await (window.dbStore ? window.dbStore.get('apiConfig') : null);
            const modelName = apiConfig ? apiConfig.model || 'gemini-1.5-flash' : 'gemini-1.5-flash';
            
            if (typeof window.computeEmbedding === 'function') {
                const queryVector = await window.computeEmbedding(query, modelName);
                if (queryVector && queryVector.length > 0) {
                    const scored = allChunks.map(chunk => {
                        let sim = 0;
                        if (chunk.embedding && chunk.embedding.length === queryVector.length) {
                            sim = cosineSimilarity(queryVector, chunk.embedding);
                        } else {
                            sim = keywordMatchScore(chunk.text, query);
                        }
                        return { chunk, sim };
                    });
                    scored.sort((a, b) => b.sim - a.sim);
                    return scored.slice(0, k).map(s => s.chunk);
                }
            }
        } catch (err) {
            console.warn('[FSRS] RAG embedding lookup failed, using keyword fallback:', err);
        }

        // Keyword Match Fallback
        const scored = allChunks.map(chunk => {
            const sim = keywordMatchScore(chunk.text, query);
            return { chunk, sim };
        });
        scored.sort((a, b) => b.sim - a.sim);
        return scored.slice(0, k).map(s => s.chunk);
    }

    function collectDueCards(deck) {
        const due = [];
        (deck.sources || []).forEach((src, si) => {
            (src.chunks || []).forEach((chunk, ci) => {
                ensureFSRS(chunk);
                const isDue = chunk.fsrs.state === 0 || new Date(chunk.fsrs.due) <= new Date();
                if (isDue) {
                    due.push({
                        srcIdx: si, chunkIdx: ci,
                        text: chunk.text,
                        fsrs: { ...chunk.fsrs },
                        sourceName: src.name
                    });
                }
            });
        });
        return due;
    }

    function dueLabel(isoDate) {
        const days = Math.ceil((new Date(isoDate) - new Date()) / 86400000);
        if (days <= 0)  return 'due now';
        if (days === 1) return 'tomorrow';
        return `in ${days} days`;
    }

    /* ══════════════════════════════════════════════════════
       STYLES (scoped .fsr-)
     ══════════════════════════════════════════════════════ */
    const STYLES = `
<style>
.fsr-wrap{display:flex;flex-direction:column;gap:12px;height:100%;width:100%;}
.fsr-hdr{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border-color);padding-bottom:12px;flex-shrink:0;}
.fsr-title{display:flex;align-items:center;gap:8px;}
.fsr-title h4{font-size:.875rem;font-weight:600;color:var(--text-color);margin:0;}
.fsr-back{background:none;border:1px solid var(--border-color);border-radius:4px;padding:4px 10px;font-size:.75rem;color:var(--text-muted);cursor:pointer;}
.fsr-progress-bar-wrap{height:5px;background:var(--bg-input);border-radius:99px;overflow:hidden;flex-shrink:0;}
.fsr-progress-bar{height:100%;background:var(--primary-color);border-radius:99px;transition:width .4s ease;}
.fsr-body{flex:1;display:flex;flex-direction:column;gap:12px;overflow-y:auto;min-height:0;padding-right:4px;}
/* Setup card styles */
.fsr-setup-card{background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:14px;box-shadow:var(--shadow-sm);margin-top:10px;}
.fsr-setup-title{font-size:1rem;font-weight:700;color:var(--text-color);display:flex;align-items:center;gap:6px;}
.fsr-setup-desc{font-size:.75rem;color:var(--text-muted);line-height:1.5;}
.fsr-setup-input{width:100%;height:70px;padding:12px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-color);font-size:.875rem;font-family:var(--font-sans);resize:none;outline:none;line-height:1.5;transition:all .15s ease-in-out;}
.fsr-setup-input:focus{border-color:var(--primary-color);background:var(--bg-input-focus);box-shadow:0 0 0 2px rgba(99,102,241,0.15);}
.fsr-setup-k-input{padding:10px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-color);font-size:.875rem;outline:none;transition:border-color .15s;width:100%;}
.fsr-setup-k-input:focus{border-color:var(--primary-color);box-shadow:0 0 0 2px rgba(99,102,241,0.15);}
.fsr-setup-stats{font-size:.75rem;color:var(--text-muted);display:flex;gap:16px;border-top:1px solid var(--border-color);padding-top:12px;margin-top:4px;}
.fsr-setup-btn{padding:12px 24px;border-radius:8px;border:none;background:var(--primary-color);color:#fff;font-size:.875rem;font-weight:600;cursor:pointer;transition:all .15s ease;text-align:center;width:100%;}
.fsr-setup-btn:hover{background:var(--primary-hover);transform:translateY(-1px);}
.fsr-setup-btn:active{transform:translateY(0);}
/* stats row */
.fsr-stats{display:flex;gap:10px;flex-shrink:0;}
.fsr-stat{flex:1;background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:3px;}
.fsr-stat-val{font-size:1.25rem;font-weight:700;color:var(--primary-color);}
.fsr-stat-label{font-size:.6875rem;color:var(--text-muted);}
/* Flashcard */
.fsr-flashcard-box{background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:14px;box-shadow:var(--shadow-sm);flex-shrink:0;}
.fsr-card-meta{display:flex;align-items:center;justify-content:space-between;font-size:.6875rem;color:var(--text-muted);margin-bottom:2px;}
.fsr-card-src{font-weight:600;color:var(--text-label);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;}
.fsr-card-badge{display:flex;align-items:center;gap:4px;}
.fsr-badge{padding:2px 8px;border-radius:20px;font-size:.625rem;font-weight:600;border:1px solid;}
.fsr-badge-new{color:#6366f1;border-color:#6366f1;}
.fsr-badge-review{color:#34d399;border-color:#34d399;}
.fsr-badge-relearn{color:#f87171;border-color:#f87171;}
/* collapsible hint */
.fsr-hint-container{margin-top:4px;}
.fsr-hint-toggle{background:none;border:1px solid var(--border-color);border-radius:6px;color:var(--text-muted);font-size:.725rem;padding:5px 10px;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .15s ease;}
.fsr-hint-toggle:hover{border-color:var(--primary-color);color:var(--primary-color);background:var(--bg-hover);}
.fsr-hint-content{display:none;margin-top:8px;font-size:.75rem;color:var(--text-muted);line-height:1.5;background:var(--bg-input);border-left:3px solid var(--primary-color);padding:8px 10px;border-radius:4px;max-height:140px;overflow-y:auto;}
.fsr-hint-content.visible{display:block;}

.fsr-front-text{font-size:.95rem;font-weight:600;color:var(--text-color);line-height:1.5;}
.fsr-back-divider{border-top:1px dashed var(--border-color);margin:8px 0;}
.fsr-back-text{font-size:.875rem;color:var(--text-label);line-height:1.6;animation:fsrFadeIn .25s ease;}

/* Reveal & Rating Buttons */
.fsr-reveal-btn{padding:12px 24px;border-radius:8px;border:none;background:var(--primary-color);color:#fff;font-size:.875rem;font-weight:600;cursor:pointer;transition:all .15s ease;text-align:center;margin-top:8px;}
.fsr-reveal-btn:hover{background:var(--primary-hover);}
.fsr-rating-row{display:grid;grid-template-columns:repeat(4, 1fr);gap:8px;margin-top:8px;}
.fsr-rating-btn{padding:12px 4px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-color);font-size:.8125rem;font-weight:600;cursor:pointer;transition:all .12s ease;display:flex;flex-direction:column;align-items:center;gap:2px;outline:none;}
.fsr-rating-btn span{font-size:.625rem;font-weight:400;color:var(--text-muted);}
.fsr-rating-btn.again:hover{border-color:#ef4444;background:rgba(239, 68, 68, 0.08);color:#ef4444;}
.fsr-rating-btn.hard:hover{border-color:#f59e0b;background:rgba(245, 158, 11, 0.08);color:#f59e0b;}
.fsr-rating-btn.good:hover{border-color:#10b981;background:rgba(16, 185, 129, 0.08);color:#10b981;}
.fsr-rating-btn.easy:hover{border-color:#6366f1;background:rgba(99, 102, 241, 0.08);color:#6366f1;}

.fsr-card-counter{font-size:.6875rem;color:var(--text-muted);align-self:flex-start;margin-top:-6px;}
/* spinner / placeholders */
.fsr-spinner{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:12px;color:var(--text-muted);font-size:.8125rem;}
.fsr-dot{width:10px;height:10px;border-radius:50%;background:var(--primary-color);animation:badge-pulse 1.2s infinite ease-in-out;}
.fsr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:12px;color:var(--text-muted);text-align:center;padding:24px;}
.fsr-empty svg{opacity:.3;margin-bottom:6px;}
.fsr-error{color:#ef4444;font-size:.75rem;text-align:center;padding:24px;line-height:1.5;}
/* results */
.fsr-results{display:flex;flex-direction:column;gap:14px;overflow-y:auto;}
.fsr-score-ring{width:76px;height:76px;flex-shrink:0;}
.fsr-score-ring circle{transition:stroke-dashoffset .8s ease-out;}
.fsr-score-top{display:flex;align-items:center;gap:16px;background:var(--bg-input);padding:14px;border-radius:10px;border:1px solid var(--border-color);}
.fsr-score-info{display:flex;flex-direction:column;gap:4px;}
.fsr-score-pct{font-size:1.5rem;font-weight:800;color:var(--text-color);}
.fsr-score-sub{font-size:.75rem;color:var(--text-muted);}
.fsr-card-result{background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:6px;}
.fsr-result-header{display:flex;align-items:center;justify-content:space-between;font-size:.75rem;}
.fsr-result-q{font-size:.75rem;color:var(--text-label);font-style:italic;}
.fsr-result-rating{padding:2px 8px;border-radius:20px;font-size:.625rem;font-weight:700;border:1px solid;}
.fsr-r1{color:#ef4444;border-color:#ef4444;background:rgba(239,68,68,0.05);}
.fsr-r2{color:#f59e0b;border-color:#f59e0b;background:rgba(245,158,11,0.05);}
.fsr-r3{color:#10b981;border-color:#10b981;background:rgba(16,185,129,0.05);}
.fsr-r4{color:#6366f1;border-color:#6366f1;background:rgba(99,102,241,0.05);}
.fsr-result-comment{font-size:.75rem;color:var(--text-muted);}
.fsr-next-due{font-size:.6875rem;color:var(--text-muted);}
.fsr-section-title{font-size:.725rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-top:10px;margin-bottom:2px;}
.fsr-restart-btn{padding:9px 20px;border-radius:8px;border:1px solid var(--border-color);background:none;color:var(--text-muted);font-size:.8125rem;cursor:pointer;transition:all .15s;align-self:flex-start;margin-top:10px;}
.fsr-restart-btn:hover{border-color:var(--primary-color);color:var(--primary-color);background:var(--bg-hover);}

@keyframes fsrFadeIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:translateY(0);}}
</style>`;

    /* ══════════════════════════════════════════════════════
       TOOL DEFINITION
     ══════════════════════════════════════════════════════ */
    const toolDefinition = {
        id: 'fsrs-review',
        name: 'Smart Review',
        description: 'FSRS spaced repetition — AI RAG search + due cards study with instant rating FSRS updates.',
        icon: TOOL_ICON,

        render(container, deck, onBack) {
            container.innerHTML = STYLES + `
<div class="fsr-wrap">
  <div class="fsr-hdr">
    <div class="fsr-title">
      <span style="color:var(--primary-color);display:flex;">${TOOL_ICON}</span>
      <h4>Smart Review</h4>
    </div>
    <button class="fsr-back" id="fsrBack">← Back</button>
  </div>
  <div class="fsr-progress-bar-wrap"><div class="fsr-progress-bar" id="fsrProgress" style="width:0%"></div></div>

  <!-- SETUP phase -->
  <div class="fsr-phase" id="fsrPhaseSetup">
    <div class="fsr-setup-card">
      <div class="fsr-setup-title">🎯 AI Smart Review Setup</div>
      <div class="fsr-setup-desc">Enter a topic query to fetch relevant cards via RAG, and select how many cards to retrieve. All of your review and relearn cards will be included automatically.</div>
      
      <div style="display: flex; flex-direction: column; gap: 6px;">
        <label style="font-size: 0.75rem; font-weight: 600; color: var(--text-label);">RAG Topic Query</label>
        <textarea class="fsr-setup-input" id="fsrSetupInput" placeholder="e.g. cellular respiration, organic chemistry..."></textarea>
      </div>

      <div style="display: flex; gap: 12px; align-items: center;">
        <div style="display: flex; flex-direction: column; gap: 6px; flex: 1;">
          <label style="font-size: 0.75rem; font-weight: 600; color: var(--text-label);">Number of RAG Chunks (k)</label>
          <input type="number" class="fsr-setup-k-input" id="fsrSetupKInput" value="5" min="1" max="15">
        </div>
      </div>

      <div class="fsr-setup-stats" id="fsrSetupStats">Scanning deck...</div>
      <button class="fsr-setup-btn" id="fsrStartBtn">Start AI Smart Review</button>
    </div>
  </div>

  <!-- DISCOVERY phase -->
  <div class="fsr-phase hidden" id="fsrPhaseDiscover">
    <div class="fsr-spinner"><div class="fsr-dot"></div><span id="fsrDiscoverMsg">Filtering your deck…</span></div>
  </div>

  <!-- GENERATING phase -->
  <div class="fsr-phase hidden" id="fsrPhaseGenerating">
    <div class="fsr-spinner"><div class="fsr-dot"></div><span id="fsrGeneratingMsg">AI is selecting cards…</span></div>
  </div>

  <!-- REVIEW phase -->
  <div class="fsr-phase hidden" id="fsrPhaseReview">
    <div class="fsr-stats" id="fsrStats"></div>
    <div class="fsr-body" id="fsrReviewBody"></div>
  </div>

  <!-- RESULTS phase -->
  <div class="fsr-phase hidden" id="fsrPhaseResults">
    <div class="fsr-body" id="fsrResultsBody"></div>
  </div>

  <!-- EMPTY state -->
  <div class="fsr-phase hidden" id="fsrPhaseEmpty">
    <div class="fsr-empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
      <span id="fsrEmptyMsg">No cards matching your criteria.</span>
      <span style="font-size:.6875rem;">Modify your prompt or upload more source documents.</span>
      <button class="fsr-restart-btn" id="fsrEmptyBackBtn" style="align-self:center;">🔄 Try Again</button>
    </div>
  </div>
</div>`;

            container.querySelector('#fsrBack').addEventListener('click', onBack);
            container.querySelector('#fsrEmptyBackBtn').addEventListener('click', () => showSetupScreen());

            /* ── helpers to show/hide phases ── */
            const phases = ['Setup','Discover','Generating','Review','Results','Empty'];
            function showPhase(name) {
                phases.forEach(p => container.querySelector(`#fsrPhase${p}`).classList.toggle('hidden', p !== name));
            }

            /* ── session state ── */
            let dueCards   = [];
            let questions  = []; // Stores { front, back, concept }
            let answers    = []; // Stores user's selected rating { rating, newFSRS }
            let currentIdx = 0;

            function setProgress(n, total) {
                const pct = total ? Math.round((n / total) * 100) : 0;
                container.querySelector('#fsrProgress').style.width = pct + '%';
            }

            /* ══ PHASE 0: SETUP SCREEN ══ */
            function showSetupScreen() {
                showPhase('Setup');
                setProgress(0, 1);
                
                const total = (deck.sources || []).reduce((a, s) => a + (s.chunks || []).length, 0);
                const due = collectDueCards(deck).length;
                const reviewRelearn = (deck.sources || []).reduce((acc, src) => {
                    return acc + (src.chunks || []).filter(c => c.fsrs && c.fsrs.state !== 0).length;
                }, 0);

                container.querySelector('#fsrSetupStats').innerHTML = `
                    <span>📚 Total Chunks: ${total}</span>
                    <span>⏰ Due Now: ${due}</span>
                    <span>🔄 In Review: ${reviewRelearn}</span>
                `;
            }

            container.querySelector('#fsrStartBtn').addEventListener('click', () => {
                const userQuery = container.querySelector('#fsrSetupInput').value.trim();
                const kVal = parseInt(container.querySelector('#fsrSetupKInput').value) || 5;
                startDiscover(userQuery, kVal);
            });

            /* ══ PHASE 1: DISCOVER (RAG + FSRS) ══ */
            async function startDiscover(userQuery, kVal) {
                showPhase('Discover');
                container.querySelector('#fsrDiscoverMsg').textContent = 'Fetching and merging cards...';

                if (!deck.sources || deck.sources.length === 0) {
                    showPhase('Empty');
                    container.querySelector('#fsrEmptyMsg').textContent = 'No source documents in this Deck. Upload files first.';
                    return;
                }

                // 1. Collect all review & relearn cards
                const reviewRelearn = [];
                (deck.sources || []).forEach((src, si) => {
                    (src.chunks || []).forEach((chunk, ci) => {
                        ensureFSRS(chunk);
                        if (chunk.fsrs.state !== 0) {
                            reviewRelearn.push({
                                srcIdx: si, chunkIdx: ci,
                                text: chunk.text,
                                fsrs: { ...chunk.fsrs },
                                sourceName: src.name
                            });
                        }
                    });
                });

                // 2. Fetch RAG cards
                const ragCards = await getRAGChunks(deck, userQuery, kVal);

                // Merge (avoid duplicates)
                const selectedMap = new Map();
                reviewRelearn.forEach(c => {
                    selectedMap.set(`${c.srcIdx}-${c.chunkIdx}`, c);
                });
                ragCards.forEach(c => {
                    selectedMap.set(`${c.srcIdx}-${c.chunkIdx}`, c);
                });

                dueCards = Array.from(selectedMap.values());

                if (dueCards.length === 0) {
                    // Fallback to standard due cards
                    dueCards = collectDueCards(deck).slice(0, MAX_SESSION);
                }

                if (dueCards.length === 0) {
                    showPhase('Empty');
                    return;
                }

                await generateQuestions();
            }

            /* ══ PHASE 2: GENERATE QUESTIONS (BLOOM'S TAXONOMY FRONT/BACK) ══ */
            async function generateQuestions() {
                showPhase('Generating');
                const total = dueCards.length;
                container.querySelector('#fsrGeneratingMsg').textContent = `AI is designing flashcard concepts for ${total} cards...`;

                const chunkList = dueCards.map((c, i) =>
                    `Card ${i} [Source: ${c.sourceName}]:\n"""\n${c.text.slice(0, 600)}\n"""`
                ).join('\n\n---\n\n');

                const prompt = `You are an expert tutor designing conceptual review flashcards.
For each of the ${total} cards below, generate exactly ONE conceptual study flashcard containing a Front (question/prompt) and a Back (answer/explanation).

IMPORTANT:
- The Front should ask a question, pose a problem, or present a prompt testing the core concept/principles of the card.
- The Back should contain a clear, concise correct answer and explanation.
- DO NOT spoil the back answer on the front of the card.
- Return ONLY the front, back, and concept.

Cards:
${chunkList}

Return ONLY a valid JSON object matching this schema (no markdown, no other text):
{
  "cards": [
    {
      "idx": 0,
      "front": "The question or prompt for the front of the card...",
      "back": "The clear answer and explanation for the back of the card...",
      "concept": "Concept Name"
    }
  ]
}`;

                try {
                    const raw  = await callAI(prompt);
                    const data = parseJSON(raw);
                    questions  = data.cards || [];

                    if (questions.length !== total) {
                        throw new Error('Incomplete question count returned');
                    }
                } catch (err) {
                    console.warn('[FSRS] Question generation failed, falling back:', err);
                    questions = dueCards.map((c, i) => ({
                        idx: i,
                        front: `Explain and verify your understanding of the concept in: "${c.text.slice(0, 100)}..."`,
                        back: c.text,
                        concept: 'Concept Review'
                    }));
                }

                answers = dueCards.map(() => null);
                currentIdx = 0;
                startReview();
            }

            /* ══ PHASE 3: REVIEW LOOP (FRONT QUESTION -> REVEAL BACK -> RATING) ══ */
            function startReview() {
                showPhase('Review');
                renderStats();
                renderCard(currentIdx);
            }

            function renderStats() {
                const total   = dueCards.length;
                const newCnt  = dueCards.filter(c => c.fsrs.state === 0).length;
                const revCnt  = dueCards.filter(c => c.fsrs.state === 2).length;
                const relCnt  = dueCards.filter(c => c.fsrs.state === 3).length;
                container.querySelector('#fsrStats').innerHTML = `
                    <div class="fsr-stat"><div class="fsr-stat-val">${total}</div><div class="fsr-stat-label">In Session</div></div>
                    <div class="fsr-stat"><div class="fsr-stat-val">${newCnt}</div><div class="fsr-stat-label">New</div></div>
                    <div class="fsr-stat"><div class="fsr-stat-val">${revCnt}</div><div class="fsr-stat-label">Review</div></div>
                    <div class="fsr-stat"><div class="fsr-stat-val">${relCnt}</div><div class="fsr-stat-label">Relearn</div></div>`;
            }

            function renderCard(idx) {
                setProgress(idx, dueCards.length);
                const card = dueCards[idx];
                const q    = questions[idx];
                const body = container.querySelector('#fsrReviewBody');

                const stateLabel = card.fsrs.state === 0 ? 'New' : card.fsrs.state === 3 ? 'Relearn' : 'Review';
                const stateClass = card.fsrs.state === 0 ? 'fsr-badge-new' : card.fsrs.state === 3 ? 'fsr-badge-relearn' : 'fsr-badge-review';

                body.innerHTML = `
                <span class="fsr-card-counter">Card ${idx + 1} of ${dueCards.length}</span>
                <div class="fsr-flashcard-box">
                    <div class="fsr-card-meta">
                        <span class="fsr-card-src">📄 ${card.sourceName}</span>
                        <div class="fsr-card-badge">
                            <span class="fsr-badge ${stateClass}">${stateLabel}</span>
                        </div>
                    </div>
                    
                    <div class="fsr-front-text">❓ ${escHTML(q.front)}</div>
                    
                    <div class="fsr-hint-container">
                        <button class="fsr-hint-toggle" id="fsrHintToggle">💡 View Source Context</button>
                        <div class="fsr-hint-content" id="fsrHintContent">${escHTML(card.text)}</div>
                    </div>

                    <div id="fsrBackArea" class="hidden">
                        <div class="fsr-back-divider"></div>
                        <div class="fsr-back-text">💡 <strong>Answer:</strong> ${escHTML(q.back)}</div>
                    </div>
                </div>
                
                <div id="fsrActionArea" style="display: flex; flex-direction: column;">
                    <button class="fsr-reveal-btn" id="fsrRevealBtn">Reveal Answer</button>
                </div>`;

                // Bind collapsible hint toggle
                const hintToggle = body.querySelector('#fsrHintToggle');
                const hintContent = body.querySelector('#fsrHintContent');
                hintToggle.addEventListener('click', () => {
                    const isVisible = hintContent.classList.toggle('visible');
                    hintToggle.textContent = isVisible ? '💡 Hide Source Context' : '💡 View Source Context';
                });

                // Bind reveal button
                const revealBtn = body.querySelector('#fsrRevealBtn');
                const backArea = body.querySelector('#fsrBackArea');
                const actionArea = body.querySelector('#fsrActionArea');

                revealBtn.addEventListener('click', () => {
                    backArea.classList.remove('hidden');
                    revealBtn.classList.add('hidden');
                    
                    // Show FSRS self-grading buttons
                    actionArea.innerHTML = `
                    <div class="fsr-rating-row">
                        <button class="fsr-rating-btn again" data-rate="1">Again<span>&lt;10m</span></button>
                        <button class="fsr-rating-btn hard" data-rate="2">Hard<span>1d</span></button>
                        <button class="fsr-rating-btn good" data-rate="3">Good<span>4d</span></button>
                        <button class="fsr-rating-btn easy" data-rate="4">Easy<span>7d</span></button>
                    </div>`;

                    // Bind rating buttons
                    const rateBtns = actionArea.querySelectorAll('.fsr-rating-btn');
                    rateBtns.forEach(btn => {
                        btn.addEventListener('click', () => {
                            const rate = parseInt(btn.getAttribute('data-rate'));
                            submitRating(idx, rate);
                        });
                    });
                });
            }

            async function submitRating(idx, rating) {
                const card = dueCards[idx];
                const newFSRS = fsrsSchedule(deck.sources[card.srcIdx].chunks[card.chunkIdx].fsrs || fsrsInit(), rating);
                deck.sources[card.srcIdx].chunks[card.chunkIdx].fsrs = newFSRS;

                // Persist FSRS variables instantly on click
                try {
                    if (typeof window.saveDecks === 'function') {
                        if (window.decks) {
                            const di = window.decks.findIndex(d => d.id === deck.id);
                            if (di !== -1) window.decks[di] = deck;
                        }
                        await window.saveDecks();
                    } else {
                        const allDecks = await window.dbStore.get('decks') || [];
                        const di = allDecks.findIndex(d => d.id === deck.id);
                        if (di !== -1) allDecks[di] = deck;
                        await window.dbStore.set('decks', allDecks);
                    }
                } catch (e) {
                    console.error('[FSRS] Quick save failed:', e);
                }

                // Record answers stats for final report page
                answers[idx] = { rating: rating, newFSRS: newFSRS };

                // Advance
                currentIdx++;
                if (currentIdx >= dueCards.length) {
                    showResultsPage();
                } else {
                    renderCard(currentIdx);
                }
            }

            /* ══ PHASE 4: SUMMARY PAGE ══ */
            function showResultsPage() {
                setProgress(dueCards.length, dueCards.length);
                showPhase('Results');

                const body = container.querySelector('#fsrResultsBody');

                const gradeLabels = ['', 'Again','Hard','Good','Easy'];
                const gradeClasses = ['','fsr-r1','fsr-r2','fsr-r3','fsr-r4'];

                // Analyze mastered concepts (Good/Easy ratings) and focuses (Again/Hard ratings)
                const conceptResults = {};
                questions.forEach((q, i) => {
                    const ans = answers[i];
                    if (!ans) return;
                    const isPassed = ans.rating >= 3; // Good or Easy counts as mastered
                    const concept = q.concept || 'General Review';
                    if (!conceptResults[concept]) conceptResults[concept] = [];
                    conceptResults[concept].push(isPassed);
                });

                const strengths = Object.keys(conceptResults).filter(c => conceptResults[c].every(x => x));
                const weaknesses = Object.keys(conceptResults).filter(c => conceptResults[c].some(x => !x));

                const strengthList = strengths.map(s =>
                    `<div style="display:flex;align-items:flex-start;gap:8px;font-size:.8125rem;color:var(--text-label);line-height:1.4;"><span style="flex-shrink:0;">✅</span><span>${escHTML(s)}</span></div>`).join('');
                
                const weakList = weaknesses.map(w =>
                    `<div class="fsr-weakness-item">${escHTML(w)}</div>`).join('');

                // Calculate percentage score (Good/Easy vs total)
                const correctCount = answers.filter(a => a && a.rating >= 3).length;
                const score = dueCards.length ? Math.round((correctCount / dueCards.length) * 100) : 0;
                const scoreColor = score >= 80 ? '#10b981' : score >= 55 ? '#f59e0b' : '#ef4444';

                const cardResults = dueCards.map((card, i) => {
                    const q = questions[i];
                    const a = answers[i];
                    if (!a) return '';

                    return `
                    <div class="fsr-card-result">
                        <div class="fsr-result-header">
                            <span style="font-weight:600;color:var(--text-label);">${escHTML(card.sourceName)}</span>
                            <div style="display:flex;align-items:center;gap:6px;">
                                <span class="fsr-result-rating ${gradeClasses[a.rating]}">${gradeLabels[a.rating]}</span>
                                <span class="fsr-next-due">📅 ${dueLabel(a.newFSRS.due)}</span>
                            </div>
                        </div>
                        <div class="fsr-result-q"><strong>Front:</strong> ${escHTML(q.front)}</div>
                        <div class="fsr-result-comment" style="opacity:0.85;"><strong>Back:</strong> ${escHTML(q.back)}</div>
                    </div>`;
                }).join('');

                body.innerHTML = `
                <div class="fsr-score-top">
                    <svg class="fsr-score-ring" viewBox="0 0 72 72">
                        <circle cx="36" cy="36" r="30" fill="none" stroke="var(--border-color)" stroke-width="7"/>
                        <circle cx="36" cy="36" r="30" fill="none" stroke="${scoreColor}" stroke-width="7"
                            stroke-dasharray="${Math.round(2 * Math.PI * 30)}"
                            stroke-dashoffset="${Math.round(2 * Math.PI * 30 * (1 - score / 100))}"
                            stroke-linecap="round" transform="rotate(-90 36 36)"/>
                        <text x="36" y="41" text-anchor="middle" font-size="13" font-weight="800" fill="${scoreColor}">${score}%</text>
                    </svg>
                    <div class="fsr-score-info">
                        <div class="fsr-score-pct">${score >= 80 ? '🎉 Session Complete!' : score >= 55 ? '📈 Strong Effort!' : '💪 Keep Learning!'}</div>
                        <div class="fsr-score-sub">${dueCards.length} flashcard${dueCards.length > 1 ? 's' : ''} reviewed · FSRS memory states updated.</div>
                    </div>
                </div>

                ${strengthList ? `<div class="fsr-section-title">Mastered Concepts</div><div class="fsr-weakness-list">${strengthList}</div>` : ''}
                ${weakList ? `<div class="fsr-section-title">Concepts to Focus On</div><div class="fsr-weakness-list">${weakList}</div>` : ''}

                <div class="fsr-section-title">Card Breakdown</div>
                ${cardResults}

                <button class="fsr-restart-btn" id="fsrRestartBtn">🔄 Review Again</button>`;

                container.querySelector('#fsrRestartBtn').addEventListener('click', () => {
                    currentIdx = 0; answers = []; questions = []; dueCards = [];
                    showSetupScreen();
                });
            }

            /* ── tiny HTML escaper ── */
            function escHTML(s) {
                return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
            }

            /* ── kick off ── */
            showSetupScreen();
        }
    };

    window.NeuroSparkTools.push(toolDefinition);
    console.log('[Tools] Loaded tool: ' + toolDefinition.name);
})();
