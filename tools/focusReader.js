/**
 * NeuroSpark Tool: Focus Reader
 * Neurodivergent-friendly document reader.
 *
 * Features:
 *  • Bionic Reading — bold first 45% of each word (reduces tracking effort)
 *  • Focus Mode — one paragraph at a time, rest dimmed (ADHD attention aid)
 *  • Text-to-Speech — native Web Speech API, highlights active paragraph
 *  • AI "Explain Simply" — plain-language summary of any paragraph
 *  • Color overlays — tinted background for Irlen/scotopic sensitivity
 *  • Font size + line-height controls
 *  • Auto-chunks dense text into digestible paragraphs
 *  • Reading progress bar
 *
 * Isolated IIFE — zero external dependencies.
 * Evidence base: Bionic Reading (Renner 2022), TTS multi-modal learning,
 * color overlays for scotopic sensitivity (Wilkins 2003), chunking for
 * working memory (Miller 1956).
 */
(function () {
    if (!window.NeuroSparkTools) window.NeuroSparkTools = [];

    /* ══════════════════════════════════════════
       CONSTANTS
    ══════════════════════════════════════════ */
    const TOOL_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`;

    const OVERLAYS = [
        { label: 'None',   bg: 'transparent'           },
        { label: 'Yellow', bg: 'rgba(255,246,130,0.14)' },
        { label: 'Blue',   bg: 'rgba(130,195,255,0.14)' },
        { label: 'Rose',   bg: 'rgba(255,130,160,0.13)' },
        { label: 'Mint',   bg: 'rgba(130,255,195,0.12)' },
        { label: 'Peach',  bg: 'rgba(255,195,130,0.14)' },
    ];

    /* ══════════════════════════════════════════
       TEXT PROCESSING
    ══════════════════════════════════════════ */
    function chunkText(text) {
        // Try double-newline split first
        let paras = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 15);
        if (paras.length > 1) return paras;

        // Fall back: split by sentence groups (~3 sentences each)
        const sentences = text.match(/[^.!?…]+[.!?…]+(?:\s|$)/g) || [text];
        const chunks = [];
        let buf = '';
        sentences.forEach(s => {
            buf += s;
            if (buf.length >= 280) { chunks.push(buf.trim()); buf = ''; }
        });
        if (buf.trim()) chunks.push(buf.trim());
        return chunks.length ? chunks : [text];
    }

    /* Bionic reading: bold first ~45% of each alphabetic word */
    function bionic(text) {
        return text.replace(/\b([A-Za-zÀ-ÖØ-öø-ÿ]+)\b/g, (w) => {
            const n = Math.max(1, Math.ceil(w.length * 0.45));
            return `<b>${w.slice(0, n)}</b>${w.slice(n)}`;
        });
    }

    function esc(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    /* ══════════════════════════════════════════
       AI HELPER
    ══════════════════════════════════════════ */
    async function callAI(prompt) {
        const apiConfig = await (window.dbStore ? window.dbStore.get('apiConfig') : null);
        const mode      = await (window.dbStore ? window.dbStore.get('executionMode') : 'cloud');
        if (mode === 'cloud' && apiConfig && apiConfig.key) {
            const provider = apiConfig.provider || 'gemini';
            const key      = apiConfig.key;
            const model    = apiConfig.model || (provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash');
            if (provider === 'gemini') {
                const fm = model.includes('/') ? model : `models/${model}`;
                const r  = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/${fm}:generateContent?key=${key}`,
                    { method:'POST', headers:{'Content-Type':'application/json'},
                      body: JSON.stringify({ contents:[{parts:[{text:prompt}]}],
                        generationConfig:{temperature:0.3,maxOutputTokens:512} }) });
                if (!r.ok) throw new Error(`Gemini ${r.status}`);
                return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
            }
            if (provider === 'openai') {
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method:'POST',
                    headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},
                    body: JSON.stringify({model, messages:[{role:'user',content:prompt}],
                        max_tokens:512, temperature:0.3}) });
                if (!r.ok) throw new Error(`OpenAI ${r.status}`);
                return (await r.json()).choices?.[0]?.message?.content || '';
            }
            if (provider === 'anthropic') {
                const r = await fetch('https://api.anthropic.com/v1/messages', {
                    method:'POST',
                    headers:{'x-api-key':key,'anthropic-version':'2023-06-01',
                             'anthropic-dangerous-direct-browser-access':'true',
                             'Content-Type':'application/json'},
                    body: JSON.stringify({model, max_tokens:512,
                        messages:[{role:'user',content:prompt}]}) });
                if (!r.ok) throw new Error(`Anthropic ${r.status}`);
                return (await r.json()).content?.[0]?.text || '';
            }
        }
        throw new Error('No AI provider configured. Set up an API key in Settings → Cloud API.');
    }

    /* ══════════════════════════════════════════
       STYLES
    ══════════════════════════════════════════ */
    const STYLES = `<style>
.fr-wrap{display:flex;flex-direction:column;gap:10px;height:100%;width:100%;}
.fr-hdr{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border-color);padding-bottom:10px;flex-shrink:0;}
.fr-title{display:flex;align-items:center;gap:8px;}
.fr-title h4{font-size:.875rem;font-weight:600;color:var(--text-color);margin:0;}
.fr-back{background:none;border:1px solid var(--border-color);border-radius:4px;padding:4px 10px;font-size:.75rem;color:var(--text-muted);cursor:pointer;}
/* source list */
.fr-src-list{display:flex;flex-direction:column;gap:8px;overflow-y:auto;flex:1;}
.fr-src-label{font-size:.75rem;color:var(--text-muted);flex-shrink:0;}
.fr-src-card{background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;padding:12px 14px;cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:12px;}
.fr-src-card:hover{border-color:var(--primary-color);}
.fr-src-icon{color:var(--primary-color);flex-shrink:0;}
.fr-src-info{display:flex;flex-direction:column;gap:3px;}
.fr-src-name{font-size:.8125rem;font-weight:600;color:var(--text-color);}
.fr-src-meta{font-size:.6875rem;color:var(--text-muted);}
.fr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:10px;color:var(--text-muted);text-align:center;font-size:.75rem;}
/* toolbar */
.fr-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;flex-shrink:0;background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;padding:8px 10px;}
.fr-tool-btn{display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;border:1px solid var(--border-color);background:none;color:var(--text-muted);font-size:.75rem;cursor:pointer;transition:all .15s;white-space:nowrap;}
.fr-tool-btn:hover{color:var(--primary-color);border-color:var(--primary-color);}
.fr-tool-btn.active{background:var(--primary-color);border-color:var(--primary-color);color:#fff;}
.fr-divider{width:1px;height:20px;background:var(--border-color);flex-shrink:0;}
.fr-size-btn{width:26px;height:26px;border-radius:4px;border:1px solid var(--border-color);background:none;color:var(--text-muted);font-size:.8rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;}
.fr-size-btn:hover{color:var(--primary-color);border-color:var(--primary-color);}
.fr-overlay-btn{width:18px;height:18px;border-radius:50%;cursor:pointer;border:2px solid var(--border-color);flex-shrink:0;transition:transform .15s;}
.fr-overlay-btn:hover,.fr-overlay-btn.active{transform:scale(1.3);border-color:var(--primary-color);}
.fr-speed-select{padding:3px 6px;border-radius:4px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-muted);font-size:.75rem;cursor:pointer;}
/* progress */
.fr-progress-wrap{height:4px;background:var(--bg-input);border-radius:99px;overflow:hidden;flex-shrink:0;}
.fr-progress{height:100%;background:var(--primary-color);border-radius:99px;transition:width .3s;}
/* reader */
.fr-reader{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:2px;min-height:0;border-radius:8px;transition:background .2s;}
/* paragraphs */
.fr-para{border-radius:8px;padding:12px 14px;border:1px solid transparent;transition:all .2s;cursor:pointer;position:relative;}
.fr-para:hover{border-color:var(--border-color);}
.fr-para.active-para{background:var(--bg-input);border-color:var(--primary-color);box-shadow:0 0 0 2px rgba(99,102,241,0.12);}
.fr-para.dimmed-para{opacity:0.22;filter:blur(0.5px);pointer-events:none;}
.fr-para.speaking-para{background:var(--bg-input);border-color:#34d399;box-shadow:0 0 0 2px rgba(52,211,153,0.15);}
.fr-para-text{font-size:1rem;line-height:1.8;color:var(--text-color);word-spacing:0.06em;}
.fr-para-text b{color:var(--text-color);font-weight:800;}
.fr-para-actions{display:flex;gap:6px;margin-top:8px;align-items:center;}
.fr-simplify-btn{padding:3px 10px;border-radius:20px;border:1px solid var(--border-color);background:none;color:var(--text-muted);font-size:.6875rem;cursor:pointer;transition:all .15s;}
.fr-simplify-btn:hover{color:var(--primary-color);border-color:var(--primary-color);}
.fr-simplify-btn:disabled{opacity:.5;cursor:wait;}
.fr-para-num{font-size:.625rem;color:var(--text-muted);margin-left:auto;}
.fr-simple-box{margin-top:8px;padding:10px 12px;border-radius:6px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);font-size:.8125rem;color:var(--text-label);line-height:1.6;}
.fr-simple-label{font-size:.625rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--primary-color);margin-bottom:4px;}
/* back to sources */
.fr-src-back{background:none;border:1px solid var(--border-color);border-radius:4px;padding:3px 8px;font-size:.6875rem;color:var(--text-muted);cursor:pointer;flex-shrink:0;}
.fr-src-back:hover{color:var(--primary-color);}
/* tts status */
.fr-tts-pill{padding:2px 8px;border-radius:20px;font-size:.625rem;font-weight:600;background:rgba(52,211,153,0.15);border:1px solid #34d399;color:#34d399;display:flex;align-items:center;gap:4px;}
.fr-tts-dot{width:6px;height:6px;border-radius:50%;background:#34d399;animation:badge-pulse 1s infinite;}
</style>`;

    /* ══════════════════════════════════════════
       TOOL DEFINITION
    ══════════════════════════════════════════ */
    const toolDefinition = {
        id: 'focus-reader',
        name: 'Focus Reader',
        description: 'Neurodivergent-friendly reader with bionic text, TTS, focus mode, and AI explanations.',
        icon: TOOL_ICON,

        render(container, deck, onBack) {
            /* ── state ── */
            let bionicOn  = false;
            let focusMode = false;
            let fontSize  = 16;   // px
            let lineH     = 1.8;
            let overlayBg = 'transparent';
            let ttsRate   = 1.0;
            let ttsSynth  = window.speechSynthesis;
            let ttsUtter  = null;
            let activeIdx = 0;
            let paragraphs = [];
            let currentSource = null;

            container.innerHTML = STYLES + `
<div class="fr-wrap">
  <div class="fr-hdr">
    <div class="fr-title">
      <span style="color:var(--primary-color);display:flex;">${TOOL_ICON}</span>
      <h4>Focus Reader</h4>
    </div>
    <button class="fr-back" id="frBack">← Back</button>
  </div>

  <!-- Source list phase -->
  <div id="frPhaseSource" style="display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;">
    <span class="fr-src-label">Choose a source document to read:</span>
    <div class="fr-src-list" id="frSrcList"></div>
  </div>

  <!-- Reader phase -->
  <div id="frPhaseReader" style="display:none;flex-direction:column;gap:10px;flex:1;min-height:0;">
    <!-- Toolbar -->
    <div class="fr-toolbar" id="frToolbar">
      <button class="fr-src-back" id="frSrcBack" title="Choose another source">← Sources</button>
      <div class="fr-divider"></div>
      <button class="fr-tool-btn" id="frBionicBtn" title="Bionic Reading — bold first half of each word">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>
        Bionic
      </button>
      <button class="fr-tool-btn" id="frFocusBtn" title="Focus Mode — dim other paragraphs">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
        Focus
      </button>
      <button class="fr-tool-btn" id="frTtsBtn" title="Text-to-Speech — read aloud">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
        <span id="frTtsLabel">Read</span>
      </button>
      <select class="fr-speed-select" id="frSpeedSel" title="Reading speed">
        <option value="0.7">0.7×</option>
        <option value="0.85">0.85×</option>
        <option value="1" selected>1×</option>
        <option value="1.2">1.2×</option>
        <option value="1.5">1.5×</option>
      </select>
      <div class="fr-divider"></div>
      <button class="fr-size-btn" id="frSizeDn" title="Smaller text">A−</button>
      <button class="fr-size-btn" id="frSizeUp" title="Larger text">A+</button>
      <div class="fr-divider"></div>
      <span style="font-size:.6875rem;color:var(--text-muted);white-space:nowrap;">Overlay:</span>
      ${OVERLAYS.map((o,i)=>`<div class="fr-overlay-btn${i===0?' active':''}" data-oi="${i}" title="${o.label}" style="background:${i===0?'var(--bg-input)':o.bg};border-color:${i===0?'var(--primary-color)':'var(--border-color)'};"></div>`).join('')}
      <div id="frTtsPill" style="display:none;" class="fr-tts-pill"><div class="fr-tts-dot"></div>Reading…</div>
    </div>

    <!-- Progress -->
    <div class="fr-progress-wrap"><div class="fr-progress" id="frProgress" style="width:0%"></div></div>

    <!-- Reader -->
    <div class="fr-reader" id="frReader"></div>
  </div>
</div>`;

            /* ── back ── */
            container.querySelector('#frBack').addEventListener('click', () => {
                ttsSynth && ttsSynth.cancel();
                onBack();
            });

            /* ── populate source list ── */
            const srcList = container.querySelector('#frSrcList');
            const sources = (deck.sources || []).filter(s => s.chunks && s.chunks.length);
            if (!sources.length) {
                srcList.innerHTML = `<div class="fr-empty"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg><span>No embedded source documents found.<br>Upload and vectorize files first.</span></div>`;
            } else {
                sources.forEach(src => {
                    const wordCount = src.chunks.reduce((a,c)=>a+(c.text||'').split(/\s+/).length,0);
                    const minsRead  = Math.max(1, Math.round(wordCount / 200));
                    const card = document.createElement('div');
                    card.className = 'fr-src-card';
                    card.innerHTML = `
                        <svg class="fr-src-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                        <div class="fr-src-info">
                            <div class="fr-src-name">${esc(src.name)}</div>
                            <div class="fr-src-meta">~${wordCount.toLocaleString()} words · ${minsRead} min read · ${src.chunks.length} chunks</div>
                        </div>`;
                    card.addEventListener('click', () => openSource(src));
                    srcList.appendChild(card);
                });
            }

            /* ── switch to source list ── */
            container.querySelector('#frSrcBack').addEventListener('click', () => {
                ttsSynth && ttsSynth.cancel();
                container.querySelector('#frPhaseSource').style.display = 'flex';
                container.querySelector('#frPhaseReader').style.display = 'none';
            });

            /* ── open a source in reader ── */
            function openSource(src) {
                currentSource = src;
                const fullText = src.chunks.map(c => c.text || '').join('\n\n');
                paragraphs     = chunkText(fullText);
                activeIdx      = 0;
                container.querySelector('#frPhaseSource').style.display = 'none';
                container.querySelector('#frPhaseReader').style.display = 'flex';
                renderReader();
            }

            /* ── render all paragraphs ── */
            function renderReader() {
                const reader = container.querySelector('#frReader');
                reader.style.background = overlayBg;
                reader.innerHTML = '';

                paragraphs.forEach((para, i) => {
                    const div = document.createElement('div');
                    div.className = 'fr-para' + (focusMode && i !== activeIdx ? ' dimmed-para' : '') + (focusMode && i === activeIdx ? ' active-para' : '');
                    div.dataset.idx = i;

                    const displayText = bionicOn ? bionic(esc(para)) : esc(para);
                    div.innerHTML = `
                        <div class="fr-para-text" style="font-size:${fontSize}px;line-height:${lineH};">${displayText}</div>
                        <div class="fr-para-actions">
                            <button class="fr-simplify-btn" data-pidx="${i}">✨ Explain simply</button>
                            <span class="fr-para-num">${i+1} / ${paragraphs.length}</span>
                        </div>`;

                    // Click to focus
                    div.addEventListener('click', (e) => {
                        if (e.target.classList.contains('fr-simplify-btn')) return;
                        if (focusMode) {
                            activeIdx = i;
                            updateFocusClasses();
                            updateProgress();
                        }
                    });

                    // Simplify button
                    div.querySelector('.fr-simplify-btn').addEventListener('click', async (e) => {
                        const btn = e.target;
                        btn.disabled = true; btn.textContent = '⏳ Thinking…';
                        const existing = div.querySelector('.fr-simple-box');
                        if (existing) { existing.remove(); btn.disabled=false; btn.textContent='✨ Explain simply'; return; }
                        try {
                            const prompt = `You are a patient tutor helping a neurodivergent student understand dense academic text.

Rewrite the following passage in plain English that a 13-year-old could understand. Use:
- Short sentences (max 15 words each)
- Simple vocabulary — no jargon
- Bullet points if there are multiple ideas
- An analogy or real-world example if helpful
- Encouraging, friendly tone

Passage:
"""
${para.slice(0, 800)}
"""

Plain English version (no preamble):`;
                            const reply = await callAI(prompt);
                            const box = document.createElement('div');
                            box.className = 'fr-simple-box';
                            box.innerHTML = `<div class="fr-simple-label">🧠 Plain English</div>${esc(reply.trim()).replace(/\n/g,'<br>')}`;
                            div.appendChild(box);
                            btn.textContent = '✕ Hide explanation';
                        } catch (err) {
                            btn.textContent = '⚠️ ' + err.message.slice(0,40);
                        } finally { btn.disabled = false; }
                    });

                    reader.appendChild(div);
                });

                updateProgress();
            }

            /* ── focus mode helpers ── */
            function updateFocusClasses() {
                container.querySelectorAll('.fr-para').forEach((el, i) => {
                    el.classList.remove('active-para','dimmed-para','speaking-para');
                    if (!focusMode) return;
                    el.classList.toggle('active-para', i === activeIdx);
                    el.classList.toggle('dimmed-para', i !== activeIdx);
                });
            }

            function updateProgress() {
                const pct = paragraphs.length > 1
                    ? Math.round((activeIdx / (paragraphs.length - 1)) * 100) : 100;
                container.querySelector('#frProgress').style.width = pct + '%';
            }

            /* ── toolbar controls ── */
            /* bionic */
            container.querySelector('#frBionicBtn').addEventListener('click', () => {
                bionicOn = !bionicOn;
                container.querySelector('#frBionicBtn').classList.toggle('active', bionicOn);
                renderReader();
            });

            /* focus mode */
            container.querySelector('#frFocusBtn').addEventListener('click', () => {
                focusMode = !focusMode;
                container.querySelector('#frFocusBtn').classList.toggle('active', focusMode);
                updateFocusClasses();
                if (focusMode) {
                    const el = container.querySelector(`.fr-para[data-idx="${activeIdx}"]`);
                    el && el.scrollIntoView({ behavior:'smooth', block:'center' });
                }
            });

            /* TTS */
            container.querySelector('#frTtsBtn').addEventListener('click', () => {
                if (!ttsSynth) { alert('Text-to-speech is not supported in this browser.'); return; }
                if (ttsSynth.speaking) {
                    ttsSynth.cancel();
                    stopTTS();
                    return;
                }
                startTTS();
            });

            container.querySelector('#frSpeedSel').addEventListener('change', (e) => {
                ttsRate = parseFloat(e.target.value);
                if (ttsSynth && ttsSynth.speaking) { ttsSynth.cancel(); stopTTS(); startTTS(); }
            });

            function startTTS() {
                const fullText = paragraphs.join(' ');
                ttsUtter = new SpeechSynthesisUtterance(fullText);
                ttsUtter.rate  = ttsRate;
                ttsUtter.pitch = 1;
                ttsUtter.lang  = 'en-US';

                let charCount = 0;
                const lengths = paragraphs.map(p => p.length + 1);

                ttsUtter.onboundary = (e) => {
                    if (e.name !== 'word') return;
                    let cumul = 0, pi = 0;
                    for (; pi < lengths.length; pi++) {
                        if (e.charIndex < cumul + lengths[pi]) break;
                        cumul += lengths[pi];
                    }
                    if (pi !== activeIdx) {
                        activeIdx = pi;
                        updateProgress();
                        // highlight speaking paragraph
                        container.querySelectorAll('.fr-para').forEach((el, i) => {
                            el.classList.remove('speaking-para','active-para','dimmed-para');
                            if (focusMode) {
                                el.classList.toggle('active-para', i === activeIdx);
                                el.classList.toggle('dimmed-para', i !== activeIdx);
                            } else {
                                el.classList.toggle('speaking-para', i === activeIdx);
                            }
                        });
                        const el = container.querySelector(`.fr-para[data-idx="${activeIdx}"]`);
                        el && el.scrollIntoView({ behavior:'smooth', block:'center' });
                    }
                };

                ttsUtter.onend = ttsUtter.onerror = () => stopTTS();

                ttsSynth.speak(ttsUtter);
                container.querySelector('#frTtsLabel').textContent = '⏹ Stop';
                container.querySelector('#frTtsBtn').classList.add('active');
                container.querySelector('#frTtsPill').style.display = 'flex';
            }

            function stopTTS() {
                container.querySelector('#frTtsLabel').textContent = 'Read';
                container.querySelector('#frTtsBtn').classList.remove('active');
                container.querySelector('#frTtsPill').style.display = 'none';
                container.querySelectorAll('.fr-para').forEach(el => el.classList.remove('speaking-para'));
            }

            /* font size */
            container.querySelector('#frSizeDn').addEventListener('click', () => {
                fontSize = Math.max(12, fontSize - 2);
                container.querySelectorAll('.fr-para-text').forEach(el => el.style.fontSize = fontSize + 'px');
            });
            container.querySelector('#frSizeUp').addEventListener('click', () => {
                fontSize = Math.min(26, fontSize + 2);
                container.querySelectorAll('.fr-para-text').forEach(el => el.style.fontSize = fontSize + 'px');
            });

            /* color overlays */
            container.querySelectorAll('.fr-overlay-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const oi = parseInt(btn.dataset.oi);
                    overlayBg = OVERLAYS[oi].bg;
                    const reader = container.querySelector('#frReader');
                    if (reader) reader.style.background = overlayBg;
                    container.querySelectorAll('.fr-overlay-btn').forEach((b,i) => {
                        b.classList.toggle('active', i === oi);
                        b.style.borderColor = i === oi ? 'var(--primary-color)' : 'var(--border-color)';
                    });
                });
            });

            /* keyboard nav in focus mode */
            container.addEventListener('keydown', (e) => {
                if (!focusMode || !paragraphs.length) return;
                if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    activeIdx = Math.min(paragraphs.length - 1, activeIdx + 1);
                    updateFocusClasses(); updateProgress();
                    const el = container.querySelector(`.fr-para[data-idx="${activeIdx}"]`);
                    el && el.scrollIntoView({ behavior:'smooth', block:'center' });
                }
                if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    activeIdx = Math.max(0, activeIdx - 1);
                    updateFocusClasses(); updateProgress();
                    const el = container.querySelector(`.fr-para[data-idx="${activeIdx}"]`);
                    el && el.scrollIntoView({ behavior:'smooth', block:'center' });
                }
            });
        }
    };

    window.NeuroSparkTools.push(toolDefinition);
    console.log('[Tools] Loaded tool: ' + toolDefinition.name);
})();
