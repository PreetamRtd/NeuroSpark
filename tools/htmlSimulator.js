/**
 * NeuroSpark Tool: HTML Simulator
 * Live HTML/CSS/JS playground with AI-powered visual generation.
 * Isolated IIFE — zero external dependencies.
 */
(function () {
    if (!window.NeuroSparkTools) window.NeuroSparkTools = [];

    const TOOL_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;

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
                        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 4096 } })
                    });
                    if (!r.ok) throw new Error(`Gemini ${r.status}`);
                    return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
                }
                if (provider === 'openai') {
                    const r = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 4096, temperature: 0.5 })
                    });
                    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
                    return (await r.json()).choices?.[0]?.message?.content || '';
                }
                if (provider === 'anthropic') {
                    const r = await fetch('https://api.anthropic.com/v1/messages', {
                        method: 'POST',
                        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] })
                    });
                    if (!r.ok) throw new Error(`Anthropic ${r.status}`);
                    return (await r.json()).content?.[0]?.text || '';
                }
            }
        } catch (e) { console.warn('[HtmlSimulator] AI error:', e); }
        throw new Error('No AI provider configured. Set up an API key in Settings → Cloud API (Online).');
    }

    /* ─── Parse HTML from AI (strip fences) ─── */
    function parseHTML(raw) {
        return raw.trim()
            .replace(/^```[a-z]*\n?/i, '')
            .replace(/\n?```$/i, '')
            .trim();
    }

    /* ─── Run code in sandboxed iframe ─── */
    function runInFrame(iframe, html, css, js) {
        iframe.srcdoc = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{box-sizing:border-box}body{margin:0;font-family:sans-serif}${css}</style></head><body>${html}<script>${js}<\/script></body></html>`;
    }

    const toolDefinition = {
        id: 'html-simulator',
        name: 'HTML Simulator',
        description: 'Live HTML/CSS/JS playground. Visualize algorithms, animations, and simulations.',
        icon: TOOL_ICON,

        render(container, deck, onBack) {
            /* State */
            let activeTab = 'editor'; // 'editor' | 'ai'
            let htmlCode  = '<!-- your HTML here -->';
            let cssCode   = '/* your CSS here */\nbody { background: #0f0f0f; color: #f0f0f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: sans-serif; }\nh1 { font-size: 2rem; }';
            let jsCode    = '// your JS here';
            let activeCode = 'html'; // which sub-tab in editor

            container.innerHTML = `
<style>
.sim-wrap { display:flex; flex-direction:column; gap:12px; height:100%; width:100%; }
.sim-header { display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--border-color); padding-bottom:12px; flex-shrink:0; }
.sim-title { display:flex; align-items:center; gap:8px; }
.sim-title h4 { font-size:.875rem; font-weight:600; color:var(--text-color); margin:0; }
.sim-back { background:none; border:1px solid var(--border-color); border-radius:4px; padding:4px 10px; font-size:.75rem; color:var(--text-muted); cursor:pointer; }
.sim-tabs { display:flex; gap:6px; flex-shrink:0; }
.sim-tab { padding:6px 14px; border-radius:6px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-muted); font-size:.8125rem; cursor:pointer; transition:all .15s; }
.sim-tab.active { border-color:var(--primary-color); color:var(--primary-color); font-weight:600; }
.sim-panel { display:flex; flex-direction:column; gap:10px; flex:1; min-height:0; }
.sim-panel.hidden { display:none; }
.sim-subtabs { display:flex; gap:4px; flex-shrink:0; }
.sim-subtab { padding:4px 12px; border-radius:4px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-muted); font-size:.75rem; cursor:pointer; transition:all .12s; font-family:monospace; }
.sim-subtab.active { border-color:var(--primary-color); color:var(--primary-color); }
.sim-code { width:100%; height:160px; padding:10px 12px; border-radius:8px; border:1px solid var(--border-color); background:#0d0d0d; color:#e2e8f0; font-size:.8rem; font-family:'Fira Mono',monospace; resize:none; outline:none; line-height:1.55; flex-shrink:0; transition:border-color .15s; }
.sim-code:focus { border-color:var(--primary-color); }
.sim-btn-row { display:flex; gap:8px; flex-shrink:0; }
.sim-run-btn { padding:7px 18px; border-radius:7px; border:none; background:var(--primary-color); color:#fff; font-size:.8125rem; font-weight:600; cursor:pointer; transition:opacity .15s; }
.sim-run-btn:disabled { opacity:.5; cursor:not-allowed; }
.sim-clear-btn, .sim-copy-btn, .sim-export-btn { padding:7px 14px; border-radius:7px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-muted); font-size:.8125rem; cursor:pointer; transition:all .12s; }
.sim-clear-btn:hover, .sim-copy-btn:hover { color:var(--text-color); border-color:var(--text-muted); }
.sim-preview { flex:1; min-height:0; border-radius:8px; overflow:hidden; border:1px solid var(--border-color); background:#0f0f0f; }
.sim-preview iframe { width:100%; height:100%; border:none; display:block; }
.sim-ai-desc { width:100%; height:80px; padding:10px 12px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-color); font-size:.8125rem; font-family:var(--font-sans); resize:none; outline:none; line-height:1.5; flex-shrink:0; transition:border-color .15s; }
.sim-ai-desc:focus { border-color:var(--primary-color); }
.sim-spinner { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:12px; color:var(--text-muted); font-size:.8125rem; }
.sim-dot { width:10px; height:10px; border-radius:50%; background:var(--primary-color); animation:badge-pulse 1.2s infinite ease-in-out; }
.sim-err { display:flex; align-items:center; justify-content:center; height:100%; color:#ef4444; font-size:.75rem; text-align:center; padding:24px; line-height:1.5; }
.sim-examples { display:flex; gap:6px; flex-wrap:wrap; flex-shrink:0; }
.sim-example { padding:4px 10px; border-radius:20px; border:1px solid var(--border-color); background:none; color:var(--text-muted); font-size:.6875rem; cursor:pointer; transition:all .12s; }
.sim-example:hover { color:var(--primary-color); border-color:var(--primary-color); }
</style>

<div class="sim-wrap">
  <div class="sim-header">
    <div class="sim-title">
      <span style="color:var(--primary-color);display:flex;">${TOOL_ICON}</span>
      <h4>HTML Simulator</h4>
    </div>
    <button class="sim-back" id="simBack">← Back</button>
  </div>

  <div class="sim-tabs">
    <button class="sim-tab active" data-tab="editor" id="simTabEditor">✏️ Editor</button>
    <button class="sim-tab" data-tab="ai" id="simTabAI">🤖 AI Generate</button>
  </div>

  <!-- Editor Panel -->
  <div class="sim-panel" id="simEditorPanel">
    <div class="sim-subtabs">
      <button class="sim-subtab active" data-sub="html">HTML</button>
      <button class="sim-subtab" data-sub="css">CSS</button>
      <button class="sim-subtab" data-sub="js">JS</button>
    </div>
    <textarea class="sim-code" id="simCodeArea" spellcheck="false"></textarea>
    <div class="sim-btn-row">
      <button class="sim-run-btn" id="simRunBtn">▶ Run</button>
      <button class="sim-clear-btn" id="simClearBtn">🗑️ Clear</button>
      <span style="margin-left:auto;font-size:.6875rem;color:var(--text-muted);align-self:center;">Ctrl+Enter to run</span>
    </div>
    <div class="sim-preview" id="simEditorPreview">
      <iframe id="simEditorFrame" sandbox="allow-scripts" title="HTML Preview"></iframe>
    </div>
  </div>

  <!-- AI Panel -->
  <div class="sim-panel hidden" id="simAIPanel">
    <textarea class="sim-ai-desc" id="simAIDesc" placeholder="Describe what you want to visualize or simulate…&#10;e.g. Animate bubble sort · Show TCP handshake · Bouncing ball physics · Solar system orbit"></textarea>
    <div class="sim-examples" id="simExamples">
      <span style="font-size:.6875rem;color:var(--text-muted);align-self:center;">Try:</span>
      <button class="sim-example">Bubble sort animation</button>
      <button class="sim-example">Solar system orbits</button>
      <button class="sim-example">Neural network diagram</button>
      <button class="sim-example">Bouncing ball physics</button>
      <button class="sim-example">Binary search tree</button>
    </div>
    <div class="sim-btn-row">
      <button class="sim-run-btn" id="simGenBtn">✨ Generate</button>
      <button class="sim-copy-btn" id="simCopyBtn" disabled>📋 Copy Code</button>
    </div>
    <div class="sim-preview" id="simAIPreview">
      <div class="sim-spinner" style="height:100%;">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".35"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        <span style="margin-top:4px;">Describe something and click Generate.</span>
      </div>
    </div>
  </div>
</div>`;

            /* ── Back ── */
            container.querySelector('#simBack').addEventListener('click', onBack);

            /* ── Tab switching ── */
            container.querySelectorAll('.sim-tab').forEach(btn => {
                btn.addEventListener('click', () => {
                    activeTab = btn.dataset.tab;
                    container.querySelectorAll('.sim-tab').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    container.querySelector('#simEditorPanel').classList.toggle('hidden', activeTab !== 'editor');
                    container.querySelector('#simAIPanel').classList.toggle('hidden', activeTab !== 'ai');
                });
            });

            /* ── Code sub-tabs (HTML / CSS / JS) ── */
            const codeArea = container.querySelector('#simCodeArea');
            codeArea.value = htmlCode;

            container.querySelectorAll('.sim-subtab').forEach(btn => {
                btn.addEventListener('click', () => {
                    // Save current before switching
                    if (activeCode === 'html') htmlCode = codeArea.value;
                    else if (activeCode === 'css') cssCode = codeArea.value;
                    else jsCode = codeArea.value;

                    activeCode = btn.dataset.sub;
                    container.querySelectorAll('.sim-subtab').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    codeArea.value = activeCode === 'html' ? htmlCode : activeCode === 'css' ? cssCode : jsCode;
                });
            });

            /* ── Run editor ── */
            const editorFrame = container.querySelector('#simEditorFrame');
            function runEditor() {
                if (activeCode === 'html') htmlCode = codeArea.value;
                else if (activeCode === 'css') cssCode = codeArea.value;
                else jsCode = codeArea.value;
                runInFrame(editorFrame, htmlCode, cssCode, jsCode);
            }

            container.querySelector('#simRunBtn').addEventListener('click', runEditor);
            codeArea.addEventListener('keydown', e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runEditor(); }
                // Tab key inserts spaces
                if (e.key === 'Tab') {
                    e.preventDefault();
                    const s = codeArea.selectionStart;
                    codeArea.value = codeArea.value.slice(0, s) + '    ' + codeArea.value.slice(codeArea.selectionEnd);
                    codeArea.selectionStart = codeArea.selectionEnd = s + 4;
                }
            });

            /* ── Clear ── */
            container.querySelector('#simClearBtn').addEventListener('click', () => {
                htmlCode = ''; cssCode = ''; jsCode = '';
                codeArea.value = '';
                editorFrame.srcdoc = '';
            });

            /* ── AI Generate ── */
            const genBtn    = container.querySelector('#simGenBtn');
            const copyBtn   = container.querySelector('#simCopyBtn');
            const aiPreview = container.querySelector('#simAIPreview');
            const aiDesc    = container.querySelector('#simAIDesc');
            let generatedHTML = '';

            async function generate() {
                const desc = aiDesc.value.trim();
                if (!desc) { aiDesc.focus(); return; }

                genBtn.disabled = true;
                genBtn.textContent = '⏳ Generating…';
                copyBtn.disabled = true;

                aiPreview.innerHTML = `<div class="sim-spinner"><div class="sim-dot"></div><span>AI is building your simulation…</span></div>`;

                try {
                    const prompt = `You are an expert creative web developer. Create a complete, self-contained, single-file HTML page that: ${desc}

Rules:
- Output ONLY raw HTML starting with <!DOCTYPE html>. No markdown fences, no explanation.
- All CSS in <style> tag, all JS in <script> tag. Zero external CDN links.
- Dark background (#0f0f0f or #111). Visually beautiful, interactive, animated.
- Vanilla JS only. Must work in an iframe with sandbox="allow-scripts".
- Include smooth animations, labels, and clear visual feedback.
- Add a title matching the description.`;

                    const raw = await callAI(prompt);
                    generatedHTML = parseHTML(raw);

                    // Render in preview
                    aiPreview.innerHTML = `<iframe sandbox="allow-scripts" title="Generated Preview" style="width:100%;height:100%;border:none;display:block;"></iframe>`;
                    aiPreview.querySelector('iframe').srcdoc = generatedHTML;

                    // Copy code into editor
                    htmlCode = generatedHTML; cssCode = ''; jsCode = '';
                    if (activeCode === 'html') codeArea.value = htmlCode;
                    copyBtn.disabled = false;
                } catch (err) {
                    console.error('[HtmlSimulator]', err);
                    aiPreview.innerHTML = `<div class="sim-err">⚠️ ${err.message}</div>`;
                } finally {
                    genBtn.disabled = false;
                    genBtn.textContent = '✨ Generate';
                }
            }

            genBtn.addEventListener('click', generate);
            aiDesc.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });

            /* ── Example buttons ── */
            container.querySelectorAll('.sim-example').forEach(btn => {
                btn.addEventListener('click', () => { aiDesc.value = btn.textContent.trim(); });
            });

            /* ── Copy Code ── */
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(generatedHTML);
                    copyBtn.textContent = '✅ Copied!';
                    setTimeout(() => { copyBtn.textContent = '📋 Copy Code'; }, 1800);
                } catch (_) {}
            });
        }
    };

    window.NeuroSparkTools.push(toolDefinition);
    console.log('[Tools] Loaded tool: ' + toolDefinition.name);
})();
