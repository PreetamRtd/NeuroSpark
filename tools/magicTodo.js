/**
 * NeuroSpark Tool: Magic Todo
 * Inspired by Goblin Tools — breaks any vague task into clear,
 * actionable sub-steps with time estimates using AI.
 * Isolated, lightweight, zero external dependencies.
 */
(function () {
    if (!window.NeuroSparkTools) window.NeuroSparkTools = [];

    /* ─── Constants ─── */
    const SPICE_LEVELS = [
        { label: 'Mild',   emoji: '🌶️',  desc: '3–5 broad steps' },
        { label: 'Medium', emoji: '🌶️🌶️', desc: '5–8 detailed steps' },
        { label: 'Hot',    emoji: '🌶️🌶️🌶️', desc: '8–12 very granular steps' },
    ];

    const TOOL_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`;

    /* ─── Utility: call configured AI (cloud or local) ─── */
    async function callAI(prompt) {
        // Try cloud API first
        try {
            const apiConfig = await (window.dbStore ? window.dbStore.get('apiConfig') : Promise.resolve(null));
            const mode      = await (window.dbStore ? window.dbStore.get('executionMode') : Promise.resolve('cloud'));

            if (mode === 'cloud' && apiConfig && apiConfig.key) {
                const provider = apiConfig.provider || 'gemini';
                const key      = apiConfig.key;
                const model    = apiConfig.model || (provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash');

                if (provider === 'gemini') {
                    const fmtModel = model.includes('/') ? model : `models/${model}`;
                    const res = await fetch(
                        `https://generativelanguage.googleapis.com/v1beta/${fmtModel}:generateContent?key=${key}`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: [{ parts: [{ text: prompt }] }],
                                generationConfig: { temperature: 0.4, maxOutputTokens: 1024 }
                            })
                        }
                    );
                    if (!res.ok) throw new Error(`Gemini ${res.status}`);
                    const data = await res.json();
                    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                }

                if (provider === 'openai') {
                    const res = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${key}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model,
                            messages: [{ role: 'user', content: prompt }],
                            max_tokens: 1024,
                            temperature: 0.4
                        })
                    });
                    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
                    const data = await res.json();
                    return data.choices?.[0]?.message?.content || '';
                }

                if (provider === 'anthropic') {
                    const res = await fetch('https://api.anthropic.com/v1/messages', {
                        method: 'POST',
                        headers: {
                            'x-api-key': key,
                            'anthropic-version': '2023-06-01',
                            'anthropic-dangerous-direct-browser-access': 'true',
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model,
                            max_tokens: 1024,
                            messages: [{ role: 'user', content: prompt }]
                        })
                    });
                    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
                    const data = await res.json();
                    return data.content?.[0]?.text || '';
                }
            }
        } catch (e) {
            console.warn('[MagicTodo] Cloud AI failed:', e);
        }

        // Fallback: local LLM via Transformers.js pipeline
        if (window.transformers && window.transformers.pipeline) {
            const pipe = await window.transformers.pipeline('text-generation', 'onnx-community/Qwen2.5-0.5B-Instruct-ONNX');
            const out  = await pipe(prompt, { max_new_tokens: 512 });
            return out?.[0]?.generated_text?.replace(prompt, '').trim() || '';
        }

        throw new Error('No AI provider configured. Please set up an API key in Settings → Cloud API, or download a Local LLM.');
    }

    /* ─── Build the AI prompt ─── */
    function buildPrompt(task, spiceIdx) {
        const spice = SPICE_LEVELS[spiceIdx];
        return `You are a productivity assistant. Break the following task into ${spice.desc}.

Task: "${task}"

Rules:
- Output ONLY a valid JSON array. No markdown fences, no explanation.
- Each element is an object: { "step": string, "time": string, "emoji": string }
- "step" is a clear, concrete action verb sentence (max 15 words)
- "time" is a realistic time estimate like "5 min", "30 min", "1–2 hr"
- "emoji" is a single relevant emoji that visually represents the action
- Keep steps in correct execution order
- Be specific, practical, and actionable

JSON array:`;
    }

    /* ─── Parse AI response robustly ─── */
    function parseSteps(raw) {
        // Strip markdown fences if present
        let text = raw.trim()
            .replace(/^```[a-z]*\n?/i, '')
            .replace(/```$/i, '')
            .trim();

        // Extract first JSON array
        const start = text.indexOf('[');
        const end   = text.lastIndexOf(']');
        if (start === -1 || end === -1) throw new Error('AI did not return a valid step list. Try again.');
        text = text.slice(start, end + 1);

        const steps = JSON.parse(text);
        if (!Array.isArray(steps) || steps.length === 0) throw new Error('AI returned an empty list. Try a different task.');
        return steps;
    }

    /* ─── Render step card HTML ─── */
    function stepCardHTML(step, idx, total) {
        return `
        <div class="magic-step-card" data-idx="${idx}">
            <div class="magic-step-header">
                <div class="magic-step-left">
                    <span class="magic-step-num">${idx + 1}/${total}</span>
                    <span class="magic-step-emoji">${step.emoji || '✅'}</span>
                </div>
                <span class="magic-step-time">${step.time || '?'}</span>
            </div>
            <div class="magic-step-text">${step.step}</div>
            <div class="magic-step-footer">
                <label class="magic-check-label">
                    <input type="checkbox" class="magic-step-check" data-idx="${idx}">
                    <span>Done</span>
                </label>
            </div>
        </div>`;
    }

    /* ─── Tool Definition ─── */
    const toolDefinition = {
        id: 'magic-todo',
        name: 'Magic Todo',
        description: 'Break any vague task into clear, timed sub-steps using AI.',
        icon: TOOL_ICON,

        render: (container, deck, onBack) => {
            let currentSpice = 1; // default Medium

            container.innerHTML = `
            <style>
                .magic-todo-wrap { display:flex; flex-direction:column; gap:14px; height:100%; width:100%; }
                .magic-todo-header { display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--border-color); padding-bottom:12px; }
                .magic-todo-title { display:flex; align-items:center; gap:8px; }
                .magic-todo-title h4 { font-size:0.875rem; font-weight:600; color:var(--text-color); margin:0; }
                .magic-back-btn { background:none; border:1px solid var(--border-color); border-radius:4px; padding:4px 10px; font-size:0.75rem; color:var(--text-muted); cursor:pointer; }
                .magic-input-row { display:flex; gap:8px; }
                .magic-input-row textarea {
                    flex:1; padding:10px 12px; border-radius:8px; border:1px solid var(--border-color);
                    background:var(--bg-input); color:var(--text-color); font-size:0.8125rem;
                    font-family:var(--font-sans); resize:none; outline:none; line-height:1.5;
                    transition: border-color 0.15s;
                }
                .magic-input-row textarea:focus { border-color:var(--primary-color); }
                .magic-spice-row { display:flex; gap:8px; align-items:center; }
                .magic-spice-label { font-size:0.75rem; color:var(--text-muted); white-space:nowrap; }
                .magic-spice-btn {
                    padding:5px 11px; border-radius:20px; border:1px solid var(--border-color);
                    background:var(--bg-input); color:var(--text-muted); font-size:0.75rem;
                    cursor:pointer; transition:all 0.15s; white-space:nowrap;
                }
                .magic-spice-btn.active {
                    border-color:var(--primary-color); background:var(--primary-color);
                    color:#fff; font-weight:600;
                }
                .magic-run-btn {
                    padding:9px 20px; border-radius:8px; border:none;
                    background:var(--primary-color); color:#fff;
                    font-size:0.8125rem; font-weight:600; cursor:pointer;
                    transition:opacity 0.15s; white-space:nowrap;
                }
                .magic-run-btn:disabled { opacity:0.55; cursor:not-allowed; }
                .magic-results { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:10px; min-height:200px; }
                .magic-placeholder {
                    display:flex; flex-direction:column; align-items:center; justify-content:center;
                    height:100%; gap:10px; color:var(--text-muted); font-size:0.75rem; text-align:center; padding:24px;
                }
                .magic-placeholder svg { opacity:0.4; }
                .magic-step-card {
                    background:var(--bg-input); border:1px solid var(--border-color); border-radius:8px;
                    padding:12px 14px; display:flex; flex-direction:column; gap:6px;
                    transition: border-color 0.2s, opacity 0.2s;
                }
                .magic-step-card.done { opacity:0.55; border-color:transparent; }
                .magic-step-card.done .magic-step-text { text-decoration:line-through; color:var(--text-muted); }
                .magic-step-header { display:flex; align-items:center; justify-content:space-between; }
                .magic-step-left { display:flex; align-items:center; gap:8px; }
                .magic-step-num { font-size:0.6875rem; font-weight:600; color:var(--text-muted); }
                .magic-step-emoji { font-size:1.125rem; line-height:1; }
                .magic-step-time {
                    font-size:0.6875rem; font-weight:600; color:var(--primary-color);
                    background:var(--bg-card); border:1px solid var(--border-color);
                    border-radius:20px; padding:2px 8px;
                }
                .magic-step-text { font-size:0.8125rem; color:var(--text-color); line-height:1.45; }
                .magic-step-footer { display:flex; align-items:center; justify-content:flex-end; margin-top:2px; }
                .magic-check-label { display:flex; align-items:center; gap:6px; cursor:pointer; font-size:0.75rem; color:var(--text-muted); user-select:none; }
                .magic-check-label input[type=checkbox] { accent-color:var(--primary-color); width:14px; height:14px; }
                .magic-summary-bar {
                    display:flex; align-items:center; justify-content:space-between;
                    padding:8px 12px; border-radius:8px; background:var(--bg-input);
                    border:1px solid var(--border-color); font-size:0.75rem; color:var(--text-muted);
                }
                .magic-summary-bar span b { color:var(--text-color); }
                .magic-copy-btn {
                    background:none; border:1px solid var(--border-color); border-radius:4px;
                    padding:4px 10px; font-size:0.6875rem; color:var(--text-muted); cursor:pointer;
                    transition:color 0.15s; white-space:nowrap;
                }
                .magic-copy-btn:hover { color:var(--primary-color); border-color:var(--primary-color); }
                .magic-spinner {
                    display:flex; flex-direction:column; align-items:center; justify-content:center;
                    height:100%; gap:12px; color:var(--text-muted); font-size:0.8125rem;
                }
                .magic-dot {
                    width:10px; height:10px; border-radius:50%;
                    background:var(--primary-color); animation:badge-pulse 1.2s infinite ease-in-out;
                }
                .magic-error {
                    display:flex; align-items:center; justify-content:center; height:100%;
                    color:#ef4444; font-size:0.75rem; text-align:center; padding:24px; line-height:1.5;
                }
            </style>

            <div class="magic-todo-wrap">
                <!-- Header -->
                <div class="magic-todo-header">
                    <div class="magic-todo-title">
                        <span style="color:var(--primary-color);display:flex;">${TOOL_ICON}</span>
                        <h4>Magic Todo</h4>
                    </div>
                    <button class="magic-back-btn" id="magicBackBtn">← Back</button>
                </div>

                <!-- Task Input -->
                <div class="magic-input-row">
                    <textarea id="magicTaskInput" rows="2" placeholder="Describe any task… e.g. 'Write a research paper on climate change' or 'Set up a new React project'"></textarea>
                </div>

                <!-- Spice Level Row -->
                <div class="magic-spice-row">
                    <span class="magic-spice-label">Detail:</span>
                    ${SPICE_LEVELS.map((s, i) => `
                        <button class="magic-spice-btn${i === currentSpice ? ' active' : ''}" data-spice="${i}">
                            ${s.emoji} ${s.label}
                        </button>
                    `).join('')}
                    <button class="magic-run-btn" id="magicRunBtn">✨ Break it down</button>
                </div>

                <!-- Results -->
                <div class="magic-results" id="magicResults">
                    <div class="magic-placeholder">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                        <span>Enter a task above and click <b>Break it down</b>.<br>Works with Cloud API or Local LLM.</span>
                    </div>
                </div>
            </div>`;

            /* ─── Bind Back ─── */
            container.querySelector('#magicBackBtn').addEventListener('click', onBack);

            /* ─── Spice buttons ─── */
            container.querySelectorAll('.magic-spice-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    currentSpice = parseInt(btn.dataset.spice);
                    container.querySelectorAll('.magic-spice-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                });
            });

            /* ─── Main run handler ─── */
            const runBtn     = container.querySelector('#magicRunBtn');
            const taskInput  = container.querySelector('#magicTaskInput');
            const resultsDiv = container.querySelector('#magicResults');

            let steps = [];

            async function runMagic() {
                const task = taskInput.value.trim();
                if (!task) { taskInput.focus(); return; }

                runBtn.disabled = true;
                runBtn.textContent = '⏳ Thinking…';

                resultsDiv.innerHTML = `
                    <div class="magic-spinner">
                        <div class="magic-dot"></div>
                        <span>AI is breaking down your task…</span>
                    </div>`;

                try {
                    const prompt = buildPrompt(task, currentSpice);
                    const raw    = await callAI(prompt);
                    steps        = parseSteps(raw);
                    renderSteps(task);
                } catch (err) {
                    console.error('[MagicTodo]', err);
                    resultsDiv.innerHTML = `<div class="magic-error">⚠️ ${err.message}</div>`;
                } finally {
                    runBtn.disabled = false;
                    runBtn.textContent = '✨ Break it down';
                }
            }

            /* ─── Render step cards ─── */
            function renderSteps(task) {
                const total   = steps.length;
                const totalMs = estimateTotalMinutes(steps);
                const totalStr = totalMs < 60
                    ? `~${totalMs} min`
                    : `~${(totalMs / 60).toFixed(1).replace('.0', '')} hr`;

                resultsDiv.innerHTML = `
                    <div class="magic-summary-bar">
                        <span><b>${total}</b> steps · <b>${totalStr}</b> estimated total</span>
                        <button class="magic-copy-btn" id="magicCopyBtn">📋 Copy list</button>
                    </div>
                    ${steps.map((s, i) => stepCardHTML(s, i, total)).join('')}
                `;

                // Checkbox done state
                resultsDiv.querySelectorAll('.magic-step-check').forEach(cb => {
                    cb.addEventListener('change', () => {
                        const card = resultsDiv.querySelector(`.magic-step-card[data-idx="${cb.dataset.idx}"]`);
                        if (card) card.classList.toggle('done', cb.checked);
                    });
                });

                // Copy to clipboard
                resultsDiv.querySelector('#magicCopyBtn')?.addEventListener('click', async () => {
                    const text = [`📝 ${task}\n`]
                        .concat(steps.map((s, i) => `${i + 1}. ${s.emoji || ''} ${s.step} [${s.time}]`))
                        .join('\n');
                    try {
                        await navigator.clipboard.writeText(text);
                        const btn = resultsDiv.querySelector('#magicCopyBtn');
                        btn.textContent = '✅ Copied!';
                        setTimeout(() => { btn.textContent = '📋 Copy list'; }, 1800);
                    } catch (_) {}
                });
            }

            /* ─── Enter key shortcut (Ctrl/Cmd+Enter in textarea) ─── */
            taskInput.addEventListener('keydown', e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runMagic();
            });

            runBtn.addEventListener('click', runMagic);
        }
    };

    /* ─── Time estimation helper ─── */
    function estimateTotalMinutes(steps) {
        let total = 0;
        const re  = /(\d+(?:\.\d+)?)\s*(?:–|-)\s*(\d+(?:\.\d+)?)\s*(min|hr|hour)?|(\d+(?:\.\d+)?)\s*(min|hr|hour)/i;
        steps.forEach(s => {
            const m = re.exec(s.time || '');
            if (!m) return;
            const isRange = !!m[1];
            let val;
            if (isRange) {
                val = (parseFloat(m[1]) + parseFloat(m[2])) / 2;
                if (/hr|hour/i.test(m[3] || '')) val *= 60;
            } else {
                val = parseFloat(m[4]);
                if (/hr|hour/i.test(m[5] || '')) val *= 60;
            }
            total += isNaN(val) ? 5 : val;
        });
        return Math.round(total) || steps.length * 10;
    }

    window.NeuroSparkTools.push(toolDefinition);
    console.log('[Tools] Loaded tool: ' + toolDefinition.name);
})();
