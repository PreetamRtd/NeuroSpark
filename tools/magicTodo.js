/**
 * NeuroSpark Tool: Magic Todo
 * Breaks down tasks into structured, timed checklists with editing and planning controls.
 * Uses Structured Outputs to ensure reliable AI generation.
 */
(function () {
    if (!window.NeuroSparkTools) window.NeuroSparkTools = [];

    const TOOL_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`;

    const DETAILS_LEVELS = [
        { label: 'Low', desc: '3–5 broad, high-level steps' },
        { label: 'Mid', desc: '5–8 detailed, standard steps' },
        { label: 'High', desc: '8–12 very specific, granular steps' }
    ];

    // --- LLM Fetch Helper with Structured Output ---
    async function callStructuredAI(prompt, provider, key, model) {
        if (provider === 'gemini') {
            const formattedModel = model.includes('/') ? model : `models/${model}`;
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${formattedModel}:generateContent?key=${key}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.4,
                        responseMimeType: "application/json",
                        responseSchema: {
                            type: "OBJECT",
                            properties: {
                                steps: {
                                    type: "ARRAY",
                                    description: "List of timed steps to achieve the task.",
                                    items: {
                                        type: "OBJECT",
                                        properties: {
                                            step: { type: "STRING", description: "The subtask action description." },
                                            time: { type: "STRING", description: "Estimated time duration, e.g. 15 min." },
                                            emoji: { type: "STRING", description: "Single descriptive emoji." }
                                        },
                                        required: ["step", "time", "emoji"]
                                    }
                                }
                            },
                            required: ["steps"]
                        }
                    }
                })
            });

            if (!res.ok) throw new Error(`Gemini API returned status ${res.status}`);
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('Empty response from Gemini');
            return JSON.parse(text).steps;
        }

        if (provider === 'openai') {
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: model,
                    messages: [{ role: 'user', content: prompt }],
                    response_format: {
                        type: "json_schema",
                        json_schema: {
                            name: "todo_steps_schema",
                            strict: true,
                            schema: {
                                type: "object",
                                properties: {
                                    steps: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            properties: {
                                                step: { type: "string" },
                                                time: { type: "string" },
                                                emoji: { type: "string" }
                                            },
                                            required: ["step", "time", "emoji"],
                                            additionalProperties: false
                                        }
                                    }
                                },
                                required: ["steps"],
                                additionalProperties: false
                            }
                        }
                    }
                })
            });

            if (!res.ok) throw new Error(`OpenAI API returned status ${res.status}`);
            const data = await res.json();
            const text = data.choices?.[0]?.message?.content;
            if (!text) throw new Error('Empty response from OpenAI');
            return JSON.parse(text).steps;
        }

        // Fallback / local
        const instructionPrompt = prompt + `\n\nReturn ONLY a valid JSON object matching this schema. Do not output markdown fences or code blocks:
{
  "steps": [
    {
      "step": "string",
      "time": "string",
      "emoji": "string"
    }
  ]
}`;

        let rawResponse = '';
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
                    model: model,
                    max_tokens: 1024,
                    messages: [{ role: 'user', content: instructionPrompt }]
                })
            });
            if (!res.ok) throw new Error(`Anthropic API returned status ${res.status}`);
            const data = await res.json();
            rawResponse = data.content?.[0]?.text || '';
        } else {
            if (window.transformers && window.transformers.pipeline) {
                const pipe = await window.transformers.pipeline('text-generation', 'onnx-community/Qwen2.5-0.5B-Instruct-ONNX');
                const out = await pipe(instructionPrompt, { max_new_tokens: 512 });
                rawResponse = out?.[0]?.generated_text?.replace(instructionPrompt, '').trim() || '';
            } else {
                throw new Error("Local model engine not ready and no Cloud API configured.");
            }
        }

        try {
            let jsonText = rawResponse.trim()
                .replace(/^```[a-z]*\n?/i, '')
                .replace(/\n?```$/i, '')
                .trim();
            const start = jsonText.indexOf('{');
            const end = jsonText.lastIndexOf('}');
            if (start !== -1 && end !== -1) {
                jsonText = jsonText.slice(start, end + 1);
            }
            return JSON.parse(jsonText).steps;
        } catch (e) {
            console.error('[MagicTodo] Fallback JSON parse failed:', e);
            throw new Error("AI did not return a valid steps list. Try again.");
        }
    }

    /* ─── Time Estimation Helper ─── */
    function estimateTotalMinutes(steps) {
        let total = 0;
        const re = /(\d+(?:\.\d+)?)\s*(?:–|-)\s*(\d+(?:\.\d+)?)\s*(min|hr|hour)?|(\d+(?:\.\d+)?)\s*(min|hr|hour)/i;
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

    // --- Tool Definition ---
    const toolDefinition = {
        id: 'magic-todo',
        name: 'Magic Todo',
        description: 'Break any task into a structured timed subtask checklist.',
        icon: TOOL_ICON,

        render(container, deck, onBack) {
            let steps = [];

            container.innerHTML = `
<style>
    .td-wrap { display: flex; flex-direction: column; gap: 14px; height: 100%; width: 100%; font-family: var(--font-sans); }
    .td-header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 12px; }
    .td-title { display: flex; align-items: center; gap: 8px; }
    .td-title h4 { font-size: 0.875rem; font-weight: 600; color: var(--text-color); margin: 0; }
    .td-back-btn { background: none; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 10px; font-size: 0.75rem; color: var(--text-muted); cursor: pointer; transition: color 0.12s; }
    
    /* Input Form Area */
    .td-form-box { display: flex; flex-direction: column; gap: 8px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; }
    .td-input-area { width: 100%; height: 38px; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-color); font-size: 0.8125rem; outline: none; resize: none; font-family: var(--font-sans); line-height: 1.4; }
    .td-input-area:focus { border-color: var(--primary-color); }
    .td-row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
    .td-select { height: 32px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-color); font-size: 0.75rem; outline: none; }
    
    .td-run-btn { height: 32px; padding: 0 16px; border-radius: 6px; border: none; background: var(--primary-color); color: #fff; font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: opacity 0.12s; }
    .td-run-btn:disabled { opacity: 0.55; cursor: not-allowed; }

    /* Results Checklist */
    .td-results { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; min-height: 220px; }
    
    .td-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 10px; color: var(--text-muted); font-size: 0.75rem; text-align: center; padding: 32px; }
    .td-placeholder svg { opacity: 0.4; }

    /* Step Item Row */
    .td-step-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-input); transition: opacity 0.2s; }
    .td-step-row.done { opacity: 0.5; }
    .td-step-row.done .td-step-input { text-decoration: line-through; color: var(--text-muted); }
    .td-checkbox { accent-color: var(--primary-color); width: 15px; height: 15px; cursor: pointer; }
    .td-step-input { flex: 1; background: none; border: none; color: var(--text-color); font-size: 0.8125rem; font-family: var(--font-sans); outline: none; }
    .td-time-badge { font-size: 0.6875rem; color: var(--primary-color); background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 20px; padding: 2px 8px; outline: none; }
    .td-delete-btn { background: none; border: none; color: var(--text-muted); font-size: 1.125rem; cursor: pointer; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 4px; }
    .td-delete-btn:hover { color: #ef4444; }

    /* Bottom Summary & Actions Bar */
    .td-summary-bar { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-radius: 8px; background: var(--bg-input); border: 1px solid var(--border-color); font-size: 0.75rem; color: var(--text-muted); }
    .td-actions { display: flex; gap: 6px; }
    .td-action-btn { background: none; border: 1px solid var(--border-color); border-radius: 4px; padding: 3px 8px; font-size: 0.6875rem; color: var(--text-muted); cursor: pointer; transition: all 0.12s; }
    .td-action-btn:hover { color: var(--primary-color); border-color: var(--primary-color); }
    
    .td-spinner { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 12px; color: var(--text-muted); font-size: 0.8125rem; }
    .td-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--primary-color); animation: badge-pulse 1.2s infinite ease-in-out; }
    .td-error { display: flex; align-items: center; justify-content: center; height: 100%; color: #ef4444; font-size: 0.75rem; text-align: center; padding: 24px; line-height: 1.5; }
</style>

<div class="td-wrap">
    <!-- Header -->
    <div class="td-header">
        <div class="td-title">
            <span style="color: var(--primary-color); display: flex;">${TOOL_ICON}</span>
            <h4>Magic Todo</h4>
        </div>
        <button class="td-back-btn" id="tdBackBtn">← Back</button>
    </div>

    <!-- Input Box -->
    <div class="td-form-box">
        <input type="text" id="tdTaskInput" class="td-input-area" placeholder="Enter task, e.g. 'Build a React landing page' or 'Cook lasagna'..." autocomplete="off">
        <div class="td-row" style="margin-top: 6px;">
            <select id="tdDetailsSelect" class="td-select">
                <option value="0">Low</option>
                <option value="1" selected>Mid</option>
                <option value="2">High</option>
            </select>
            <button class="td-run-btn" id="tdRunBtn">✨ Break it down</button>
        </div>
    </div>

    <!-- Results Checklist -->
    <div class="td-results" id="tdResults">
        <div class="td-placeholder">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            <span>Type a goal above and click <b>Break it down</b> to generate a structured timed checklist.</span>
        </div>
    </div>
</div>
`;

            container.querySelector('#tdBackBtn').addEventListener('click', onBack);

            const taskInput = container.querySelector('#tdTaskInput');
            const detailsSelect = container.querySelector('#tdDetailsSelect');
            const runBtn = container.querySelector('#tdRunBtn');
            const resultsDiv = container.querySelector('#tdResults');

            async function generateTodoList() {
                const task = taskInput.value.trim();
                if (!task) { taskInput.focus(); return; }

                runBtn.disabled = true;
                runBtn.textContent = '⏳ Thinking…';

                resultsDiv.innerHTML = `
                    <div class="td-spinner">
                        <div class="td-dot"></div>
                        <span>AI is breaking down your task...</span>
                    </div>`;

                try {
                    const spiceIdx = parseInt(detailsSelect.value);
                    const spice = DETAILS_LEVELS[spiceIdx];

                    // Formulate structured output prompt
                    const prompt = `You are a professional task planner. Break down the following task into sequential, clear steps.
Task: "${task}"
Detail requirement: ${spice.desc}

Rules:
- Make each step concrete and actionable.
- Provide a realistic time duration for each step (e.g. 10 min, 1 hr).
- Provide a single emoji that fits the action.`;

                    // Fetch API key credentials from database
                    const apiConfig = await window.dbStore.get('apiConfig');
                    const mode = await window.dbStore.get('executionMode') || 'cloud';
                    
                    let key = '', provider = 'local', model = '';
                    if (mode === 'cloud' && apiConfig) {
                        key = apiConfig.key || '';
                        provider = apiConfig.provider || 'gemini';
                        model = apiConfig.model || (provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash');
                    }

                    // Run the fetch call using Structured Output schema
                    const parsedSteps = await callStructuredAI(prompt, provider, key, model);
                    
                    steps = parsedSteps.map((s, index) => ({
                        id: `step_${Date.now()}_${index}`,
                        step: s.step,
                        time: s.time,
                        emoji: s.emoji || '✅',
                        done: false
                    }));

                    renderSteps();
                } catch (err) {
                    console.error('[MagicTodo] Planning error:', err);
                    resultsDiv.innerHTML = `<div class="td-error">⚠️ ${err.message}</div>`;
                } finally {
                    runBtn.disabled = false;
                    runBtn.textContent = '✨ Break it down';
                }
            }

            function renderSteps() {
                if (steps.length === 0) {
                    resultsDiv.innerHTML = `
                        <div class="td-placeholder">
                            <span>Checklist is empty. Add a step or generate a new list.</span>
                        </div>
                    `;
                    return;
                }

                const totalMs = estimateTotalMinutes(steps);
                const timeStr = totalMs < 60
                    ? `~${totalMs} min`
                    : `~${(totalMs / 60).toFixed(1).replace('.0', '')} hr`;

                let html = `
                    <div class="td-summary-bar">
                        <span><b>${steps.length}</b> tasks · <b>${timeStr}</b> total estimated</span>
                        <div class="td-actions">
                            <button class="td-action-btn" id="tdAddTaskBtn">➕ Add Step</button>
                            <button class="td-action-btn" id="tdCopyBtn">📋 Copy List</button>
                            <button class="td-action-btn" id="tdClearBtn">🗑️ Clear All</button>
                        </div>
                    </div>
                    <div class="td-checklist-container" style="display:flex; flex-direction:column; gap:8px;">
                `;

                steps.forEach((s, idx) => {
                    html += `
                        <div class="td-step-row${s.done ? ' done' : ''}" data-id="${s.id}">
                            <input type="checkbox" class="td-checkbox" ${s.done ? 'checked' : ''}>
                            <span style="font-size: 1.125rem; line-height: 1; user-select: none;">${s.emoji}</span>
                            <input type="text" class="td-step-input" value="${s.step}" placeholder="Enter task description...">
                            <input type="text" class="td-time-badge" value="${s.time}" placeholder="Duration" style="width: 70px; text-align: center;">
                            <button class="td-delete-btn" title="Delete Task">×</button>
                        </div>
                    `;
                });

                html += `</div>`;
                resultsDiv.innerHTML = html;

                // Bind Checklist events
                const listContainer = resultsDiv.querySelector('.td-checklist-container');
                
                // Toggle Checkbox
                listContainer.querySelectorAll('.td-checkbox').forEach(cb => {
                    cb.addEventListener('change', (e) => {
                        const row = e.target.closest('.td-step-row');
                        const id = row.dataset.id;
                        const stepItem = steps.find(s => s.id === id);
                        if (stepItem) {
                            stepItem.done = cb.checked;
                            row.classList.toggle('done', cb.checked);
                        }
                    });
                });

                // Edit Task text
                listContainer.querySelectorAll('.td-step-input').forEach(input => {
                    input.addEventListener('change', (e) => {
                        const id = e.target.closest('.td-step-row').dataset.id;
                        const stepItem = steps.find(s => s.id === id);
                        if (stepItem) {
                            stepItem.step = input.value.trim();
                        }
                    });
                });

                // Edit Time badge
                listContainer.querySelectorAll('.td-time-badge').forEach(input => {
                    input.addEventListener('change', (e) => {
                        const id = e.target.closest('.td-step-row').dataset.id;
                        const stepItem = steps.find(s => s.id === id);
                        if (stepItem) {
                            stepItem.time = input.value.trim();
                            // Re-estimate total time after edits
                            renderSteps();
                        }
                    });
                });

                // Delete Task
                listContainer.querySelectorAll('.td-delete-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const id = e.target.closest('.td-step-row').dataset.id;
                        steps = steps.filter(s => s.id !== id);
                        renderSteps();
                    });
                });

                // Add Blank Step
                resultsDiv.querySelector('#tdAddTaskBtn').addEventListener('click', () => {
                    steps.push({
                        id: `step_${Date.now()}_manual`,
                        step: '',
                        time: '10 min',
                        emoji: '✅',
                        done: false
                    });
                    renderSteps();
                });

                // Copy to Clipboard
                resultsDiv.querySelector('#tdCopyBtn').addEventListener('click', async () => {
                    const text = [`📝 Task Breakdown:\n`]
                        .concat(steps.map((s, i) => `${i + 1}. ${s.done ? '[x]' : '[ ]'} ${s.emoji} ${s.step} [${s.time}]`))
                        .join('\n');
                    try {
                        await navigator.clipboard.writeText(text);
                        const btn = resultsDiv.querySelector('#tdCopyBtn');
                        btn.textContent = '✅ Copied!';
                        setTimeout(() => { btn.textContent = '📋 Copy List'; }, 1500);
                    } catch (_) {}
                });

                // Wipes checklist
                resultsDiv.querySelector('#tdClearBtn').addEventListener('click', () => {
                    steps = [];
                    renderSteps();
                });
            }

            runBtn.addEventListener('click', generateTodoList);
            taskInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') generateTodoList();
            });
        }
    };

    window.NeuroSparkTools.push(toolDefinition);
    console.log('[Tools] Loaded tool: ' + toolDefinition.name);
})();
