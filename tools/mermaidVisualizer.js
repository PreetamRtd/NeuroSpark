/**
 * NeuroSpark Tool: Mermaid Diagram Visualizer
 * Render flowcharts, sequences, ER diagrams and more from syntax or AI.
 * Isolated IIFE — lazy-loads Mermaid.js from CDN only when needed.
 */
(function () {
    if (!window.NeuroSparkTools) window.NeuroSparkTools = [];

    const TOOL_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="16" y="3" width="5" height="5" rx="1"/><rect x="9" y="16" width="6" height="5" rx="1"/><line x1="5.5" y1="8" x2="5.5" y2="13"/><line x1="18.5" y1="8" x2="18.5" y2="13"/><line x1="5.5" y1="13" x2="18.5" y2="13"/><line x1="12" y1="13" x2="12" y2="16"/></svg>`;

    /* ─── Diagram starters ─── */
    const STARTERS = {
        flowchart:  `flowchart TD\n    A([Start]) --> B{Decision}\n    B -->|Yes| C[Do Action]\n    B -->|No| D([End])`,
        sequence:   `sequenceDiagram\n    participant C as Client\n    participant S as Server\n    C->>S: HTTP Request\n    S-->>C: HTTP Response`,
        gantt:      `gantt\n    title Project Plan\n    dateFormat YYYY-MM-DD\n    section Phase 1\n    Design  :a1, 2024-01-01, 7d\n    Dev     :after a1, 14d`,
        class:      `classDiagram\n    class Animal {\n        +name: string\n        +speak() string\n    }\n    class Dog {\n        +fetch()\n    }\n    Animal <|-- Dog`,
        er:         `erDiagram\n    USER ||--o{ ORDER : places\n    ORDER ||--|{ ITEM : contains\n    USER { string name\n           string email }`,
        pie:        `pie title Browser Share\n    "Chrome" : 65\n    "Firefox" : 15\n    "Safari" : 12\n    "Other" : 8`,
        mindmap:    `mindmap\n  root((Core Topic))\n    Branch A\n      Leaf 1\n      Leaf 2\n    Branch B\n      Leaf 3`
    };

    const DEFAULT_DIAGRAM = `flowchart TD
    A([Open NeuroSpark]) --> B{Execution Mode}
    B -->|Cloud API| C[Configure API Key]
    B -->|Local WebGPU| D[Download Model]
    C --> E[Upload Documents]
    D --> E
    E --> F[Use Tools]
    F --> G[RAG Search]
    F --> H[Magic Todo]
    F --> I[HTML Simulator]
    F --> J([Mermaid Diagrams])`;

    /* ─── Lazy-load Mermaid from CDN ─── */
    let mermaidReady = false;
    async function loadMermaid() {
        if (mermaidReady && window.mermaid) return window.mermaid;
        return new Promise((resolve, reject) => {
            if (window.mermaid) {
                window.mermaid.initialize({
                    startOnLoad: false,
                    theme: document.body.classList.contains('dark-theme') ? 'dark' : 'default',
                    securityLevel: 'loose'
                });
                mermaidReady = true;
                return resolve(window.mermaid);
            }
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
            s.onload = () => {
                window.mermaid.initialize({
                    startOnLoad: false,
                    theme: document.body.classList.contains('dark-theme') ? 'dark' : 'default',
                    securityLevel: 'loose'
                });
                mermaidReady = true;
                resolve(window.mermaid);
            };
            s.onerror = () => reject(new Error('Failed to load Mermaid.js from CDN. Check your internet connection.'));
            document.head.appendChild(s);
        });
    }

    /* ─── Render diagram into element ─── */
    async function renderDiagram(code, outputEl) {
        outputEl.innerHTML = `<div class="mm-spinner"><div class="mm-dot"></div><span>Rendering…</span></div>`;
        try {
            const mermaid = await loadMermaid();
            const uid = 'mm-' + Date.now();
            const { svg } = await mermaid.render(uid, code.trim());
            outputEl.innerHTML = `<div class="mm-svg-wrap">${svg}</div>`;
            const svgEl = outputEl.querySelector('svg');
            if (svgEl) { svgEl.style.maxWidth = '100%'; svgEl.style.height = 'auto'; }
        } catch (err) {
            console.error('[MermaidViz] render error:', err);
            outputEl.innerHTML = `<div class="mm-error">⚠️ ${err.message || 'Invalid Mermaid syntax. Check your diagram code.'}</div>`;
        }
    }

    /* ─── Export SVG ─── */
    function exportSVG(outputEl) {
        const svg = outputEl.querySelector('svg');
        if (!svg) { alert('No diagram to export. Render one first.'); return; }
        const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = 'diagram.svg'; a.click();
        URL.revokeObjectURL(url);
    }

    /* ─── AI helper ─── */
    async function callAI(prompt) {
        try {
            const apiConfig = await (window.dbStore ? window.dbStore.get('apiConfig') : Promise.resolve(null));
            const mode      = await (window.dbStore ? window.dbStore.get('executionMode') : Promise.resolve('cloud'));
            if (mode === 'cloud' && apiConfig && apiConfig.key) {
                const provider = apiConfig.provider || 'gemini';
                const key      = apiConfig.key;
                const model    = apiConfig.model || (provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash');

                if (provider === 'gemini') {
                    const fm = model.includes('/') ? model : `models/${model}`;
                    const r  = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fm}:generateContent?key=${key}`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 2048 } })
                    });
                    if (!r.ok) throw new Error(`Gemini ${r.status}`);
                    return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
                }
                if (provider === 'openai') {
                    const r = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 2048, temperature: 0.3 })
                    });
                    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
                    return (await r.json()).choices?.[0]?.message?.content || '';
                }
                if (provider === 'anthropic') {
                    const r = await fetch('https://api.anthropic.com/v1/messages', {
                        method: 'POST',
                        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] })
                    });
                    if (!r.ok) throw new Error(`Anthropic ${r.status}`);
                    return (await r.json()).content?.[0]?.text || '';
                }
            }
        } catch (e) { console.warn('[MermaidViz] AI error:', e); }
        throw new Error('No AI provider configured. Set up an API key in Settings → Cloud API (Online).');
    }

    /* ─── Strip AI fences ─── */
    function parseMermaid(raw) {
        return raw.trim()
            .replace(/^```[a-z]*\n?/i, '')
            .replace(/\n?```$/i, '')
            .trim();
    }

    const toolDefinition = {
        id: 'mermaid-visualizer',
        name: 'Mermaid Diagrams',
        description: 'Render flowcharts, sequences, ER diagrams from syntax or AI description.',
        icon: TOOL_ICON,

        render(container, deck, onBack) {
            let activeTab   = 'editor';
            let editorCode  = DEFAULT_DIAGRAM;
            let lastGenCode = '';

            container.innerHTML = `
<style>
.mm-wrap { display:flex; flex-direction:column; gap:12px; height:100%; width:100%; }
.mm-header { display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--border-color); padding-bottom:12px; flex-shrink:0; }
.mm-title { display:flex; align-items:center; gap:8px; }
.mm-title h4 { font-size:.875rem; font-weight:600; color:var(--text-color); margin:0; }
.mm-back { background:none; border:1px solid var(--border-color); border-radius:4px; padding:4px 10px; font-size:.75rem; color:var(--text-muted); cursor:pointer; }
.mm-tabs { display:flex; gap:6px; flex-shrink:0; }
.mm-tab { padding:6px 14px; border-radius:6px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-muted); font-size:.8125rem; cursor:pointer; transition:all .15s; }
.mm-tab.active { border-color:var(--primary-color); color:var(--primary-color); font-weight:600; }
.mm-panel { display:flex; flex-direction:column; gap:10px; flex:1; min-height:0; }
.mm-panel.hidden { display:none; }
.mm-type-row { display:flex; gap:5px; flex-wrap:wrap; flex-shrink:0; }
.mm-type-label { font-size:.6875rem; color:var(--text-muted); align-self:center; white-space:nowrap; }
.mm-type-btn { padding:4px 10px; border-radius:20px; border:1px solid var(--border-color); background:none; color:var(--text-muted); font-size:.6875rem; cursor:pointer; transition:all .12s; }
.mm-type-btn:hover { color:var(--primary-color); border-color:var(--primary-color); }
.mm-code { width:100%; height:160px; padding:10px 12px; border-radius:8px; border:1px solid var(--border-color); background:#0d0d0d; color:#e2e8f0; font-size:.78rem; font-family:'Fira Mono',monospace; resize:none; outline:none; line-height:1.6; flex-shrink:0; transition:border-color .15s; }
.mm-code:focus { border-color:var(--primary-color); }
.mm-btn-row { display:flex; gap:8px; align-items:center; flex-shrink:0; }
.mm-render-btn { padding:7px 18px; border-radius:7px; border:none; background:var(--primary-color); color:#fff; font-size:.8125rem; font-weight:600; cursor:pointer; transition:opacity .15s; }
.mm-render-btn:disabled { opacity:.5; cursor:not-allowed; }
.mm-clear-btn, .mm-export-btn, .mm-copy-btn { padding:7px 13px; border-radius:7px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-muted); font-size:.8125rem; cursor:pointer; transition:all .12s; }
.mm-clear-btn:hover, .mm-export-btn:hover, .mm-copy-btn:hover { color:var(--text-color); border-color:var(--text-muted); }
.mm-hint { margin-left:auto; font-size:.6875rem; color:var(--text-muted); }
.mm-preview { flex:1; min-height:0; border-radius:8px; overflow:auto; border:1px solid var(--border-color); background:var(--bg-input); display:flex; align-items:flex-start; justify-content:center; padding:16px; }
.mm-svg-wrap { width:100%; }
.mm-svg-wrap svg { display:block; margin:0 auto; }
.mm-spinner { display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; gap:12px; color:var(--text-muted); font-size:.8125rem; padding:40px 0; }
.mm-dot { width:10px; height:10px; border-radius:50%; background:var(--primary-color); animation:badge-pulse 1.2s infinite ease-in-out; }
.mm-error { color:#ef4444; font-size:.75rem; text-align:center; padding:24px; line-height:1.5; width:100%; }
.mm-placeholder { display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; gap:10px; color:var(--text-muted); font-size:.75rem; text-align:center; padding:40px; }
.mm-placeholder svg { opacity:.3; }
.mm-ai-desc { width:100%; height:70px; padding:10px 12px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-color); font-size:.8125rem; font-family:var(--font-sans); resize:none; outline:none; line-height:1.5; flex-shrink:0; transition:border-color .15s; }
.mm-ai-desc:focus { border-color:var(--primary-color); }
.mm-examples { display:flex; gap:5px; flex-wrap:wrap; flex-shrink:0; align-items:center; }
.mm-ex-label { font-size:.6875rem; color:var(--text-muted); white-space:nowrap; }
.mm-ex-btn { padding:4px 10px; border-radius:20px; border:1px solid var(--border-color); background:none; color:var(--text-muted); font-size:.6875rem; cursor:pointer; transition:all .12s; }
.mm-ex-btn:hover { color:var(--primary-color); border-color:var(--primary-color); }
</style>

<div class="mm-wrap">
  <div class="mm-header">
    <div class="mm-title">
      <span style="color:var(--primary-color);display:flex;">${TOOL_ICON}</span>
      <h4>Mermaid Diagrams</h4>
    </div>
    <button class="mm-back" id="mmBack">← Back</button>
  </div>

  <div class="mm-tabs">
    <button class="mm-tab active" data-tab="editor">✏️ Editor</button>
    <button class="mm-tab" data-tab="ai">🤖 AI Generate</button>
  </div>

  <!-- Editor Panel -->
  <div class="mm-panel" id="mmEditorPanel">
    <div class="mm-type-row">
      <span class="mm-type-label">Insert:</span>
      <button class="mm-type-btn" data-starter="flowchart">Flowchart</button>
      <button class="mm-type-btn" data-starter="sequence">Sequence</button>
      <button class="mm-type-btn" data-starter="gantt">Gantt</button>
      <button class="mm-type-btn" data-starter="class">Class</button>
      <button class="mm-type-btn" data-starter="er">ER</button>
      <button class="mm-type-btn" data-starter="pie">Pie</button>
      <button class="mm-type-btn" data-starter="mindmap">Mindmap</button>
    </div>
    <textarea class="mm-code" id="mmCodeArea" spellcheck="false"></textarea>
    <div class="mm-btn-row">
      <button class="mm-render-btn" id="mmRenderBtn">▶ Render</button>
      <button class="mm-clear-btn" id="mmClearBtn">🗑️ Clear</button>
      <button class="mm-export-btn" id="mmExportBtn">💾 Export SVG</button>
      <span class="mm-hint">Ctrl+Enter to render</span>
    </div>
    <div class="mm-preview" id="mmEditorPreview">
      <div class="mm-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="16" y="3" width="5" height="5" rx="1"/><rect x="9" y="16" width="6" height="5" rx="1"/><line x1="5.5" y1="8" x2="5.5" y2="13"/><line x1="18.5" y1="8" x2="18.5" y2="13"/><line x1="5.5" y1="13" x2="18.5" y2="13"/><line x1="12" y1="13" x2="12" y2="16"/></svg>
        <span>Click ▶ Render to preview your diagram.</span>
      </div>
    </div>
  </div>

  <!-- AI Panel -->
  <div class="mm-panel hidden" id="mmAIPanel">
    <textarea class="mm-ai-desc" id="mmAIDesc" placeholder="Describe the diagram you need…&#10;e.g. User login flow · Database schema for a blog · Project timeline · Microservices architecture"></textarea>
    <div class="mm-examples">
      <span class="mm-ex-label">Try:</span>
      <button class="mm-ex-btn">User login sequence</button>
      <button class="mm-ex-btn">E-commerce class diagram</button>
      <button class="mm-ex-btn">CI/CD pipeline flow</button>
      <button class="mm-ex-btn">REST API lifecycle</button>
    </div>
    <div class="mm-btn-row">
      <button class="mm-render-btn" id="mmGenBtn">✨ Generate</button>
      <button class="mm-copy-btn" id="mmCopyBtn" disabled>📋 Copy Code</button>
      <button class="mm-export-btn" id="mmAIExportBtn" disabled>💾 Export SVG</button>
    </div>
    <div class="mm-preview" id="mmAIPreview">
      <div class="mm-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="16" y="3" width="5" height="5" rx="1"/><rect x="9" y="16" width="6" height="5" rx="1"/><line x1="5.5" y1="8" x2="5.5" y2="13"/><line x1="18.5" y1="8" x2="18.5" y2="13"/><line x1="5.5" y1="13" x2="18.5" y2="13"/><line x1="12" y1="13" x2="12" y2="16"/></svg>
        <span>Describe a diagram and click Generate.</span>
      </div>
    </div>
  </div>
</div>`;

            /* ── Back ── */
            container.querySelector('#mmBack').addEventListener('click', onBack);

            /* ── Tab switching ── */
            container.querySelectorAll('.mm-tab').forEach(btn => {
                btn.addEventListener('click', () => {
                    activeTab = btn.dataset.tab;
                    container.querySelectorAll('.mm-tab').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    container.querySelector('#mmEditorPanel').classList.toggle('hidden', activeTab !== 'editor');
                    container.querySelector('#mmAIPanel').classList.toggle('hidden', activeTab !== 'ai');
                });
            });

            /* ── Code area & starter ── */
            const codeArea    = container.querySelector('#mmCodeArea');
            const editorPrev  = container.querySelector('#mmEditorPreview');
            codeArea.value = editorCode;

            container.querySelectorAll('.mm-type-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    codeArea.value = STARTERS[btn.dataset.starter] || '';
                    editorCode = codeArea.value;
                });
            });

            /* ── Render editor ── */
            const renderBtn = container.querySelector('#mmRenderBtn');
            async function doRender() {
                editorCode = codeArea.value.trim();
                if (!editorCode) return;
                renderBtn.disabled = true;
                await renderDiagram(editorCode, editorPrev);
                renderBtn.disabled = false;
            }
            renderBtn.addEventListener('click', doRender);
            codeArea.addEventListener('keydown', e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doRender(); }
                if (e.key === 'Tab') { e.preventDefault(); const s = codeArea.selectionStart; codeArea.value = codeArea.value.slice(0, s) + '  ' + codeArea.value.slice(codeArea.selectionEnd); codeArea.selectionStart = codeArea.selectionEnd = s + 2; }
            });

            /* ── Clear ── */
            container.querySelector('#mmClearBtn').addEventListener('click', () => {
                codeArea.value = ''; editorCode = '';
                editorPrev.innerHTML = `<div class="mm-placeholder"><span>Code cleared.</span></div>`;
            });

            /* ── Export (editor) ── */
            container.querySelector('#mmExportBtn').addEventListener('click', () => exportSVG(editorPrev));

            /* ── Auto-render default on load ── */
            renderDiagram(DEFAULT_DIAGRAM, editorPrev);

            /* ── AI Generate ── */
            const genBtn      = container.querySelector('#mmGenBtn');
            const copyBtn     = container.querySelector('#mmCopyBtn');
            const aiExportBtn = container.querySelector('#mmAIExportBtn');
            const aiPreview   = container.querySelector('#mmAIPreview');
            const aiDesc      = container.querySelector('#mmAIDesc');

            async function generate() {
                const desc = aiDesc.value.trim();
                if (!desc) { aiDesc.focus(); return; }

                genBtn.disabled = true;
                genBtn.textContent = '⏳ Generating…';
                copyBtn.disabled = true;
                aiExportBtn.disabled = true;

                aiPreview.innerHTML = `<div class="mm-spinner"><div class="mm-dot"></div><span>AI is designing your diagram…</span></div>`;

                try {
                    const prompt = `You are a Mermaid diagram expert. Generate a valid Mermaid v10 diagram for the following description:

"${desc}"

Rules:
- Output ONLY the raw Mermaid code. No markdown fences, no backticks, no explanation, no preamble.
- Use correct Mermaid v10 syntax only.
- Choose the most appropriate diagram type automatically.
- Make it comprehensive, well-labelled, and easy to read.
- Keep node/participant labels concise (under 30 characters each).
- Use quotes around labels with spaces or special characters.`;

                    const raw = await callAI(prompt);
                    lastGenCode = parseMermaid(raw);

                    // Sync to editor textarea too
                    codeArea.value = lastGenCode;
                    editorCode     = lastGenCode;

                    await renderDiagram(lastGenCode, aiPreview);
                    copyBtn.disabled    = false;
                    aiExportBtn.disabled = false;
                } catch (err) {
                    console.error('[MermaidViz] AI error:', err);
                    aiPreview.innerHTML = `<div class="mm-error">⚠️ ${err.message}</div>`;
                } finally {
                    genBtn.disabled = false;
                    genBtn.textContent = '✨ Generate';
                }
            }

            genBtn.addEventListener('click', generate);
            aiDesc.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });

            /* ── Example buttons ── */
            container.querySelectorAll('.mm-ex-btn').forEach(btn => {
                btn.addEventListener('click', () => { aiDesc.value = btn.textContent.trim(); });
            });

            /* ── Copy Mermaid code ── */
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(lastGenCode);
                    copyBtn.textContent = '✅ Copied!';
                    setTimeout(() => { copyBtn.textContent = '📋 Copy Code'; }, 1800);
                } catch (_) {}
            });

            /* ── Export AI diagram ── */
            aiExportBtn.addEventListener('click', () => exportSVG(aiPreview));
        }
    };

    window.NeuroSparkTools.push(toolDefinition);
    console.log('[Tools] Loaded tool: ' + toolDefinition.name);
})();
