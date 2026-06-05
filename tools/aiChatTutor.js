/**
 * NeuroSpark Tool: AI Chat Tutor
 * RAG-powered conversational tutor — chat with your deck documents.
 *
 * Architecture:
 *  1. Embed user question via window.computeEmbedding
 *  2. Cosine-similarity retrieval of top-K relevant chunks (RAG)
 *  3. Inject context + conversation history into LLM
 *  4. Stream-render response with lightweight Markdown
 *  5. Show source citations inline
 *
 * Isolated IIFE — zero external dependencies.
 */
(function () {
    if (!window.NeuroSparkTools) window.NeuroSparkTools = [];

    /* ══════════════════════════════════════════
       CONSTANTS
    ══════════════════════════════════════════ */
    const TOOL_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    const TOP_K          = 4;    // RAG chunks to retrieve
    const MAX_HISTORY    = 8;    // messages kept in context window
    const MAX_CHUNK_CHARS= 500;  // chars per chunk sent to LLM

    /* ══════════════════════════════════════════
       VECTOR SIMILARITY
    ══════════════════════════════════════════ */
    function cosine(a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
        }
        return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
    }

    /* ══════════════════════════════════════════
       RAG RETRIEVAL
    ══════════════════════════════════════════ */
    async function retrieve(query, deck) {
        const all = [];
        (deck.sources || []).forEach(src => {
            (src.chunks || []).forEach(c => {
                all.push({ text: c.text || '', sourceName: src.name, embedding: c.embedding });
            });
        });
        if (!all.length) return [];

        /* try vector search first */
        try {
            if (typeof window.computeEmbedding === 'function') {
                const model = typeof window.getSelectedEmbeddingModel === 'function'
                    ? await window.getSelectedEmbeddingModel()
                    : 'Xenova/all-MiniLM-L6-v2';
                const qVec = await window.computeEmbedding(query, model);
                return all
                    .filter(c => c.embedding && c.embedding.length)
                    .map(c => ({ ...c, score: cosine(qVec, c.embedding) }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, TOP_K);
            }
        } catch (_) { /* fall through to keyword search */ }

        /* keyword fallback */
        const words = new Set(query.toLowerCase().split(/\W+/).filter(w => w.length > 3));
        return all
            .map(c => ({
                ...c,
                score: c.text.toLowerCase().split(/\W+/).filter(w => words.has(w)).length / (words.size || 1)
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, TOP_K);
    }

    /* ══════════════════════════════════════════
       LIGHTWEIGHT MARKDOWN RENDERER
    ══════════════════════════════════════════ */
    function md(text) {
        return text
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            /* code blocks */
            .replace(/```[\w]*\n?([\s\S]*?)```/g,
                '<pre style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:6px;padding:10px;overflow-x:auto;font-size:.78rem;margin:6px 0;"><code>$1</code></pre>')
            /* inline code */
            .replace(/`([^`]+)`/g,
                '<code style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:3px;padding:1px 5px;font-size:.82em;">$1</code>')
            /* bold */
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            /* italic */
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            /* headings */
            .replace(/^### (.+)$/gm, '<p style="font-weight:700;font-size:.875rem;margin:8px 0 2px;">$1</p>')
            .replace(/^## (.+)$/gm,  '<p style="font-weight:700;font-size:.9rem;margin:10px 0 2px;">$1</p>')
            /* unordered list */
            .replace(/^[-•] (.+)$/gm, '<li style="margin:2px 0;">$1</li>')
            /* ordered list */
            .replace(/^\d+\. (.+)$/gm, '<li style="margin:2px 0;">$1</li>')
            /* wrap consecutive <li> in <ul> */
            .replace(/((?:<li[^>]*>.*?<\/li>\n?)+)/gs,
                '<ul style="padding-left:18px;margin:6px 0;">$1</ul>')
            /* line breaks */
            .replace(/\n\n/g, '<br><br>')
            .replace(/\n/g, '<br>');
    }

    /* ══════════════════════════════════════════
       SYSTEM PROMPT
    ══════════════════════════════════════════ */
    function systemPrompt(socratic, hasContext) {
        return `You are a warm, patient AI tutor helping a neurodivergent student study their documents.

Style rules:
- Simple, clear language (smart student, new to topic)
- Short paragraphs — max 3 sentences each
- Use **bold** for key terms, bullet points for lists, \`code\` for technical terms
- Always be encouraging — never say "obviously" or "simply"
- If unsure, say so honestly
${socratic ? '- Socratic mode ON: after every answer, ask ONE open-ended follow-up question to check understanding\n' : ''}
${hasContext
    ? '- Answer primarily from the provided [Context] excerpts\n- Cite sources as [Source: filename] when using them\n- If context is insufficient, supplement with general knowledge and say so'
    : '- No document context available — answer from general knowledge and say so'}`;
    }

    /* ══════════════════════════════════════════
       LLM CALL  (Gemini / OpenAI / Anthropic)
    ══════════════════════════════════════════ */
    async function callLLM(sysPrompt, history, userMsg) {
        const apiConfig = await (window.dbStore ? window.dbStore.get('apiConfig') : null);
        const mode      = await (window.dbStore ? window.dbStore.get('executionMode') : 'cloud');

        if (mode === 'cloud' && apiConfig && apiConfig.key) {
            const provider = apiConfig.provider || 'gemini';
            const key      = apiConfig.key;
            const model    = apiConfig.model || (provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash');

            /* ── Gemini ── */
            if (provider === 'gemini') {
                const fm = model.includes('/') ? model : `models/${model}`;
                /* Gemini has no system role — prepend as first turn */
                const contents = [
                    { role: 'user',  parts: [{ text: sysPrompt }] },
                    { role: 'model', parts: [{ text: 'Understood. I am ready to help.' }] },
                    ...history.map(m => ({
                        role: m.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: m.content }]
                    })),
                    { role: 'user', parts: [{ text: userMsg }] }
                ];
                const r = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/${fm}:generateContent?key=${key}`,
                    { method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ contents, generationConfig: { temperature: 0.4, maxOutputTokens: 1500 } }) }
                );
                if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
                return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
            }

            /* ── OpenAI ── */
            if (provider === 'openai') {
                const messages = [
                    { role: 'system', content: sysPrompt },
                    ...history,
                    { role: 'user', content: userMsg }
                ];
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: 0.4 })
                });
                if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
                return (await r.json()).choices?.[0]?.message?.content || '';
            }

            /* ── Anthropic ── */
            if (provider === 'anthropic') {
                const messages = [
                    ...history,
                    { role: 'user', content: userMsg }
                ];
                const r = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'x-api-key': key, 'anthropic-version': '2023-06-01',
                        'anthropic-dangerous-direct-browser-access': 'true',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ model, max_tokens: 1500, system: sysPrompt, messages })
                });
                if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
                return (await r.json()).content?.[0]?.text || '';
            }
        }
        throw new Error('No AI provider configured. Go to Settings → Cloud API to add your key.');
    }

    /* ══════════════════════════════════════════
       STYLES
    ══════════════════════════════════════════ */
    const STYLES = `<style>
.ct-wrap{display:flex;flex-direction:column;height:100%;width:100%;gap:10px;}
.ct-hdr{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border-color);padding-bottom:10px;flex-shrink:0;}
.ct-title{display:flex;align-items:center;gap:8px;}
.ct-title h4{font-size:.875rem;font-weight:600;color:var(--text-color);margin:0;}
.ct-back{background:none;border:1px solid var(--border-color);border-radius:4px;padding:4px 10px;font-size:.75rem;color:var(--text-muted);cursor:pointer;}
/* toolbar */
.ct-toolbar{display:flex;align-items:center;gap:8px;flex-shrink:0;}
.ct-mode-btn{padding:5px 12px;border-radius:20px;border:1px solid var(--border-color);background:none;color:var(--text-muted);font-size:.75rem;cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:5px;}
.ct-mode-btn.active{border-color:var(--primary-color);color:var(--primary-color);background:rgba(99,102,241,.08);}
.ct-clear-btn{margin-left:auto;padding:5px 10px;border-radius:6px;border:1px solid var(--border-color);background:none;color:var(--text-muted);font-size:.75rem;cursor:pointer;transition:all .15s;}
.ct-clear-btn:hover{color:#ef4444;border-color:#ef4444;}
/* context pill */
.ct-ctx-bar{display:flex;align-items:center;gap:6px;font-size:.6875rem;color:var(--text-muted);flex-shrink:0;min-height:18px;}
.ct-ctx-pill{display:flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-muted);white-space:nowrap;overflow:hidden;max-width:200px;text-overflow:ellipsis;}
.ct-ctx-pill.has-ctx{border-color:rgba(99,102,241,.4);color:var(--primary-color);}
/* messages */
.ct-messages{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:2px;min-height:0;}
/* bubble base */
.ct-bubble{max-width:88%;display:flex;flex-direction:column;gap:4px;}
.ct-bubble.user{align-self:flex-end;align-items:flex-end;}
.ct-bubble.ai{align-self:flex-start;align-items:flex-start;}
.ct-bubble-body{padding:10px 14px;border-radius:12px;font-size:.8125rem;line-height:1.6;word-break:break-word;}
.ct-bubble.user .ct-bubble-body{background:var(--primary-color);color:#fff;border-bottom-right-radius:3px;}
.ct-bubble.ai  .ct-bubble-body{background:var(--bg-input);border:1px solid var(--border-color);color:var(--text-color);border-bottom-left-radius:3px;}
.ct-bubble-body strong{font-weight:700;}
.ct-bubble-body em{font-style:italic;}
/* citations */
.ct-citations{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;}
.ct-cite{padding:2px 8px;border-radius:20px;border:1px solid rgba(99,102,241,.3);background:rgba(99,102,241,.07);font-size:.625rem;color:var(--primary-color);white-space:nowrap;overflow:hidden;max-width:180px;text-overflow:ellipsis;}
/* timestamp */
.ct-ts{font-size:.5625rem;color:var(--text-muted);padding:0 4px;}
/* typing indicator */
.ct-typing{display:flex;gap:4px;padding:12px 14px;align-items:center;}
.ct-typing-dot{width:7px;height:7px;border-radius:50%;background:var(--text-muted);animation:ct-bounce .9s infinite ease-in-out;}
.ct-typing-dot:nth-child(2){animation-delay:.2s;}
.ct-typing-dot:nth-child(3){animation-delay:.4s;}
@keyframes ct-bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
/* suggested questions */
.ct-suggestions{display:flex;flex-direction:column;gap:6px;align-items:flex-start;width:100%;}
.ct-suggest-label{font-size:.6875rem;color:var(--text-muted);}
.ct-suggest-btn{padding:6px 12px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-label);font-size:.75rem;cursor:pointer;transition:all .15s;text-align:left;}
.ct-suggest-btn:hover{border-color:var(--primary-color);color:var(--primary-color);}
/* input row */
.ct-input-row{display:flex;gap:8px;align-items:flex-end;flex-shrink:0;}
.ct-input{flex:1;min-height:40px;max-height:110px;padding:10px 12px;border-radius:10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-color);font-size:.8125rem;font-family:var(--font-sans);resize:none;outline:none;line-height:1.5;transition:border-color .15s;overflow-y:auto;}
.ct-input:focus{border-color:var(--primary-color);}
.ct-send-btn{width:40px;height:40px;border-radius:10px;border:none;background:var(--primary-color);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:opacity .15s;flex-shrink:0;}
.ct-send-btn:disabled{opacity:.45;cursor:not-allowed;}
.ct-send-btn svg{width:18px;height:18px;}
/* error */
.ct-error-body{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;}
/* no-docs warning */
.ct-nodocs{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:10px;color:var(--text-muted);text-align:center;font-size:.8125rem;padding:24px;}
.ct-nodocs svg{opacity:.3;}
</style>`;

    /* ══════════════════════════════════════════
       TOOL DEFINITION
    ══════════════════════════════════════════ */
    const toolDefinition = {
        id: 'ai-chat-tutor',
        name: 'AI Chat Tutor',
        description: 'Chat with your documents — RAG-powered tutor that explains, clarifies, and tests you.',
        icon: TOOL_ICON,

        render(container, deck, onBack) {
            /* ── state ── */
            let history   = [];   // {role:'user'|'assistant', content:string}[]
            let busy      = false;
            let socratic  = false;
            let lastCtx   = [];   // last retrieved chunks

            const hasDocs = (deck.sources || []).some(s => s.chunks && s.chunks.length);

            /* ── render shell ── */
            container.innerHTML = STYLES + `
<div class="ct-wrap">
  <div class="ct-hdr">
    <div class="ct-title">
      <span style="color:var(--primary-color);display:flex;">${TOOL_ICON}</span>
      <h4>AI Chat Tutor</h4>
    </div>
    <button class="ct-back" id="ctBack">← Back</button>
  </div>

  <div class="ct-toolbar">
    <button class="ct-mode-btn" id="ctTutorBtn" title="Tutor mode — AI explains and answers">
      📚 Tutor
    </button>
    <button class="ct-mode-btn" id="ctSocraticBtn" title="Socratic mode — AI asks follow-up questions">
      🤔 Socratic
    </button>
    <button class="ct-clear-btn" id="ctClearBtn">🗑️ Clear</button>
  </div>

  <div class="ct-ctx-bar" id="ctCtxBar">
    <span>Context:</span>
    <span class="ct-ctx-pill" id="ctCtxPill">no retrieval yet</span>
  </div>

  <div class="ct-messages" id="ctMessages"></div>

  <div class="ct-input-row">
    <textarea class="ct-input" id="ctInput" rows="1"
      placeholder="Ask anything about your documents… (Enter = send, Shift+Enter = newline)"
      ${hasDocs ? '' : 'placeholder="No embedded documents found — upload files first"'}></textarea>
    <button class="ct-send-btn" id="ctSend" ${!hasDocs ? 'disabled' : ''} title="Send">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
    </button>
  </div>
</div>`;

            /* ── refs ── */
            const msgs    = container.querySelector('#ctMessages');
            const input   = container.querySelector('#ctInput');
            const sendBtn = container.querySelector('#ctSend');
            const ctxPill = container.querySelector('#ctCtxPill');

            /* ── back ── */
            container.querySelector('#ctBack').addEventListener('click', onBack);

            /* ── mode buttons ── */
            container.querySelector('#ctTutorBtn').classList.add('active');
            container.querySelector('#ctTutorBtn').addEventListener('click', () => {
                socratic = false;
                container.querySelector('#ctTutorBtn').classList.add('active');
                container.querySelector('#ctSocraticBtn').classList.remove('active');
            });
            container.querySelector('#ctSocraticBtn').addEventListener('click', () => {
                socratic = true;
                container.querySelector('#ctSocraticBtn').classList.add('active');
                container.querySelector('#ctTutorBtn').classList.remove('active');
            });

            /* ── clear ── */
            container.querySelector('#ctClearBtn').addEventListener('click', () => {
                history = []; lastCtx = [];
                msgs.innerHTML = '';
                ctxPill.textContent = 'no retrieval yet';
                ctxPill.classList.remove('has-ctx');
                showWelcome();
            });

            /* ── auto-resize textarea ── */
            input.addEventListener('input', () => {
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 110) + 'px';
            });

            /* ── send on Enter (Shift+Enter = newline) ── */
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            });
            sendBtn.addEventListener('click', send);

            /* ══════════ HELPERS ══════════ */

            function now() {
                return new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
            }

            function scrollBottom() {
                msgs.scrollTop = msgs.scrollHeight;
            }

            function addBubble(role, htmlContent, citations = []) {
                const wrap = document.createElement('div');
                wrap.className = `ct-bubble ${role}`;
                const citHtml = citations.length
                    ? `<div class="ct-citations">${citations.map(c =>
                        `<span class="ct-cite" title="${c}">📄 ${c}</span>`).join('')}</div>` : '';
                wrap.innerHTML = `
                    <div class="ct-bubble-body${role === 'error' ? ' ct-error-body' : ''}">${htmlContent}</div>
                    ${citHtml}
                    <span class="ct-ts">${now()}</span>`;
                msgs.appendChild(wrap);
                scrollBottom();
                return wrap;
            }

            function showTyping() {
                const wrap = document.createElement('div');
                wrap.className = 'ct-bubble ai';
                wrap.id = 'ctTyping';
                wrap.innerHTML = `
                    <div class="ct-bubble-body">
                        <div class="ct-typing">
                            <div class="ct-typing-dot"></div>
                            <div class="ct-typing-dot"></div>
                            <div class="ct-typing-dot"></div>
                        </div>
                    </div>`;
                msgs.appendChild(wrap);
                scrollBottom();
            }

            function removeTyping() {
                const el = container.querySelector('#ctTyping');
                if (el) el.remove();
            }

            function updateCtxPill(chunks) {
                if (!chunks.length) {
                    ctxPill.textContent = 'no match found';
                    ctxPill.classList.remove('has-ctx');
                    return;
                }
                const names = [...new Set(chunks.map(c => c.sourceName))];
                ctxPill.textContent = `${chunks.length} chunks · ${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ''}`;
                ctxPill.classList.add('has-ctx');
            }

            /* ══════════ WELCOME + SUGGESTIONS ══════════ */
            async function showWelcome() {
                const deckName = deck.name || 'this deck';
                const docCount = (deck.sources || []).length;

                addBubble('ai', `👋 Hi! I'm your AI tutor for <strong>${deckName}</strong>.<br><br>
I have access to <strong>${docCount} document${docCount !== 1 ? 's' : ''}</strong> you've uploaded.
Ask me anything — I'll find the relevant parts and explain them clearly.<br><br>
<em>Tip: Switch to 🤔 Socratic mode and I'll quiz you back!</em>`);

                if (!hasDocs) return;

                /* generate suggestions from first chunk */
                try {
                    const firstChunk = deck.sources?.[0]?.chunks?.[0]?.text || '';
                    if (!firstChunk) return;

                    const raw = await callLLM(
                        'You are a study assistant. Generate 3 short, varied starter questions a student might ask about this material. Return ONLY a JSON array of strings, no explanation.',
                        [],
                        `Material excerpt: "${firstChunk.slice(0, 400)}"\n\nReturn: ["question 1","question 2","question 3"]`
                    );

                    let suggestions = [];
                    try {
                        const t = raw.trim().replace(/^```[a-z]*\n?/i,'').replace(/\n?```$/i,'').trim();
                        suggestions = JSON.parse(t.slice(t.indexOf('['), t.lastIndexOf(']') + 1));
                    } catch (_) { return; }

                    if (!suggestions.length) return;

                    const suggestWrap = document.createElement('div');
                    suggestWrap.className = 'ct-bubble ai';
                    suggestWrap.innerHTML = `
                        <div class="ct-suggestions">
                            <span class="ct-suggest-label">💡 Try asking:</span>
                            ${suggestions.slice(0, 3).map(q =>
                                `<button class="ct-suggest-btn">${q}</button>`
                            ).join('')}
                        </div>`;
                    msgs.appendChild(suggestWrap);
                    scrollBottom();

                    suggestWrap.querySelectorAll('.ct-suggest-btn').forEach(btn => {
                        btn.addEventListener('click', () => {
                            input.value = btn.textContent;
                            input.style.height = 'auto';
                            input.style.height = Math.min(input.scrollHeight, 110) + 'px';
                            send();
                        });
                    });
                } catch (_) { /* suggestions are optional */ }
            }

            /* ══════════ MAIN SEND ══════════ */
            async function send() {
                const query = input.value.trim();
                if (!query || busy) return;

                busy = true;
                sendBtn.disabled = true;
                input.value = '';
                input.style.height = 'auto';

                /* show user bubble */
                addBubble('user', query.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'));

                /* typing indicator */
                showTyping();

                try {
                    /* 1. RAG retrieval */
                    lastCtx = await retrieve(query, deck);
                    updateCtxPill(lastCtx);

                    /* 2. Build context block */
                    const ctxBlock = lastCtx.length
                        ? '[Context from documents]\n\n' + lastCtx.map((c, i) =>
                            `[Source: "${c.sourceName}"]\n"${c.text.slice(0, MAX_CHUNK_CHARS)}"`
                          ).join('\n\n')
                        : '';

                    /* 3. Build full user message with context */
                    const fullUserMsg = ctxBlock
                        ? `${ctxBlock}\n\n[Student question]\n${query}`
                        : query;

                    /* 4. Call LLM */
                    const sys    = systemPrompt(socratic, lastCtx.length > 0);
                    const reply  = await callLLM(sys, history.slice(-MAX_HISTORY), fullUserMsg);

                    /* 5. Update history (store clean versions) */
                    history.push({ role: 'user', content: query });
                    history.push({ role: 'assistant', content: reply });

                    /* 6. Show reply */
                    removeTyping();
                    const citations = [...new Set(lastCtx.map(c => c.sourceName))];
                    addBubble('ai', md(reply), citations);

                } catch (err) {
                    console.error('[ChatTutor]', err);
                    removeTyping();
                    addBubble('error', `⚠️ ${err.message}`);
                } finally {
                    busy = false;
                    sendBtn.disabled = false;
                    input.focus();
                }
            }

            /* ── boot ── */
            if (!hasDocs) {
                msgs.innerHTML = `
                <div class="ct-nodocs">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    <span>No embedded documents found.<br>Upload and vectorize files in this Deck first, then come back.</span>
                </div>`;
            } else {
                showWelcome();
            }

            input.focus();
        }
    };

    window.NeuroSparkTools.push(toolDefinition);
    console.log('[Tools] Loaded tool: ' + toolDefinition.name);
})();
