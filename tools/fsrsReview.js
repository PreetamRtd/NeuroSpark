/**
 * NeuroSpark Tool: FSRS Smart Review
 * Each vector chunk = an Anki-style spaced-repetition card.
 * Uses FSRS v4 algorithm to schedule reviews.
 * AI generates questions from due cards in a single initial call.
 * Auto-grades MCQ/TF/Blank locally; self-rates short answers.
 * Updates FSRS variables in IndexedDB.
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

    function fileToBase64(file) {
        return new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res({ data: r.result.split(',')[1], mimeType: file.type });
            r.onerror = rej;
            r.readAsDataURL(file);
        });
    }

    /* ══════════════════════════════════════════════════════
       DUE CARD DISCOVERY
     ══════════════════════════════════════════════════════ */
    function ensureFSRS(chunk) {
        if (!chunk.fsrs) chunk.fsrs = fsrsInit();
        return chunk;
    }

    function isDue(chunk) {
        ensureFSRS(chunk);
        if (chunk.fsrs.state === 0) return true; // new card
        return new Date(chunk.fsrs.due) <= new Date();
    }

    function collectDueCards(deck) {
        const due = [];
        (deck.sources || []).forEach((src, si) => {
            (src.chunks || []).forEach((chunk, ci) => {
                ensureFSRS(chunk);
                if (isDue(chunk)) {
                    due.push({
                        srcIdx: si, chunkIdx: ci,
                        text: chunk.text,
                        fsrs: { ...chunk.fsrs },
                        sourceName: src.name
                    });
                }
            });
        });
        // Shuffle + cap
        for (let i = due.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [due[i], due[j]] = [due[j], due[i]];
        }
        return due.slice(0, MAX_SESSION);
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
/* states */
.fsr-phase{display:flex;flex-direction:column;gap:14px;height:100%;}
.fsr-phase.hidden{display:none;}
/* stats row */
.fsr-stats{display:flex;gap:10px;flex-shrink:0;}
.fsr-stat{flex:1;background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:3px;}
.fsr-stat-val{font-size:1.25rem;font-weight:700;color:var(--primary-color);}
.fsr-stat-label{font-size:.6875rem;color:var(--text-muted);}
/* card */
.fsr-card{background:var(--bg-input);border:1px solid var(--border-color);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;flex-shrink:0;}
.fsr-card-meta{display:flex;align-items:center;justify-content:space-between;font-size:.6875rem;color:var(--text-muted);}
.fsr-card-src{font-weight:600;color:var(--text-label);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;}
.fsr-card-badge{display:flex;align-items:center;gap:4px;}
.fsr-badge{padding:2px 8px;border-radius:20px;font-size:.625rem;font-weight:600;border:1px solid;}
.fsr-badge-new{color:#6366f1;border-color:#6366f1;}
.fsr-badge-review{color:#34d399;border-color:#34d399;}
.fsr-badge-relearn{color:#f87171;border-color:#f87171;}
/* collapsible hint */
.fsr-hint-container{margin-top:4px;}
.fsr-hint-toggle{background:none;border:1px solid var(--border-color);border-radius:6px;color:var(--text-muted);font-size:.75rem;padding:6px 12px;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .15s ease;}
.fsr-hint-toggle:hover{border-color:var(--primary-color);color:var(--primary-color);background:var(--bg-hover);}
.fsr-hint-content{display:none;margin-top:8px;font-size:.75rem;color:var(--text-muted);line-height:1.5;background:var(--bg-card);border-left:3px solid var(--primary-color);padding:10px 12px;border-radius:4px;max-height:160px;overflow-y:auto;}
.fsr-hint-content.visible{display:block;}
.fsr-question{font-size:.9rem;font-weight:600;color:var(--text-color);line-height:1.5;margin-top:4px;}
/* options / MCQ */
.fsr-options-grid{display:grid;grid-template-columns:1fr;gap:8px;margin-top:8px;flex-shrink:0;}
.fsr-option-card{background:var(--bg-card);border:1px solid var(--border-color);border-radius:8px;padding:12px;font-size:.8125rem;color:var(--text-color);cursor:pointer;text-align:left;transition:all .12s ease;display:flex;align-items:center;gap:10px;width:100%;outline:none;}
.fsr-option-card:hover:not(.disabled){border-color:var(--primary-color);background:var(--bg-hover);}
.fsr-option-badge{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;border:1px solid var(--border-color);font-size:.75rem;font-weight:600;flex-shrink:0;color:var(--text-muted);}
.fsr-option-card.selected{border-color:var(--primary-color);background:var(--bg-hover);}
.fsr-option-card.correct{border-color:#10b981!important;background:rgba(16,185,129,0.08)!important;color:#065f46!important;font-weight:500;}
body.dark-theme .fsr-option-card.correct{color:#a7f3d0!important;background:rgba(16,185,129,0.15)!important;}
.fsr-option-card.incorrect{border-color:#ef4444!important;background:rgba(239,68,68,0.08)!important;color:#991b1b!important;}
body.dark-theme .fsr-option-card.incorrect{color:#fca5a5!important;background:rgba(239,68,68,0.15)!important;}
.fsr-option-card.disabled{cursor:not-allowed;opacity:.7;}
/* True / False */
.fsr-tf-row{display:flex;gap:10px;margin-top:8px;flex-shrink:0;}
.fsr-tf-btn{flex:1;padding:14px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-card);color:var(--text-color);font-size:.875rem;font-weight:600;cursor:pointer;transition:all .12s ease;outline:none;}
.fsr-tf-btn:hover:not(.disabled){background:var(--bg-hover);}
.fsr-tf-btn.tf-true:hover:not(.disabled){border-color:#10b981;color:#10b981;}
.fsr-tf-btn.tf-false:hover:not(.disabled){border-color:#ef4444;color:#ef4444;}
.fsr-tf-btn.correct{border-color:#10b981!important;background:rgba(16,185,129,0.08)!important;color:#065f46!important;}
body.dark-theme .fsr-tf-btn.correct{color:#a7f3d0!important;background:rgba(16,185,129,0.15)!important;}
.fsr-tf-btn.incorrect{border-color:#ef4444!important;background:rgba(239,68,68,0.08)!important;color:#991b1b!important;}
body.dark-theme .fsr-tf-btn.incorrect{color:#fca5a5!important;background:rgba(239,68,68,0.15)!important;}
.fsr-tf-btn.disabled{cursor:not-allowed;opacity:.7;}
/* Fill Blank */
.fsr-blank-row{display:flex;gap:8px;margin-top:8px;flex-shrink:0;}
.fsr-blank-input{flex:1;padding:10px 12px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-card);color:var(--text-color);font-size:.8125rem;outline:none;transition:border-color .15s;}
.fsr-blank-input:focus{border-color:var(--primary-color);}
.fsr-blank-btn{padding:10px 16px;border-radius:8px;border:none;background:var(--primary-color);color:#fff;font-size:.8125rem;font-weight:600;cursor:pointer;transition:opacity .12s;}
.fsr-blank-btn:hover{opacity:.9;}
.fsr-blank-btn:disabled{opacity:.5;cursor:not-allowed;}
.fsr-blank-feedback{display:flex;align-items:center;gap:6px;font-size:.8125rem;font-weight:600;margin-top:6px;}
.fsr-blank-feedback.correct{color:#10b981;}
.fsr-blank-feedback.incorrect{color:#ef4444;}
/* Short Answer / Textarea */
.fsr-answer-wrap{display:flex;flex-direction:column;gap:8px;flex-shrink:0;margin-top:8px;}
.fsr-answer{width:100%;min-height:80px;padding:10px 12px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-card);color:var(--text-color);font-size:.8125rem;font-family:var(--font-sans);resize:none;outline:none;line-height:1.5;transition:border-color .15s;}
.fsr-answer:focus{border-color:var(--primary-color);}
.fsr-media-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.fsr-media-btn{display:flex;align-items:center;gap:5px;padding:5px 12px;border-radius:6px;border:1px solid var(--border-color);background:none;color:var(--text-muted);font-size:.75rem;cursor:pointer;transition:all .12s;}
.fsr-media-btn:hover{color:var(--primary-color);border-color:var(--primary-color);background:var(--bg-hover);}
.fsr-media-preview{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.fsr-img-thumb{width:40px;height:40px;object-fit:cover;border-radius:4px;border:1px solid var(--border-color);}
.fsr-audio-chip{display:flex;align-items:center;gap:6px;padding:3px 8px;border-radius:20px;border:1px solid var(--border-color);font-size:.6875rem;color:var(--text-muted);}
.fsr-audio-chip.recording{border-color:#ef4444;color:#ef4444;animation:badge-pulse 1s infinite;}
.fsr-remove-btn{background:none;border:none;color:var(--text-muted);cursor:pointer;padding:0;font-size:.75rem;line-height:1;}
/* general explanation box */
.fsr-explanation-box{margin-top:10px;padding:12px;background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;font-size:.75rem;line-height:1.5;animation:fsrFadeIn .25s ease;}
.fsr-explanation-title{font-weight:700;color:var(--text-label);margin-bottom:4px;display:flex;align-items:center;gap:4px;}
/* self rating row */
.fsr-self-rate-row{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px;}
.fsr-self-rate-btn{padding:8px 4px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-card);color:var(--text-color);font-size:.75rem;font-weight:600;cursor:pointer;transition:all .12s ease;display:flex;flex-direction:column;align-items:center;gap:2px;outline:none;}
.fsr-self-rate-btn span{font-size:.625rem;font-weight:400;color:var(--text-muted);}
.fsr-self-rate-btn.again:hover{border-color:#ef4444;background:rgba(239,68,68,0.05);color:#ef4444;}
.fsr-self-rate-btn.hard:hover{border-color:#f59e0b;background:rgba(245,158,11,0.05);color:#f59e0b;}
.fsr-self-rate-btn.good:hover{border-color:#10b981;background:rgba(16,185,129,0.05);color:#10b981;}
.fsr-self-rate-btn.easy:hover{border-color:#6366f1;background:rgba(99,102,241,0.05);color:#6366f1;}

.fsr-next-btn{padding:9px 22px;border-radius:8px;border:none;background:var(--primary-color);color:#fff;font-size:.875rem;font-weight:600;cursor:pointer;transition:opacity .15s;align-self:flex-end;margin-top:10px;}
.fsr-next-btn:hover{opacity:.95;}
.fsr-next-btn:disabled{opacity:.5;cursor:not-allowed;}
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
.fsr-feedback-box{background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;padding:12px 14px;font-size:.8125rem;color:var(--text-label);line-height:1.6;}
.fsr-weakness-list{display:flex;flex-direction:column;gap:6px;margin-bottom:8px;}
.fsr-weakness-item{display:flex;align-items:flex-start;gap:8px;font-size:.8125rem;color:var(--text-label);line-height:1.4;}
.fsr-weakness-item::before{content:'⚠️';flex-shrink:0;}
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
        description: 'FSRS spaced repetition — Auto-generated concept-based quizzes with MCQ, T/F, blanks, & self-rated short answers.',
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

  <!-- DISCOVERY phase -->
  <div class="fsr-phase" id="fsrPhaseDiscover">
    <div class="fsr-spinner"><div class="fsr-dot"></div><span id="fsrDiscoverMsg">Scanning cards…</span></div>
  </div>

  <!-- GENERATING phase -->
  <div class="fsr-phase hidden" id="fsrPhaseGenerating">
    <div class="fsr-spinner"><div class="fsr-dot"></div><span id="fsrGeneratingMsg">AI is crafting questions…</span></div>
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
      <span id="fsrEmptyMsg">No cards due for review today.</span>
      <span style="font-size:.6875rem;">Come back tomorrow or upload more documents.</span>
    </div>
  </div>
</div>`;

            container.querySelector('#fsrBack').addEventListener('click', onBack);

            /* ── helpers to show/hide phases ── */
            const phases = ['Discover','Generating','Review','Results','Empty'];
            function showPhase(name) {
                phases.forEach(p => container.querySelector(`#fsrPhase${p}`).classList.toggle('hidden', p !== name));
            }

            /* ── session state ── */
            let dueCards   = [];
            let questions  = [];
            let answers    = [];   // { text, rating, firstTryCorrect, images, audioText }
            let currentIdx = 0;
            let mediaRecorder = null;
            let audioChunks   = [];

            function setProgress(n, total) {
                const pct = total ? Math.round((n / total) * 100) : 0;
                container.querySelector('#fsrProgress').style.width = pct + '%';
            }

            /* ══ PHASE 1: DISCOVER ══ */
            async function startDiscover() {
                showPhase('Discover');
                container.querySelector('#fsrDiscoverMsg').textContent = 'Scanning cards…';

                if (!deck.sources || deck.sources.length === 0) {
                    showPhase('Empty');
                    container.querySelector('#fsrEmptyMsg').textContent = 'No source documents in this Deck. Upload files first.';
                    return;
                }

                dueCards = collectDueCards(deck);

                if (dueCards.length === 0) {
                    const total = (deck.sources || []).reduce((a, s) => a + (s.chunks || []).length, 0);
                    if (total === 0) {
                        showPhase('Empty');
                        container.querySelector('#fsrEmptyMsg').textContent = 'No vector chunks found. Upload and embed documents first.';
                    } else {
                        showPhase('Empty');
                    }
                    return;
                }

                container.querySelector('#fsrDiscoverMsg').textContent = `Found ${dueCards.length} due card${dueCards.length > 1 ? 's' : ''}. Generating questions…`;
                await generateQuestions();
            }

            /* ══ PHASE 2: GENERATE QUESTIONS (SINGLE LLM CHAT) ══ */
            async function generateQuestions() {
                showPhase('Generating');
                const total = dueCards.length;
                container.querySelector('#fsrGeneratingMsg').textContent = `AI is designing your customized quiz (${total} cards)…`;

                const chunks = dueCards.map((c, i) =>
                    `Card ${i + 1} [Source: ${c.sourceName}]:\n"""\n${c.text.slice(0, 600)}\n"""`
                ).join('\n\n---\n\n');

                const prompt = `You are an expert tutor designing a spaced-repetition quiz for a student.
For each of the ${total} cards below, generate exactly ONE question.

IMPORTANT: The question must test deep conceptual understanding or application of examples from the card.
DO NOT ask superficial questions like "What does this text discuss?" or "Summarize this passage".
DO NOT show the correct answer or spoil the question in the question text.

For each card, choose the most appropriate question type based on the content:
1. "mcq" (Multiple Choice Question): Use this for concepts with clear alternatives. Provide exactly 4 options.
2. "true_false": Use this for clear statements of fact, definitions, or principles.
3. "fill_blank": Use this for key terms, definitions or formulas. Replace the key word/phrase in the question with "_______".
4. "short_answer": Use this for open-ended conceptual explanations or code/math problems.

Cards:
${chunks}

Return ONLY a valid JSON object matching this structure (no markdown wrapper, no other text):
{
  "questions": [
    {
      "idx": 0,
      "type": "mcq",
      "question": "Which of the following best describes...",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "Option B",
      "explanation": "Explanation of why Option B is correct based on...",
      "concept": "Concept Name"
    },
    ...
  ]
}`;

                try {
                    const raw  = await callAI(prompt);
                    const data = parseJSON(raw);
                    questions  = data.questions || [];

                    if (questions.length !== total) {
                        // Align array length if LLM missed some
                        throw new Error('Incomplete question count returned');
                    }
                } catch (err) {
                    console.warn('[FSRS] Question generation fallback:', err);
                    questions = dueCards.map((c, i) => ({
                        idx: i,
                        type: 'short_answer',
                        question: `Explain and verify your understanding of the concept: "${c.text.slice(0, 100)}..."`,
                        correctAnswer: c.text,
                        explanation: 'Review the source material to assess your knowledge.',
                        concept: 'Recall Practice'
                    }));
                }

                answers = dueCards.map(() => ({ text: '', rating: null, firstTryCorrect: null, images: [], audioText: '' }));
                currentIdx = 0;
                startReview();
            }

            /* ══ PHASE 3: REVIEW LOOP ══ */
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
                    <div class="fsr-stat"><div class="fsr-stat-val">${total}</div><div class="fsr-stat-label">Due today</div></div>
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

                const ans = answers[idx];

                // Base card header & collapsible context hint (zero spoilers by default)
                let html = `
                <span class="fsr-card-counter">Card ${idx + 1} of ${dueCards.length}</span>
                <div class="fsr-card">
                    <div class="fsr-card-meta">
                        <span class="fsr-card-src">📄 ${card.sourceName}</span>
                        <div class="fsr-card-badge">
                            <span class="fsr-badge ${stateClass}">${stateLabel}</span>
                        </div>
                    </div>
                    
                    <div class="fsr-question">❓ ${escHTML(q.question)}</div>
                    
                    <div class="fsr-hint-container">
                        <button class="fsr-hint-toggle" id="fsrHintToggle">💡 View Source Context</button>
                        <div class="fsr-hint-content" id="fsrHintContent">${escHTML(card.text)}</div>
                    </div>
                </div>
                
                <div id="fsrInteractionArea"></div>
                <div id="fsrExplanationArea"></div>`;

                body.innerHTML = html;

                // Bind collapsible hint toggle
                const hintToggle = body.querySelector('#fsrHintToggle');
                const hintContent = body.querySelector('#fsrHintContent');
                hintToggle.addEventListener('click', () => {
                    const isVisible = hintContent.classList.toggle('visible');
                    hintToggle.textContent = isVisible ? '💡 Hide Source Context' : '💡 View Source Context';
                });

                // Render specific input based on question type
                renderInteraction(idx, q, ans);
            }

            function renderInteraction(idx, q, ans) {
                const area = container.querySelector('#fsrInteractionArea');
                const explArea = container.querySelector('#fsrExplanationArea');

                if (q.type === 'mcq') {
                    let optionsHTML = (q.options || []).map((opt, oIdx) => {
                        const letter = String.fromCharCode(65 + oIdx); // A, B, C, D
                        return `
                        <button class="fsr-option-card" data-index="${oIdx}">
                            <span class="fsr-option-badge">${letter}</span>
                            <span style="line-height: 1.3;">${escHTML(opt)}</span>
                        </button>`;
                    }).join('');

                    area.innerHTML = `
                    <div class="fsr-options-grid">
                        ${optionsHTML}
                    </div>
                    <button class="fsr-next-btn hidden" id="fsrNextBtn">Next Question →</button>`;

                    const optBtns = area.querySelectorAll('.fsr-option-card');
                    optBtns.forEach(btn => {
                        btn.addEventListener('click', () => {
                            if (ans.firstTryCorrect !== null) return; // already answered
                            const selectedIdx = parseInt(btn.getAttribute('data-index'));
                            const selectedVal = q.options[selectedIdx];
                            const correctVal  = q.correctAnswer;

                            const isCorrect = (selectedVal === correctVal || selectedIdx === q.options.indexOf(correctVal));
                            ans.firstTryCorrect = isCorrect;
                            ans.text = selectedVal;
                            ans.rating = isCorrect ? 3 : 1; // Good if correct, Again if wrong

                            // Visual Feedback
                            optBtns.forEach((b, bIdx) => {
                                b.classList.add('disabled');
                                const val = q.options[bIdx];
                                if (val === correctVal || bIdx === q.options.indexOf(correctVal)) {
                                    b.classList.add('correct');
                                } else if (bIdx === selectedIdx) {
                                    b.classList.add('incorrect');
                                }
                            });

                            // Display Explanation
                            explArea.innerHTML = `
                            <div class="fsr-explanation-box">
                                <div class="fsr-explanation-title">📝 Explanation</div>
                                <div>${escHTML(q.explanation || 'Study the context source card details above.')}</div>
                            </div>`;

                            // Show Next button
                            const nextBtn = area.querySelector('#fsrNextBtn');
                            nextBtn.classList.remove('hidden');
                            nextBtn.focus();
                        });
                    });

                    area.querySelector('#fsrNextBtn').addEventListener('click', advanceCard);

                } else if (q.type === 'true_false') {
                    area.innerHTML = `
                    <div class="fsr-tf-row">
                        <button class="fsr-tf-btn tf-true" data-value="true">True</button>
                        <button class="fsr-tf-btn tf-false" data-value="false">False</button>
                    </div>
                    <button class="fsr-next-btn hidden" id="fsrNextBtn">Next Question →</button>`;

                    const tfBtns = area.querySelectorAll('.fsr-tf-btn');
                    tfBtns.forEach(btn => {
                        btn.addEventListener('click', () => {
                            if (ans.firstTryCorrect !== null) return;
                            const val = btn.getAttribute('data-value');
                            const correctVal = String(q.correctAnswer).toLowerCase().trim();

                            const isCorrect = (val === correctVal);
                            ans.firstTryCorrect = isCorrect;
                            ans.text = val;
                            ans.rating = isCorrect ? 3 : 1;

                            tfBtns.forEach(b => {
                                b.classList.add('disabled');
                                const bVal = b.getAttribute('data-value');
                                if (bVal === correctVal) {
                                    b.classList.add('correct');
                                } else if (bVal === val) {
                                    b.classList.add('incorrect');
                                }
                            });

                            explArea.innerHTML = `
                            <div class="fsr-explanation-box">
                                <div class="fsr-explanation-title">📝 Explanation</div>
                                <div>${escHTML(q.explanation || 'Study the details in the source card.')}</div>
                            </div>`;

                            const nextBtn = area.querySelector('#fsrNextBtn');
                            nextBtn.classList.remove('hidden');
                            nextBtn.focus();
                        });
                    });

                    area.querySelector('#fsrNextBtn').addEventListener('click', advanceCard);

                } else if (q.type === 'fill_blank') {
                    area.innerHTML = `
                    <div class="fsr-blank-row">
                        <input type="text" class="fsr-blank-input" id="fsrBlankInput" placeholder="Type your answer here..." autocomplete="off">
                        <button class="fsr-blank-btn" id="fsrBlankSubmit">Check</button>
                    </div>
                    <div id="fsrBlankFeedback"></div>
                    <button class="fsr-next-btn hidden" id="fsrNextBtn">Next Question →</button>`;

                    const input  = area.querySelector('#fsrBlankInput');
                    const submit = area.querySelector('#fsrBlankSubmit');
                    const fb     = area.querySelector('#fsrBlankFeedback');

                    function checkAnswer() {
                        if (ans.firstTryCorrect !== null) return;
                        const userVal = input.value.trim();
                        if (!userVal) return;

                        const clean = (str) => String(str || '')
                            .toLowerCase()
                            .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"")
                            .replace(/\s+/g," ")
                            .trim();

                        const correctVal = q.correctAnswer;
                        const isCorrect = (clean(userVal) === clean(correctVal));

                        ans.firstTryCorrect = isCorrect;
                        ans.text = userVal;
                        ans.rating = isCorrect ? 3 : 1;

                        input.disabled = true;
                        submit.disabled = true;

                        if (isCorrect) {
                            fb.className = 'fsr-blank-feedback correct';
                            fb.innerHTML = '✨ Correct!';
                        } else {
                            fb.className = 'fsr-blank-feedback incorrect';
                            fb.innerHTML = `❌ Incorrect. Correct answer: <strong>${escHTML(correctVal)}</strong>`;
                        }

                        explArea.innerHTML = `
                        <div class="fsr-explanation-box">
                            <div class="fsr-explanation-title">📝 Explanation</div>
                            <div>${escHTML(q.explanation || 'Study the details in the source card.')}</div>
                        </div>`;

                        const nextBtn = area.querySelector('#fsrNextBtn');
                        nextBtn.classList.remove('hidden');
                        nextBtn.focus();
                    }

                    submit.addEventListener('click', checkAnswer);
                    input.addEventListener('keydown', e => {
                        if (e.key === 'Enter') { e.preventDefault(); checkAnswer(); }
                    });
                    input.focus();

                    area.querySelector('#fsrNextBtn').addEventListener('click', advanceCard);

                } else {
                    // Short Answer (Classic free-text, voice, images, with self-rating buttons)
                    area.innerHTML = `
                    <div class="fsr-answer-wrap">
                        <textarea class="fsr-answer" id="fsrAnswerText" placeholder="Type your explanation or answer..." spellcheck="true">${escHTML(ans.text)}</textarea>

                        <div class="fsr-media-row">
                            <label class="fsr-media-btn" for="fsrImgInput" title="Attach image">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> Image
                            </label>
                            <input type="file" id="fsrImgInput" accept="image/*" multiple style="display:none;">
                            <button class="fsr-media-btn" id="fsrAudioBtn" title="Record audio">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                                <span id="fsrAudioLabel">Record</span>
                            </button>
                            <div class="fsr-media-preview" id="fsrMediaPreview"></div>
                        </div>

                        <button class="fsr-next-btn" style="align-self:flex-start; margin-top:2px;" id="fsrShowBtn">Reveal Answer</button>
                    </div>
                    <div id="fsrSelfRateArea" class="hidden">
                        <div class="fsr-self-rate-row">
                            <button class="fsr-self-rate-btn again" data-rate="1">Again<span>&lt;10m</span></button>
                            <button class="fsr-self-rate-btn hard" data-rate="2">Hard<span>1d</span></button>
                            <button class="fsr-self-rate-btn good" data-rate="3">Good<span>4d</span></button>
                            <button class="fsr-self-rate-btn easy" data-rate="4">Easy<span>7d</span></button>
                        </div>
                    </div>`;

                    const textarea = area.querySelector('#fsrAnswerText');
                    const showBtn  = area.querySelector('#fsrShowBtn');
                    const selfRate = area.querySelector('#fsrSelfRateArea');

                    textarea.addEventListener('input', () => { ans.text = textarea.value; });
                    textarea.focus();

                    // Media previews & actions
                    renderMediaPreview(idx);
                    const imgInput = area.querySelector('#fsrImgInput');
                    imgInput.addEventListener('change', async () => {
                        for (const f of [...imgInput.files]) {
                            const b64 = await fileToBase64(f);
                            ans.images.push(b64);
                        }
                        renderMediaPreview(idx);
                    });
                    area.querySelector('#fsrAudioBtn').addEventListener('click', (e) => toggleRecord(idx, e.currentTarget));

                    showBtn.addEventListener('click', () => {
                        ans.text = textarea.value;
                        textarea.disabled = true;
                        showBtn.classList.add('hidden');
                        selfRate.classList.remove('hidden');

                        explArea.innerHTML = `
                        <div class="fsr-explanation-box">
                            <div class="fsr-explanation-title">🔑 Core Answer</div>
                            <div style="font-weight: 500; margin-bottom: 8px;">${escHTML(q.correctAnswer || '')}</div>
                            <div class="fsr-explanation-title">📝 Explanation</div>
                            <div>${escHTML(q.explanation || 'Compare your answer to the reference solution above.')}</div>
                        </div>`;
                    });

                    // Self rate click
                    const rateBtns = selfRate.querySelectorAll('.fsr-self-rate-btn');
                    rateBtns.forEach(btn => {
                        btn.addEventListener('click', () => {
                            const rate = parseInt(btn.getAttribute('data-rate'));
                            ans.rating = rate;
                            advanceCard();
                        });
                    });
                }
            }

            function renderMediaPreview(idx) {
                const prev = container.querySelector('#fsrMediaPreview');
                if (!prev) return;
                const ans = answers[idx];
                prev.innerHTML = '';

                ans.images.forEach((img, ii) => {
                    const el = document.createElement('img');
                    el.src = `data:${img.mimeType};base64,${img.data}`;
                    el.className = 'fsr-img-thumb';
                    el.title = 'Click to remove';
                    el.style.cursor = 'pointer';
                    el.addEventListener('click', () => { ans.images.splice(ii, 1); renderMediaPreview(idx); });
                    prev.appendChild(el);
                });

                if (ans.audioText) {
                    const chip = document.createElement('div');
                    chip.className = 'fsr-audio-chip';
                    chip.innerHTML = `🎙️ <span style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHTML(ans.audioText)}</span><button class="fsr-remove-btn">✕</button>`;
                    chip.querySelector('button').addEventListener('click', () => { ans.audioText = ''; renderMediaPreview(idx); });
                    prev.appendChild(chip);
                }
            }

            /* ── audio recording via SpeechRecognition (transcription) ── */
            function toggleRecord(idx, btn) {
                const label = btn.querySelector('#fsrAudioLabel');

                if (mediaRecorder && mediaRecorder.state === 'recording') {
                    mediaRecorder.stop();
                    return;
                }

                const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
                if (SpeechRec) {
                    const rec = new SpeechRec();
                    rec.lang = 'en-US'; rec.continuous = false; rec.interimResults = false;
                    label.textContent = '⏹ Stop';
                    btn.classList.add('recording');
                    rec.start();
                    rec.onresult = (e) => {
                        const transcript = e.results[0][0].transcript;
                        answers[idx].audioText = (answers[idx].audioText + ' ' + transcript).trim();
                        const ta = container.querySelector('#fsrAnswerText');
                        if (ta && !ta.value.includes(transcript)) {
                            ta.value = (ta.value + '\n' + transcript).trim();
                            answers[idx].text = ta.value;
                        }
                        renderMediaPreview(idx);
                    };
                    rec.onerror = () => { label.textContent = 'Record'; btn.classList.remove('recording'); };
                    rec.onend   = () => { label.textContent = 'Record'; btn.classList.remove('recording'); };
                    mediaRecorder = { state: 'recording', stop: () => rec.stop() };
                    return;
                }

                // Fallback: MediaRecorder
                navigator.mediaDevices.getUserMedia({ audio: true })
                    .then(stream => {
                        audioChunks = [];
                        const mr = new MediaRecorder(stream);
                        mr.ondataavailable = e => audioChunks.push(e.data);
                        mr.onstop = () => {
                            stream.getTracks().forEach(t => t.stop());
                            answers[idx].audioText = answers[idx].audioText ? answers[idx].audioText : '[Audio Recorded]';
                            renderMediaPreview(idx);
                            label.textContent = 'Record';
                            btn.classList.remove('recording');
                        };
                        mr.start();
                        mediaRecorder = mr;
                        label.textContent = '⏹ Stop';
                        btn.classList.add('recording');
                    })
                    .catch(() => alert('Microphone access denied or not available.'));
            }

            function advanceCard() {
                currentIdx++;
                if (currentIdx >= dueCards.length) {
                    applyResultsAndFinish();
                } else {
                    renderCard(currentIdx);
                }
            }

            /* ══ PHASE 4: APPLY + SAVE + LOCAL RESULTS ══ */
            async function applyResultsAndFinish() {
                setProgress(dueCards.length, dueCards.length);
                showPhase('Discover');
                container.querySelector('#fsrDiscoverMsg').textContent = 'Applying updates and scoring your session...';

                // Update FSRS parameters in deck object
                dueCards.forEach((card, i) => {
                    const rating = Math.min(4, Math.max(1, answers[i].rating || 2));
                    const newFSRS = fsrsSchedule(deck.sources[card.srcIdx].chunks[card.chunkIdx].fsrs || fsrsInit(), rating);
                    deck.sources[card.srcIdx].chunks[card.chunkIdx].fsrs = newFSRS;
                });

                // Persist to IndexedDB
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
                    console.error('[FSRS] Save failed:', e);
                }

                // Analyze strengths & weaknesses by concept
                const conceptResults = {};
                questions.forEach((q, i) => {
                    const isCorrect = q.type === 'short_answer' ? (answers[i].rating >= 3) : answers[i].firstTryCorrect;
                    const concept = q.concept || 'General Review';
                    if (!conceptResults[concept]) conceptResults[concept] = [];
                    conceptResults[concept].push(isCorrect);
                });
                
                const strengths = Object.keys(conceptResults).filter(c => conceptResults[c].every(x => x));
                const weaknesses = Object.keys(conceptResults).filter(c => conceptResults[c].some(x => !x));

                // Calculate total score
                const correctCount = answers.filter((a, i) => questions[i].type === 'short_answer' ? (a.rating >= 3) : a.firstTryCorrect).length;
                const score = Math.round((correctCount / dueCards.length) * 100);

                showResults({ score, strengths, weaknesses });
            }

            function showResults(result) {
                showPhase('Results');
                const score      = result.score;
                const scoreColor = score >= 80 ? '#10b981' : score >= 55 ? '#f59e0b' : '#ef4444';
                const body       = container.querySelector('#fsrResultsBody');

                const gradeLabels = ['', 'Again','Hard','Good','Easy'];
                const gradeClasses = ['','fsr-r1','fsr-r2','fsr-r3','fsr-r4'];

                const weakList = (result.weaknesses || []).map(w =>
                    `<div class="fsr-weakness-item">${escHTML(w)}</div>`).join('');

                const strengthList = (result.strengths || []).map(s =>
                    `<div style="display:flex;align-items:flex-start;gap:8px;font-size:.8125rem;color:var(--text-label);line-height:1.4;"><span style="flex-shrink:0;">✅</span><span>${escHTML(s)}</span></div>`).join('');

                const cardResults = dueCards.map((card, i) => {
                    const q    = questions[i];
                    const a    = answers[i];
                    const r    = Math.min(4, Math.max(1, a.rating || 2));
                    const newFSRS = deck.sources[card.srcIdx].chunks[card.chunkIdx].fsrs;

                    let userAnswerText = '';
                    if (q.type === 'mcq' || q.type === 'true_false' || q.type === 'fill_blank') {
                        userAnswerText = `Your Answer: "${a.text || '(none)'}" · ${a.firstTryCorrect ? '✅ Correct' : '❌ Incorrect'}`;
                    } else {
                        userAnswerText = `Your Answer: "${a.text || '(none)'}"`;
                    }

                    return `
                    <div class="fsr-card-result">
                        <div class="fsr-result-header">
                            <span style="font-weight:600;color:var(--text-label);">${escHTML(card.sourceName)}</span>
                            <div style="display:flex;align-items:center;gap:6px;">
                                <span class="fsr-result-rating ${gradeClasses[r]}">${gradeLabels[r]}</span>
                                ${newFSRS ? `<span class="fsr-next-due">📅 ${dueLabel(newFSRS.due)}</span>` : ''}
                            </div>
                        </div>
                        <div class="fsr-result-q"><strong>Q:</strong> ${escHTML(q.question)}</div>
                        <div class="fsr-result-comment" style="margin-top: 2px;">${escHTML(userAnswerText)}</div>
                        <div class="fsr-result-comment" style="opacity:0.85;"><strong>Correct answer:</strong> ${escHTML(q.correctAnswer)}</div>
                        ${q.explanation ? `<div class="fsr-result-comment" style="font-style: italic; border-top:1px dashed var(--border-color); padding-top:4px; margin-top:4px;">${escHTML(q.explanation)}</div>` : ''}
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
                        <div class="fsr-score-pct">${score >= 80 ? '🎉 Exceptional Study!' : score >= 55 ? '📈 Strong Effort!' : '💪 Keep Learning!'}</div>
                        <div class="fsr-score-sub">${dueCards.length} card${dueCards.length > 1 ? 's' : ''} reviewed · FSRS memory states updated.</div>
                    </div>
                </div>

                ${strengthList ? `<div class="fsr-section-title">Mastered Concepts</div><div class="fsr-weakness-list">${strengthList}</div>` : ''}
                ${weakList ? `<div class="fsr-section-title">Concepts to Focus On</div><div class="fsr-weakness-list">${weakList}</div>` : ''}

                <div class="fsr-section-title">Card Breakdown</div>
                ${cardResults}

                <button class="fsr-restart-btn" id="fsrRestartBtn">🔄 Review Again</button>`;

                container.querySelector('#fsrRestartBtn').addEventListener('click', () => {
                    currentIdx = 0; answers = []; questions = []; dueCards = [];
                    startDiscover();
                });
            }

            /* ── tiny HTML escaper ── */
            function escHTML(s) {
                return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
            }

            /* ── kick off ── */
            startDiscover();
        }
    };

    window.NeuroSparkTools.push(toolDefinition);
    console.log('[Tools] Loaded tool: ' + toolDefinition.name);
})();
