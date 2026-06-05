/**
 * NeuroSpark Tool: FSRS Smart Review
 * Each vector chunk = an Anki-style spaced-repetition card.
 * Uses FSRS v4 algorithm to schedule reviews.
 * AI generates questions from due cards; LLM grades answers
 * and updates FSRS variables in IndexedDB.
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
       AI HELPER  (cloud → fallback error)
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
                        generationConfig: { temperature: 0.3, maxOutputTokens: 3000 } }) }
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
                        max_tokens: 3000, temperature: 0.3 })
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

    /* ── parse JSON safely from AI response ── */
    function parseJSON(raw) {
        const t = raw.trim()
            .replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
        const s = t.indexOf('{'), e = t.lastIndexOf('}');
        if (s === -1 || e === -1) throw new Error('AI did not return valid JSON.');
        return JSON.parse(t.slice(s, e + 1));
    }

    /* ── file → base64 ── */
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
        if (chunk.fsrs.state === 0) return true; // new card — always due
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

    /* ── days until next review label ── */
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
.fsr-body{flex:1;display:flex;flex-direction:column;gap:12px;overflow-y:auto;min-height:0;}
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
.fsr-badge-new{color:#a78bfa;border-color:#a78bfa;}
.fsr-badge-review{color:#34d399;border-color:#34d399;}
.fsr-badge-relearn{color:#f87171;border-color:#f87171;}
.fsr-context{font-size:.75rem;color:var(--text-muted);line-height:1.5;border-left:2px solid var(--border-color);padding-left:10px;max-height:80px;overflow:hidden;position:relative;}
.fsr-context::after{content:'';position:absolute;bottom:0;left:0;right:0;height:24px;background:linear-gradient(transparent,var(--bg-input));}
.fsr-question{font-size:.875rem;font-weight:600;color:var(--text-color);line-height:1.5;}
/* answer area */
.fsr-answer-wrap{display:flex;flex-direction:column;gap:8px;flex-shrink:0;}
.fsr-answer{width:100%;min-height:90px;padding:10px 12px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-card);color:var(--text-color);font-size:.8125rem;font-family:var(--font-sans);resize:none;outline:none;line-height:1.5;transition:border-color .15s;}
.fsr-answer:focus{border-color:var(--primary-color);}
.fsr-media-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.fsr-media-btn{display:flex;align-items:center;gap:5px;padding:5px 12px;border-radius:6px;border:1px solid var(--border-color);background:none;color:var(--text-muted);font-size:.75rem;cursor:pointer;transition:all .12s;}
.fsr-media-btn:hover{color:var(--primary-color);border-color:var(--primary-color);}
.fsr-media-preview{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.fsr-img-thumb{width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid var(--border-color);}
.fsr-audio-chip{display:flex;align-items:center;gap:6px;padding:3px 8px;border-radius:20px;border:1px solid var(--border-color);font-size:.6875rem;color:var(--text-muted);}
.fsr-audio-chip.recording{border-color:#ef4444;color:#ef4444;animation:badge-pulse 1s infinite;}
.fsr-remove-btn{background:none;border:none;color:var(--text-muted);cursor:pointer;padding:0;font-size:.75rem;line-height:1;}
.fsr-next-btn{padding:9px 22px;border-radius:8px;border:none;background:var(--primary-color);color:#fff;font-size:.875rem;font-weight:600;cursor:pointer;transition:opacity .15s;align-self:flex-end;}
.fsr-next-btn:disabled{opacity:.5;cursor:not-allowed;}
.fsr-card-counter{font-size:.6875rem;color:var(--text-muted);align-self:flex-start;margin-top:-6px;}
/* spinner / placeholder */
.fsr-spinner{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:12px;color:var(--text-muted);font-size:.8125rem;}
.fsr-dot{width:10px;height:10px;border-radius:50%;background:var(--primary-color);animation:badge-pulse 1.2s infinite ease-in-out;}
.fsr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:12px;color:var(--text-muted);text-align:center;padding:24px;}
.fsr-empty svg{opacity:.3;}
.fsr-error{color:#ef4444;font-size:.75rem;text-align:center;padding:24px;line-height:1.5;}
/* results */
.fsr-results{display:flex;flex-direction:column;gap:14px;overflow-y:auto;}
.fsr-score-ring{width:72px;height:72px;flex-shrink:0;}
.fsr-score-top{display:flex;align-items:center;gap:16px;}
.fsr-score-info{display:flex;flex-direction:column;gap:4px;}
.fsr-score-pct{font-size:1.75rem;font-weight:800;color:var(--primary-color);}
.fsr-score-sub{font-size:.75rem;color:var(--text-muted);}
.fsr-feedback-box{background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;padding:14px;font-size:.8125rem;color:var(--text-label);line-height:1.6;}
.fsr-weakness-list{display:flex;flex-direction:column;gap:6px;}
.fsr-weakness-item{display:flex;align-items:flex-start;gap:8px;font-size:.8125rem;color:var(--text-label);line-height:1.4;}
.fsr-weakness-item::before{content:'⚠️';flex-shrink:0;}
.fsr-card-result{background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:6px;}
.fsr-result-header{display:flex;align-items:center;justify-content:space-between;font-size:.75rem;}
.fsr-result-q{font-size:.75rem;color:var(--text-label);font-style:italic;}
.fsr-result-rating{padding:2px 8px;border-radius:20px;font-size:.625rem;font-weight:700;border:1px solid;}
.fsr-r1{color:#f87171;border-color:#f87171;}
.fsr-r2{color:#fb923c;border-color:#fb923c;}
.fsr-r3{color:#34d399;border-color:#34d399;}
.fsr-r4{color:#a78bfa;border-color:#a78bfa;}
.fsr-result-comment{font-size:.75rem;color:var(--text-muted);}
.fsr-next-due{font-size:.6875rem;color:var(--text-muted);}
.fsr-section-title{font-size:.75rem;font-weight:700;color:var(--text-label);text-transform:uppercase;letter-spacing:.05em;}
.fsr-restart-btn{padding:9px 20px;border-radius:8px;border:1px solid var(--border-color);background:none;color:var(--text-muted);font-size:.8125rem;cursor:pointer;transition:all .15s;align-self:flex-start;}
.fsr-restart-btn:hover{border-color:var(--primary-color);color:var(--primary-color);}
</style>`;

    /* ══════════════════════════════════════════════════════
       TOOL DEFINITION
    ══════════════════════════════════════════════════════ */
    const toolDefinition = {
        id: 'fsrs-review',
        name: 'Smart Review',
        description: 'FSRS spaced repetition — AI questions from your documents, LLM grades your answers.',
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

  <!-- GRADING phase -->
  <div class="fsr-phase hidden" id="fsrPhaseGrading">
    <div class="fsr-spinner"><div class="fsr-dot"></div><span>LLM is grading your answers…</span></div>
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
            const phases = ['Discover','Generating','Review','Grading','Results','Empty'];
            function showPhase(name) {
                phases.forEach(p => container.querySelector(`#fsrPhase${p}`).classList.toggle('hidden', p !== name));
            }

            /* ── session state ── */
            let dueCards   = [];
            let questions  = [];
            let answers    = [];   // { text, images:[base64obj], audioText }
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
                    // check if any cards exist at all
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

            /* ══ PHASE 2: GENERATE QUESTIONS ══ */
            async function generateQuestions() {
                showPhase('Generating');
                const total = dueCards.length;
                container.querySelector('#fsrGeneratingMsg').textContent = `Generating ${total} question${total > 1 ? 's' : ''} with AI…`;

                const chunks = dueCards.map((c, i) =>
                    `Card ${i + 1} [Source: ${c.sourceName}]:\n"""\n${c.text.slice(0, 600)}\n"""`
                ).join('\n\n---\n\n');

                const prompt = `You are an expert tutor creating exam questions from study material.

Generate exactly ${total} question(s), one per card. Return ONLY a valid JSON object.

Cards:
${chunks}

Question types:
- For factual content: ask a specific fact-recall question (NOT "What does this text say?" — ask about the actual concept or fact)
- For mathematical/scientific content: generate a NOVEL related problem that tests the same principle
- For code/technical content: ask "Write a function that..." or "What would be the output of..."
- NEVER ask "What is described in the passage?" — always ask about the specific content

Return ONLY this JSON (no markdown, no explanation):
{
  "questions": [
    { "idx": 0, "question": "...", "type": "factual|math|technical|applied" },
    ...
  ]
}`;

                try {
                    const raw  = await callAI(prompt);
                    const data = parseJSON(raw);
                    questions  = data.questions || [];

                    if (questions.length !== total) {
                        // fallback — generate generic questions
                        questions = dueCards.map((c, i) => ({
                            idx: i,
                            question: `Based on your knowledge of the following content, explain the key concept or solve the related problem: ${c.text.slice(0, 100)}…`,
                            type: 'factual'
                        }));
                    }
                } catch (err) {
                    console.warn('[FSRS] Question generation failed:', err);
                    questions = dueCards.map((c, i) => ({
                        idx: i,
                        question: `Explain or demonstrate understanding of: "${c.text.slice(0, 120)}…"`,
                        type: 'factual'
                    }));
                }

                answers    = dueCards.map(() => ({ text: '', images: [], audioText: '' }));
                currentIdx = 0;
                startReview();
            }

            /* ══ PHASE 3: REVIEW ══ */
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
                const q    = questions[idx] || { question: 'Explain this concept.', type: 'factual' };
                const body = container.querySelector('#fsrReviewBody');

                const stateLabel = card.fsrs.state === 0 ? 'New'
                    : card.fsrs.state === 3 ? 'Relearn' : 'Review';
                const stateClass = card.fsrs.state === 0 ? 'fsr-badge-new'
                    : card.fsrs.state === 3 ? 'fsr-badge-relearn' : 'fsr-badge-review';

                const ans = answers[idx];

                body.innerHTML = `
                <span class="fsr-card-counter">Card ${idx + 1} of ${dueCards.length}</span>
                <div class="fsr-card">
                    <div class="fsr-card-meta">
                        <span class="fsr-card-src">📄 ${card.sourceName}</span>
                        <div class="fsr-card-badge">
                            <span class="fsr-badge ${stateClass}">${stateLabel}</span>
                            <span style="font-size:.6875rem;margin-left:4px;">S:${card.fsrs.stability} D:${card.fsrs.difficulty}</span>
                        </div>
                    </div>
                    <div class="fsr-context">${escHTML(card.text.slice(0, 300))}${card.text.length > 300 ? '…' : ''}</div>
                    <div class="fsr-question">❓ ${escHTML(q.question)}</div>
                </div>

                <div class="fsr-answer-wrap">
                    <textarea class="fsr-answer" id="fsrAnswerText" placeholder="Type your answer…&#10;Ctrl+Enter → next card" spellcheck="true">${escHTML(ans.text)}</textarea>

                    <div class="fsr-media-row">
                        <label class="fsr-media-btn" for="fsrImgInput" title="Attach an image (formula, diagram, work)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> Image
                        </label>
                        <input type="file" id="fsrImgInput" accept="image/*" multiple style="display:none;">
                        <button class="fsr-media-btn" id="fsrAudioBtn" title="Record spoken answer">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                            <span id="fsrAudioLabel">Record</span>
                        </button>
                        <div class="fsr-media-preview" id="fsrMediaPreview"></div>
                    </div>

                    <button class="fsr-next-btn" id="fsrNextBtn">
                        ${idx < dueCards.length - 1 ? 'Next Card →' : '✅ Finish & Grade'}
                    </button>
                </div>`;

                /* restore existing media */
                renderMediaPreview(idx);

                /* answer textarea */
                const textarea = body.querySelector('#fsrAnswerText');
                textarea.addEventListener('input', () => { answers[idx].text = textarea.value; });
                textarea.addEventListener('keydown', e => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); advanceCard(); }
                });
                textarea.focus();

                /* image input */
                const imgInput = body.querySelector('#fsrImgInput');
                imgInput.addEventListener('change', async () => {
                    const files = [...imgInput.files];
                    for (const f of files) {
                        const b64 = await fileToBase64(f);
                        answers[idx].images.push(b64);
                    }
                    renderMediaPreview(idx);
                });

                /* audio record */
                const audioBtn = body.querySelector('#fsrAudioBtn');
                audioBtn.addEventListener('click', () => toggleRecord(idx, audioBtn));

                /* next */
                body.querySelector('#fsrNextBtn').addEventListener('click', advanceCard);
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
                    chip.innerHTML = `🎙️ <span style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHTML(ans.audioText.slice(0, 60))}</span><button class="fsr-remove-btn" title="Remove">✕</button>`;
                    chip.querySelector('button').addEventListener('click', () => { ans.audioText = ''; renderMediaPreview(idx); });
                    prev.appendChild(chip);
                }
            }

            /* ── audio recording via SpeechRecognition (transcription) ── */
            function toggleRecord(idx, btn) {
                const label = btn.querySelector('#fsrAudioLabel');
                const chip  = container.querySelector('.fsr-audio-chip');

                if (mediaRecorder && mediaRecorder.state === 'recording') {
                    mediaRecorder.stop();
                    return;
                }

                // Try SpeechRecognition first (Chrome/Edge)
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
                        // Also append to textarea
                        const ta = container.querySelector('#fsrAnswerText');
                        if (ta && !ta.value.includes(transcript)) {
                            ta.value = (ta.value + '\n[Voice]: ' + transcript).trim();
                            answers[idx].text = ta.value;
                        }
                        renderMediaPreview(idx);
                    };
                    rec.onerror = () => { label.textContent = 'Record'; btn.classList.remove('recording'); };
                    rec.onend   = () => { label.textContent = 'Record'; btn.classList.remove('recording'); };
                    mediaRecorder = { state: 'recording', stop: () => rec.stop() };
                    return;
                }

                // Fallback: MediaRecorder (no transcription, just note)
                navigator.mediaDevices.getUserMedia({ audio: true })
                    .then(stream => {
                        audioChunks = [];
                        const mr = new MediaRecorder(stream);
                        mr.ondataavailable = e => audioChunks.push(e.data);
                        mr.onstop = () => {
                            stream.getTracks().forEach(t => t.stop());
                            answers[idx].audioText = answers[idx].audioText
                                ? answers[idx].audioText : '[Audio recorded — transcription not supported in this browser]';
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

            /* ── advance to next card or finish ── */
            function advanceCard() {
                const ta = container.querySelector('#fsrAnswerText');
                if (ta) answers[currentIdx].text = ta.value;

                currentIdx++;
                if (currentIdx >= dueCards.length) {
                    startGrading();
                } else {
                    renderCard(currentIdx);
                }
            }

            /* ══ PHASE 4: GRADE ══ */
            async function startGrading() {
                setProgress(dueCards.length, dueCards.length);
                showPhase('Grading');

                // Collect all images for multimodal grading
                const allImages = [];
                answers.forEach(a => { if (a.images.length) allImages.push(...a.images); });
                const gradingImages = allImages.slice(0, 4); // max 4 images to avoid token overflow

                const pairs = dueCards.map((card, i) => {
                    const q = questions[i] || { question: 'General understanding', type: 'factual' };
                    const a = answers[i];
                    const hasAudio = a.audioText ? `\n[Voice answer]: ${a.audioText}` : '';
                    const hasImg   = a.images.length ? `\n[${a.images.length} image(s) attached]` : '';
                    return `Card ${i + 1} [${card.sourceName}]:
Source excerpt: "${card.text.slice(0, 300)}"
Question (${q.type}): ${q.question}
Student answer: "${a.text || '(blank)'}${hasAudio}${hasImg}"`;
                }).join('\n\n---\n\n');

                const prompt = `You are an expert AI tutor grading a student's spaced-repetition review session.

Grade each card answer on FSRS scale:
1 = Again (wrong, blank, or fundamentally misunderstood)
2 = Hard (partially correct, major gaps)
3 = Good (mostly correct, minor errors)
4 = Easy (perfect or shows deep understanding)

${pairs}

Rules:
- Be strict but fair
- Consider partial credit
- If student left it blank: rating 1
- Consider any attached images as part of the answer (they may show worked solutions)
- Identify recurring weakness patterns across cards
- Give actionable improvement advice

Return ONLY this JSON (no markdown):
{
  "grades": [
    { "idx": 0, "rating": 3, "comment": "Correct but missed X detail." },
    ...
  ],
  "score": 75,
  "weaknesses": ["Topic A needs more review", "Confused about concept B"],
  "feedback": "Overall narrative feedback in 2-3 sentences.",
  "strengths": ["Strong understanding of X", "Good recall of Y"]
}`;

                try {
                    const raw    = await callAI(prompt, gradingImages);
                    const result = parseJSON(raw);
                    await applyResults(result);
                } catch (err) {
                    console.error('[FSRS] Grading failed:', err);
                    showPhase('Results');
                    container.querySelector('#fsrResultsBody').innerHTML =
                        `<div class="fsr-error">⚠️ Grading failed: ${err.message}<br><br>Your answers were recorded but FSRS was not updated.</div>`;
                }
            }

            /* ══ PHASE 5: APPLY + SAVE + SHOW RESULTS ══ */
            async function applyResults(result) {
                const grades    = result.grades || [];
                const ratingMap = {};
                grades.forEach(g => { ratingMap[g.idx] = g.rating; });

                // Update FSRS in the deck object
                dueCards.forEach((card, i) => {
                    const rating = Math.min(4, Math.max(1, ratingMap[i] || 2));
                    const newFSRS = fsrsSchedule(deck.sources[card.srcIdx].chunks[card.chunkIdx].fsrs || fsrsInit(), rating);
                    deck.sources[card.srcIdx].chunks[card.chunkIdx].fsrs = newFSRS;
                });

                // Persist to IndexedDB
                try {
                    if (typeof window.saveDecks === 'function') {
                        // Sync window.decks reference
                        if (window.decks) {
                            const di = window.decks.findIndex(d => d.id === deck.id);
                            if (di !== -1) window.decks[di] = deck;
                        }
                        await window.saveDecks();
                    } else {
                        // Fallback: direct dbStore write
                        const allDecks = await window.dbStore.get('decks') || [];
                        const di = allDecks.findIndex(d => d.id === deck.id);
                        if (di !== -1) allDecks[di] = deck;
                        await window.dbStore.set('decks', allDecks);
                    }
                } catch (e) {
                    console.error('[FSRS] Save failed:', e);
                }

                showResults(result);
            }

            function showResults(result) {
                showPhase('Results');
                const score     = Math.min(100, Math.max(0, result.score || 0));
                const scoreColor = score >= 80 ? '#34d399' : score >= 55 ? '#fb923c' : '#f87171';
                const body      = container.querySelector('#fsrResultsBody');

                const gradeLabels = ['', 'Again','Hard','Good','Easy'];
                const gradeClasses = ['','fsr-r1','fsr-r2','fsr-r3','fsr-r4'];

                const weakList = (result.weaknesses || []).map(w =>
                    `<div class="fsr-weakness-item">${escHTML(w)}</div>`).join('');

                const strengthList = (result.strengths || []).map(s =>
                    `<div style="display:flex;align-items:flex-start;gap:8px;font-size:.8125rem;color:var(--text-label);line-height:1.4;"><span style="flex-shrink:0;">✅</span><span>${escHTML(s)}</span></div>`).join('');

                const cardResults = (result.grades || []).map((g, i) => {
                    const card = dueCards[i];
                    const q    = questions[i];
                    const r    = Math.min(4, Math.max(1, g.rating));
                    const newFSRS = card ? deck.sources[card.srcIdx].chunks[card.chunkIdx].fsrs : null;
                    return `
                    <div class="fsr-card-result">
                        <div class="fsr-result-header">
                            <span style="font-weight:600;color:var(--text-label);">${card ? escHTML(card.sourceName) : '?'}</span>
                            <div style="display:flex;align-items:center;gap:6px;">
                                <span class="fsr-result-rating ${gradeClasses[r]}">${gradeLabels[r]}</span>
                                ${newFSRS ? `<span class="fsr-next-due">📅 ${dueLabel(newFSRS.due)}</span>` : ''}
                            </div>
                        </div>
                        ${q ? `<div class="fsr-result-q">Q: ${escHTML(q.question)}</div>` : ''}
                        ${g.comment ? `<div class="fsr-result-comment">${escHTML(g.comment)}</div>` : ''}
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
                        <text x="36" y="41" text-anchor="middle" font-size="14" font-weight="800" fill="${scoreColor}">${score}%</text>
                    </svg>
                    <div class="fsr-score-info">
                        <div class="fsr-score-pct">${score >= 80 ? '🎉 Great job!' : score >= 55 ? '📈 Keep going!' : '💪 Keep practicing!'}</div>
                        <div class="fsr-score-sub">${dueCards.length} card${dueCards.length > 1 ? 's' : ''} reviewed · FSRS updated</div>
                    </div>
                </div>

                ${result.feedback ? `<div class="fsr-feedback-box">💬 ${escHTML(result.feedback)}</div>` : ''}

                ${strengthList ? `<div class="fsr-section-title">Strengths</div><div class="fsr-weakness-list">${strengthList}</div>` : ''}
                ${weakList ? `<div class="fsr-section-title">Areas to Improve</div><div class="fsr-weakness-list">${weakList}</div>` : ''}

                <div class="fsr-section-title">Card-by-Card Results</div>
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
