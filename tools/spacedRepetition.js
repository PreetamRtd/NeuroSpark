/**
 * NeuroSpark Tool: Spaced Repetition (Voice & Multimodal FSRS Engine)
 * Integrates vector chunks, local-first RAG search queries, Web Speech dictation,
 * image uploads, and post-session AI-driven grading using Structured Outputs.
 */
(function () {
    if (!window.NeuroSparkTools) window.NeuroSparkTools = [];

    const TOOL_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M12 6v6l4 2"/></svg>`;

    // --- FSRS Scheduling Engine ---
    function initFSRSCard(chunkId, deckId) {
        return {
            chunkId: chunkId,
            deckId: deckId,
            state: 0, // 0: New, 1: Learning, 2: Review
            difficulty: 5.0, // 1 to 10
            stability: 2.0,  // Days
            due: Date.now(),
            lastReview: null,
            replays: 0
        };
    }

    function scheduleFSRS(card, rating) {
        // rating: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
        const now = Date.now();
        const nextCard = { ...card };
        nextCard.replays = (card.replays || 0) + 1;

        if (card.state === 0) {
            nextCard.lastReview = now;
            if (rating === 1) { // Again
                nextCard.state = 1;
                nextCard.stability = 0.1;
                nextCard.difficulty = 8.0;
                nextCard.due = now + 5 * 60 * 1000; // 5 mins
            } else if (rating === 2) { // Hard
                nextCard.state = 1;
                nextCard.stability = 0.5;
                nextCard.difficulty = 6.0;
                nextCard.due = now + 12 * 60 * 60 * 1000; // 12 hours
            } else if (rating === 3) { // Good
                nextCard.state = 2;
                nextCard.stability = 2.0;
                nextCard.difficulty = 4.5;
                nextCard.due = now + 2 * 24 * 60 * 60 * 1000; // 2 days
            } else { // Easy
                nextCard.state = 2;
                nextCard.stability = 6.0;
                nextCard.difficulty = 2.0;
                nextCard.due = now + 6 * 24 * 60 * 60 * 1000; // 6 days
            }
        } else {
            const elapsedDays = Math.max(1, (now - (card.lastReview || now)) / (24 * 60 * 60 * 1000));
            nextCard.lastReview = now;

            if (rating === 1) { // Again
                nextCard.state = 1; // Relearning
                nextCard.stability = Math.max(0.1, card.stability * 0.2);
                nextCard.difficulty = Math.min(10.0, card.difficulty + 2.0);
                nextCard.due = now + 10 * 60 * 1000; // 10 mins
            } else {
                nextCard.state = 2; // Review
                let factor = 1.0;
                if (rating === 2) { // Hard
                    factor = 1.2;
                    nextCard.difficulty = Math.min(10.0, card.difficulty + 1.0);
                } else if (rating === 3) { // Good
                    factor = 2.4;
                    nextCard.difficulty = card.difficulty + (4.5 - card.difficulty) * 0.05;
                } else if (rating === 4) { // Easy
                    factor = 4.5;
                    nextCard.difficulty = Math.max(1.0, card.difficulty - 1.0);
                }
                nextCard.stability = card.stability * factor;
                const nextDays = Math.round(nextCard.stability);
                nextCard.due = now + nextDays * 24 * 60 * 60 * 1000;
            }
        }
        return nextCard;
    }

    // Cosine similarity for RAG search focus selection
    function cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
        let dotProduct = 0.0, normA = 0.0, normB = 0.0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    // --- LLM Structured Output Fetch helper ---
    async function fetchStructuredFlashcards(chunks, modelName, apiKey, provider, newLimit, reviewLimit) {
        const prompt = `Read the following document text segments and generate study flashcards.
The user's session limits are set to: up to ${newLimit} New cards and ${reviewLimit} Review cards.
For each segment provided in the array, generate exactly one flashcard containing a front-side question/concept and a back-side explanation/answer.
Return matching IDs for each generated flashcard matching the original chunk ID provided in the inputs.

Input Segments:
${JSON.stringify(chunks.map(c => ({ id: c.id, text: c.text, type: c.studyType || 'new' })))}

Guidelines:
- If type is 'new', generate a question introducing the core concept, basic term, or definition of the segment.
- If type is 'review', generate a question testing a specific detail, practical application, or potential misconception from the segment to challenge their recall.
- Create clear, thought-provoking questions on the Front.
- Provide comprehensive, accurate, and easy-to-understand explanations on the Back.
- Keep the language natural and clear.`;

        if (provider === 'gemini') {
            const formattedModel = modelName.includes('/') ? modelName : `models/${modelName}`;
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${formattedModel}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.3,
                        responseMimeType: "application/json",
                        responseSchema: {
                            type: "OBJECT",
                            properties: {
                                flashcards: {
                                    type: "ARRAY",
                                    description: "List of generated flashcards.",
                                    items: {
                                        type: "OBJECT",
                                        properties: {
                                            id: { type: "STRING" },
                                            front: { type: "STRING" },
                                            back: { type: "STRING" }
                                        },
                                        required: ["id", "front", "back"]
                                    }
                                }
                            },
                            required: ["flashcards"]
                        }
                    }
                })
            });

            if (!res.ok) throw new Error(`Gemini API returned status ${res.status}`);
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('Empty response from Gemini');
            return JSON.parse(text).flashcards;
        }

        if (provider === 'openai') {
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: modelName,
                    messages: [{ role: 'user', content: prompt }],
                    response_format: {
                        type: "json_schema",
                        json_schema: {
                            name: "flashcards_schema",
                            strict: true,
                            schema: {
                                type: "object",
                                properties: {
                                    flashcards: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            properties: {
                                                id: { type: "string" },
                                                front: { type: "string" },
                                                back: { type: "string" }
                                            },
                                            required: ["id", "front", "back"],
                                            additionalProperties: false
                                        }
                                    }
                                },
                                required: ["flashcards"],
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
            return JSON.parse(text).flashcards;
        }

        // Fallback for Anthropic or Local models
        const instructionPrompt = prompt + `\n\nReturn ONLY a valid JSON object matching this schema. Do not output markdown fences or code blocks:
{
  "flashcards": [
    {
      "id": "string",
      "front": "string",
      "back": "string"
    }
  ]
}`;

        let rawResponse = '';
        if (provider === 'anthropic') {
            const res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: modelName,
                    max_tokens: 2048,
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
            return JSON.parse(jsonText).flashcards;
        } catch (e) {
            console.warn('[SpacedRepetition] Structured JSON parse failed. Extracting values via heuristic regex...', e);
            const cards = [];
            chunks.forEach((chunk, i) => {
                cards.push({
                    id: chunk.id,
                    front: `Review segment ${i + 1}: Check key concepts inside this topic.`,
                    back: chunk.text.slice(0, 150) + '...'
                });
            });
            return cards;
        }
    }

    // --- LLM Evaluation Fetch helper ---
    async function evaluateAnswersWithAI(sessionCards, chunks, modelName, apiKey, provider) {
        // Construct detailed prompt matching Reference Chunks, Questions and User Answers
        let prompt = `You are a strict study supervisor. Grade the user's answers against the reference materials.
For each card, analyze the user's answer (and any attached image description) against the reference material, and decide on the rating and constructive feedback.

Reference Materials:
${chunks.map((c, idx) => `[Material ID: ${c.id}]: ${c.text}`).join('\n\n')}

User Answers to evaluate:
`;

        sessionCards.forEach((card, idx) => {
            prompt += `
Card ID: ${card.id}
Question: ${card.front}
Reference Answer: ${card.back}
User typed Answer: ${card.userAnswer || '(No text answer provided)'}
${card.userImage ? `[Multimodal image input attached for this card]` : ''}
`;
        });

        prompt += `
FSRS rating options:
1 = Again (answer was completely incorrect, blank, or irrelevant)
2 = Hard (answer was partially correct, but missed major details or had mistakes)
3 = Good (answer was correct, covering the core explanation well)
4 = Easy (answer was completely correct, precise, and demonstrated deep understanding)

You must return a JSON object containing an "evaluations" array matching the requested schema.`;

        // 1. Google Gemini Multimodal Structured API
        if (provider === 'gemini') {
            const formattedModel = modelName.includes('/') ? modelName : `models/${modelName}`;
            const parts = [];

            // Add images if present
            sessionCards.forEach((card, idx) => {
                if (card.userImage) {
                    parts.push({
                        inlineData: {
                            mimeType: card.userImage.mimeType,
                            data: card.userImage.base64
                        }
                    });
                    prompt += `\n[Reference Image attached above for Card ID: ${card.id}]`;
                }
            });

            parts.push({ text: prompt });

            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${formattedModel}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: parts }],
                    generationConfig: {
                        temperature: 0.2,
                        responseMimeType: "application/json",
                        responseSchema: {
                            type: "OBJECT",
                            properties: {
                                evaluations: {
                                    type: "ARRAY",
                                    description: "List of evaluations for each card.",
                                    items: {
                                        type: "OBJECT",
                                        properties: {
                                            id: { type: "STRING", description: "The exact Card ID." },
                                            rating: { type: "INTEGER", description: "The FSRS rating (1 to 4)." },
                                            feedback: { type: "STRING", description: "Constructive feedback explaining the grade." }
                                        },
                                        required: ["id", "rating", "feedback"]
                                    }
                                }
                            },
                            required: ["evaluations"]
                        }
                    }
                })
            });

            if (!res.ok) throw new Error(`Gemini evaluation failed: ${res.status}`);
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('Empty evaluation from Gemini');
            return JSON.parse(text).evaluations;
        }

        // 2. OpenAI Multimodal Structured API
        if (provider === 'openai') {
            const content = [{ type: "text", text: prompt }];

            // Add images if present
            sessionCards.forEach(card => {
                if (card.userImage) {
                    content.push({
                        type: "image_url",
                        image_url: {
                            url: `data:${card.userImage.mimeType};base64,${card.userImage.base64}`
                        }
                    });
                }
            });

            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: modelName,
                    messages: [{ role: 'user', content: content }],
                    response_format: {
                        type: "json_schema",
                        json_schema: {
                            name: "evaluation_schema",
                            strict: true,
                            schema: {
                                type: "object",
                                properties: {
                                    evaluations: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            properties: {
                                                id: { type: "string" },
                                                rating: { type: "integer" },
                                                feedback: { type: "string" }
                                            },
                                            required: ["id", "rating", "feedback"],
                                            additionalProperties: false
                                        }
                                    }
                                },
                                required: ["evaluations"],
                                additionalProperties: false
                            }
                        }
                    }
                })
            });

            if (!res.ok) throw new Error(`OpenAI evaluation failed: ${res.status}`);
            const data = await res.json();
            const text = data.choices?.[0]?.message?.content;
            if (!text) throw new Error('Empty evaluation from OpenAI');
            return JSON.parse(text).evaluations;
        }

        // Fallback or Local
        const localEvaluations = sessionCards.map(card => {
            const hasAns = (card.userAnswer || '').trim().length > 10;
            return {
                id: card.id,
                rating: hasAns ? 3 : 1,
                feedback: hasAns 
                  ? "Local fallback auto-grading: answer submitted and saved successfully." 
                  : "Local fallback auto-grading: answer was blank or too short. Marked as Again."
            };
        });
        return localEvaluations;
    }

    // --- Tool Definition ---
    const toolDefinition = {
        id: 'spaced-repetition',
        name: 'Spaced Repetition',
        description: 'Study concepts using FSRS scheduling algorithms and AI-driven automated quiz grading.',
        icon: TOOL_ICON,

        render(container, deck, onBack) {
            container.innerHTML = `
<style>
    .sr-wrap { display: flex; flex-direction: column; gap: 16px; height: 100%; width: 100%; font-family: var(--font-sans); }
    .sr-header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 12px; }
    .sr-title { display: flex; align-items: center; gap: 8px; }
    .sr-title h4 { font-size: 0.875rem; font-weight: 600; color: var(--text-color); margin: 0; }
    .sr-back-btn { background: none; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 10px; font-size: 0.75rem; color: var(--text-muted); cursor: pointer; transition: color 0.12s; }
    .sr-panel { display: flex; flex-direction: column; gap: 14px; flex: 1; min-height: 0; }
    .sr-panel.hidden { display: none; }
    
    /* Stats Grid */
    .sr-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px; }
    .sr-stat-card { background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px; text-align: center; }
    .sr-stat-num { font-size: 1.125rem; font-weight: 700; color: var(--text-color); margin-bottom: 4px; }
    .sr-stat-label { font-size: 0.6875rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .sr-stat-label.new { color: #3b82f6; }
    .sr-stat-label.learning { color: #f59e0b; }
    .sr-stat-label.due { color: #ef4444; }

    /* Inputs */
    .sr-field-group { display: flex; flex-direction: column; gap: 6px; }
    .sr-field-group label { font-size: 0.75rem; font-weight: 500; color: var(--text-label); }
    .sr-inputs-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .sr-input-val { height: 36px; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-input); color: var(--text-color); font-size: 0.8125rem; outline: none; }
    .sr-search-focus { width: 100%; height: 36px; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-input); color: var(--text-color); font-size: 0.8125rem; outline: none; }
    .sr-start-btn { height: 38px; border-radius: 6px; border: none; background: var(--primary-color); color: #fff; font-size: 0.8125rem; font-weight: 600; cursor: pointer; transition: opacity 0.15s; margin-top: 8px; }
    .sr-start-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Quiz Panel elements */
    .sr-q-box { border: 1px solid var(--border-color); border-radius: 12px; background: var(--bg-input); padding: 18px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .sr-q-title { font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
    .sr-q-text { font-size: 0.9375rem; color: var(--text-color); line-height: 1.5; font-weight: 500; }
    
    .sr-ans-wrapper { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
    .sr-ans-area-box { position: relative; width: 100%; }
    .sr-ans-area { width: 100%; height: 96px; padding: 10px 42px 10px 12px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-input); color: var(--text-color); font-size: 0.8125rem; font-family: var(--font-sans); resize: none; outline: none; line-height: 1.45; }
    .sr-ans-area:focus { border-color: var(--primary-color); }
    
    /* Mic and Image buttons */
    .sr-mic-btn { position: absolute; right: 10px; top: 10px; background: none; border: none; font-size: 1.125rem; cursor: pointer; color: var(--text-muted); transition: color 0.15s; z-index: 10; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; }
    .sr-mic-btn:hover { color: #ef4444; }
    
    .sr-actions-row { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
    .sr-icon-action-btn { display: flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-input); color: var(--text-muted); font-size: 0.75rem; cursor: pointer; font-weight: 500; }
    .sr-icon-action-btn:hover { color: var(--text-color); border-color: var(--text-muted); }
    
    /* Image Preview */
    .sr-previews-container { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .sr-img-preview { position: relative; width: 60px; height: 60px; border-radius: 6px; overflow: hidden; border: 1px solid var(--border-color); }
    .sr-img-preview img { width: 100%; height: 100%; object-fit: cover; }
    .sr-img-delete { position: absolute; top: 2px; right: 2px; background: rgba(0,0,0,0.6); color: #fff; border: none; border-radius: 50%; width: 16px; height: 16px; font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; }

    /* Progress & Loader */
    .sr-progress-container { width: 100%; }
    .sr-progress-header { display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 4px; }
    .sr-progress-bg { height: 6px; border-radius: 3px; background: var(--border-color); overflow: hidden; }
    .sr-progress-bar { height: 100%; background: var(--primary-color); width: 0%; transition: width 0.3s; }
    
    .sr-spinner-box { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 220px; color: var(--text-muted); font-size: 0.8125rem; text-align: center; }
    .sr-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--primary-color); animation: badge-pulse 1.2s infinite ease-in-out; }
    
    /* Speech mic pulse animation */
    @keyframes mic-pulse {
        0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
        70% { transform: scale(1.1); box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
        100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
    }
    .mic-pulsing { animation: mic-pulse 1.4s infinite; background: rgba(239, 68, 68, 0.1); }

    /* Results List */
    .sr-results-list { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; max-height: 380px; padding-right: 4px; }
    .sr-result-item { background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
    .sr-result-header { display: flex; align-items: center; justify-content: space-between; font-size: 0.75rem; border-bottom: 1px solid var(--border-color); padding-bottom: 6px; }
    .sr-result-badge { padding: 2px 8px; border-radius: 20px; font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; color: #fff; }
    .sr-result-badge.again { background: #ef4444; }
    .sr-result-badge.hard { background: #f97316; }
    .sr-result-badge.good { background: #10b981; }
    .sr-result-badge.easy { background: #3b82f6; }
    .sr-result-q { font-size: 0.8125rem; font-weight: 600; color: var(--text-color); }
    .sr-result-ans { font-size: 0.75rem; color: var(--text-muted); line-height: 1.4; }
    .sr-result-fb { font-size: 0.75rem; color: var(--primary-color); font-weight: 500; background: rgba(99, 102, 241, 0.08); padding: 8px 10px; border-radius: 6px; border-left: 2px solid var(--primary-color); }
</style>

<div class="sr-wrap">
    <!-- Header -->
    <div class="sr-header">
        <div class="sr-title">
            <span style="color: var(--primary-color); display: flex;">${TOOL_ICON}</span>
            <h4>Spaced Repetition</h4>
        </div>
        <button class="sr-back-btn" id="srBackBtn">← Back</button>
    </div>

    <!-- 1. Setup View -->
    <div class="sr-panel" id="srSetupView">
        <div class="sr-stats-grid">
            <div class="sr-stat-card"><div class="sr-stat-num" id="statTotal">0</div><div class="sr-stat-label">Total</div></div>
            <div class="sr-stat-card"><div class="sr-stat-num" id="statNew">0</div><div class="sr-stat-label new">New</div></div>
            <div class="sr-stat-card"><div class="sr-stat-num" id="statLearning">0</div><div class="sr-stat-label learning">Learn</div></div>
            <div class="sr-stat-card"><div class="sr-stat-num" id="statDue">0</div><div class="sr-stat-label due">Due</div></div>
        </div>

        <div class="sr-inputs-row">
            <div class="sr-field-group">
                <label for="srNewLimit">New Card Limit</label>
                <input type="number" id="srNewLimit" class="sr-input-val" value="5" min="0">
            </div>
            <div class="sr-field-group">
                <label for="srReviewLimit">Review Card Limit</label>
                <input type="number" id="srReviewLimit" class="sr-input-val" value="10" min="0">
            </div>
        </div>

        <div class="sr-field-group">
            <label for="srRagFocus">Custom Study Focus (RAG search, e.g. "Arrays", "Closures")</label>
            <input type="text" id="srRagFocus" class="sr-search-focus" placeholder="Leave empty to study due cards..." autocomplete="off">
        </div>

        <button class="sr-start-btn" id="srStartBtn">🚀 Start Study Session</button>
    </div>

    <!-- 2. Loading View -->
    <div class="sr-panel hidden" id="srLoadingView">
        <div class="sr-spinner-box">
            <div class="sr-dot"></div>
            <span id="srLoadingText">Preparing your study session...</span>
        </div>
    </div>

    <!-- 3. Study Session View -->
    <div class="sr-panel hidden" id="srSessionView">
        <div class="sr-progress-container">
            <div class="sr-progress-header">
                <span id="srCardProgress">Card 0 of 0</span>
                <span id="srCardType" style="font-weight:600;">New</span>
            </div>
            <div class="sr-progress-bg">
                <div class="sr-progress-bar" id="srProgressBar"></div>
            </div>
        </div>

        <!-- Question Box -->
        <div class="sr-q-box">
            <div class="sr-q-title" id="srQTitle">Question 1</div>
            <div class="sr-q-text" id="srQText">...</div>
        </div>

        <!-- Answer Box with inputs -->
        <div class="sr-ans-wrapper">
            <div class="sr-ans-area-box">
                <textarea class="sr-ans-area" id="srUserAnsText" placeholder="Write or record your answer here..." spellcheck="false"></textarea>
                <button class="sr-mic-btn" id="srMicBtn" title="Speak Answer">🎙️</button>
            </div>
            
            <div class="sr-actions-row">
                <input type="file" id="srImageFileInput" accept="image/*" style="display: none;">
                <button class="sr-icon-action-btn" id="srAddImageBtn">📷 Upload Image (Math/Diagrams)</button>
                <button class="sr-start-btn" id="srNextBtn" style="margin:0; margin-left:auto; height:32px; padding:0 20px;">Submit & Next</button>
            </div>

            <!-- Image Upload Preview Area -->
            <div class="sr-previews-container" id="srPreviewsContainer"></div>
        </div>
    </div>

    <!-- 4. Done/Summary View -->
    <div class="sr-panel hidden" id="srDoneView">
        <div style="display:flex; flex-direction:column; gap:12px;">
            <h4 style="margin: 0; color: var(--text-color); font-size: 0.9375rem; font-weight: 600;">AI Evaluation Results</h4>
            <div class="sr-results-list" id="srResultsList"></div>
            <button class="sr-start-btn" id="srDoneHomeBtn" style="padding: 0 20px;">Done & Save Progress</button>
        </div>
    </div>
</div>
`;

            const backBtn = container.querySelector('#srBackBtn');
            backBtn.addEventListener('click', onBack);

            // View elements
            const viewSetup = container.querySelector('#srSetupView');
            const viewLoading = container.querySelector('#srLoadingView');
            const viewSession = container.querySelector('#srSessionView');
            const viewDone = container.querySelector('#srDoneView');
            const loadingText = container.querySelector('#srLoadingText');

            // Form inputs
            const startBtn = container.querySelector('#srStartBtn');
            const newLimitInput = container.querySelector('#srNewLimit');
            const reviewLimitInput = container.querySelector('#srReviewLimit');
            const ragFocusInput = container.querySelector('#srRagFocus');

            // Session inputs
            const qTitle = container.querySelector('#srQTitle');
            const qText = container.querySelector('#srQText');
            const userAnswerText = container.querySelector('#srUserAnsText');
            const micBtn = container.querySelector('#srMicBtn');
            const imageFileInput = container.querySelector('#srImageFileInput');
            const addImageBtn = container.querySelector('#srAddImageBtn');
            const nextBtn = container.querySelector('#srNextBtn');
            const previewsContainer = container.querySelector('#srPreviewsContainer');
            const cardProgress = container.querySelector('#srCardProgress');
            const cardType = container.querySelector('#srCardType');
            const progressBar = container.querySelector('#srProgressBar');

            // Results elements
            const resultsList = container.querySelector('#srResultsList');
            const doneHomeBtn = container.querySelector('#srDoneHomeBtn');

            // Speech & Multimodal state variables
            let sessionCards = [];
            let currentCardIdx = 0;
            let currentBase64Image = null;
            let selectedChunksList = [];

            // --- Voice Recording Logic (Web Speech API) ---
            let recognition = null;
            let isListening = false;

            function initVoiceRecognition() {
                const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
                if (!SpeechRecognition) {
                    micBtn.style.display = 'none';
                    return;
                }

                recognition = new SpeechRecognition();
                recognition.continuous = true;
                recognition.interimResults = false;
                recognition.lang = 'en-US';

                recognition.onstart = () => {
                    isListening = true;
                    micBtn.textContent = '🛑';
                    micBtn.style.color = '#ef4444';
                    micBtn.classList.add('mic-pulsing');
                };

                recognition.onend = () => {
                    isListening = false;
                    micBtn.textContent = '🎙️';
                    micBtn.style.color = 'var(--text-muted)';
                    micBtn.classList.remove('mic-pulsing');
                };

                recognition.onresult = (event) => {
                    const transcript = event.results[event.results.length - 1][0].transcript;
                    userAnswerText.value += (userAnswerText.value ? ' ' : '') + transcript;
                };

                micBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (isListening) {
                        recognition.stop();
                    } else {
                        recognition.start();
                    }
                });
            }

            initVoiceRecognition();

            // --- Image Upload Logic ---
            addImageBtn.addEventListener('click', () => {
                imageFileInput.click();
            });

            imageFileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = (event) => {
                    const base64Data = event.target.result.split(',')[1];
                    currentBase64Image = {
                        mimeType: file.type,
                        base64: base64Data
                    };

                    // Draw image preview in UI
                    previewsContainer.innerHTML = `
                        <div class="sr-img-preview">
                            <img src="${event.target.result}" alt="Preview">
                            <button class="sr-img-delete" id="srDeleteImgBtn">×</button>
                        </div>
                    `;

                    previewsContainer.querySelector('#srDeleteImgBtn').addEventListener('click', () => {
                        currentBase64Image = null;
                        previewsContainer.innerHTML = '';
                        imageFileInput.value = '';
                    });
                };
                reader.readAsDataURL(file);
            });

            // Load counts and stats
            async function loadStats() {
                try {
                    if (!window.dbStore || !window.dbStore.db) return;
                    
                    const chunks = await window.dbStore.db.chunks.where('deckId').equals(deck.id).toArray();
                    const reviews = await window.dbStore.db.fsrsReviews.where('deckId').equals(deck.id).toArray();
                    
                    const reviewMap = {};
                    reviews.forEach(r => {
                        reviewMap[r.chunkId] = r;
                    });

                    let newCount = 0;
                    let learningCount = 0;
                    let dueCount = 0;
                    const now = Date.now();

                    chunks.forEach(chunk => {
                        const rev = reviewMap[chunk.id];
                        if (!rev) {
                            newCount++;
                        } else if (rev.state === 1) {
                            learningCount++;
                            if (rev.due <= now) dueCount++;
                        } else if (rev.state === 2) {
                            if (rev.due <= now) dueCount++;
                        }
                    });

                    container.querySelector('#statTotal').textContent = chunks.length;
                    container.querySelector('#statNew').textContent = newCount;
                    container.querySelector('#statLearning').textContent = learningCount;
                    container.querySelector('#statDue').textContent = dueCount;

                    if (chunks.length === 0) {
                        startBtn.disabled = true;
                        startBtn.textContent = 'Upload sources first';
                    } else {
                        startBtn.disabled = false;
                        startBtn.textContent = '🚀 Start Study Session';
                    }
                } catch (e) {
                    console.error('[SpacedRepetition] Failed to load statistics:', e);
                }
            }

            loadStats();

            // Handle start session click
            startBtn.addEventListener('click', async () => {
                const newLimit = parseInt(newLimitInput.value) || 0;
                const reviewLimit = parseInt(reviewLimitInput.value) || 0;
                const focusTopic = ragFocusInput.value.trim();

                showView('loading');
                loadingText.textContent = focusTopic ? `Searching sources for "${focusTopic}"...` : 'Selecting cards...';

                try {
                    const chunks = await window.dbStore.db.chunks.where('deckId').equals(deck.id).toArray();
                    const reviews = await window.dbStore.db.fsrsReviews.where('deckId').equals(deck.id).toArray();
                    
                    if (chunks.length === 0) {
                        alert("Please upload some files into this Deck first.");
                        showView('setup');
                        return;
                    }

                    const reviewMap = {};
                    reviews.forEach(r => {
                        reviewMap[r.chunkId] = r;
                    });

                    selectedChunksList = [];

                    if (focusTopic) {
                        loadingText.textContent = 'Vectorizing study focus...';
                        const modelName = typeof window.getSelectedEmbeddingModel === 'function' 
                            ? await window.getSelectedEmbeddingModel() 
                            : 'Xenova/all-MiniLM-L6-v2';

                        if (typeof window.computeEmbedding !== 'function') {
                            throw new Error("Local embedding engine is not ready.");
                        }

                        const queryVector = await window.computeEmbedding(focusTopic, modelName);
                        
                        const scored = chunks.map(chunk => {
                            const score = cosineSimilarity(queryVector, chunk.embedding);
                            return { chunk, score };
                        });

                        scored.sort((a, b) => b.score - a.score);
                        const limitTotal = newLimit + reviewLimit;
                        selectedChunksList = scored.slice(0, limitTotal).map(s => {
                            const chunk = s.chunk;
                            const rev = reviewMap[chunk.id];
                            chunk.studyType = rev ? 'review' : 'new';
                            return chunk;
                        });
                    } else {
                        const dueChunks = [];
                        const newChunks = [];
                        const now = Date.now();

                        chunks.forEach(chunk => {
                            const rev = reviewMap[chunk.id];
                            if (!rev) {
                                newChunks.push(chunk);
                            } else if (rev.due <= now) {
                                dueChunks.push(chunk);
                            }
                        });

                        dueChunks.sort(() => 0.5 - Math.random());
                        newChunks.sort(() => 0.5 - Math.random());

                        const selectedDue = dueChunks.slice(0, reviewLimit).map(c => {
                            c.studyType = 'review';
                            return c;
                        });
                        const selectedNew = newChunks.slice(0, newLimit).map(c => {
                            c.studyType = 'new';
                            return c;
                        });

                        selectedChunksList = [...selectedDue, ...selectedNew];
                    }

                    if (selectedChunksList.length === 0) {
                        alert("No cards match your study settings and limits. Try increasing limits or clearing RAG topic.");
                        showView('setup');
                        return;
                    }

                    loadingText.textContent = `Generating ${selectedChunksList.length} questions using AI...`;
                    
                    const apiConfig = await window.dbStore.get('apiConfig');
                    const mode = await window.dbStore.get('executionMode') || 'cloud';
                    
                    let key = '', provider = 'local', model = '';
                    if (mode === 'cloud' && apiConfig) {
                        key = apiConfig.key || '';
                        provider = apiConfig.provider || 'gemini';
                        model = apiConfig.model || (provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash');
                    }

                    const generatedCards = await fetchStructuredFlashcards(selectedChunksList, model, key, provider, newLimit, reviewLimit);

                    if (!generatedCards || generatedCards.length === 0) {
                        throw new Error("AI failed to output valid flashcards schema.");
                    }

                    sessionCards = generatedCards.map(gc => {
                        const matchingChunk = selectedChunksList.find(sc => sc.id === gc.id) || selectedChunksList[0];
                        const reviewState = reviewMap[matchingChunk.id] || initFSRSCard(matchingChunk.id, deck.id);
                        return {
                            ...gc,
                            chunkId: matchingChunk.id,
                            reviewState: reviewState,
                            userAnswer: '',
                            userImage: null
                        };
                    });

                    currentCardIdx = 0;
                    renderCard();
                    showView('session');
                } catch (e) {
                    console.error('[SpacedRepetition] Session initialization error:', e);
                    alert(`Failed to start session: ${e.message}`);
                    showView('setup');
                }
            });

            // Card Rendering logic
            function renderCard() {
                if (currentCardIdx >= sessionCards.length) {
                    processGradingSession();
                    return;
                }

                const card = sessionCards[currentCardIdx];
                qTitle.textContent = `Question ${currentCardIdx + 1}`;
                qText.textContent = card.front;

                // Set type badge
                const state = card.reviewState.state;
                if (state === 0) {
                    cardType.textContent = 'New';
                    cardType.style.color = '#3b82f6';
                } else if (state === 1) {
                    cardType.textContent = 'Learning';
                    cardType.style.color = '#f59e0b';
                } else {
                    cardType.textContent = 'Review';
                    cardType.style.color = '#10b981';
                }

                // Reset inputs and previews
                userAnswerText.value = '';
                currentBase64Image = null;
                previewsContainer.innerHTML = '';
                imageFileInput.value = '';
                if (isListening && recognition) {
                    recognition.stop();
                }

                // Update Progress bar
                cardProgress.textContent = `Question ${currentCardIdx + 1} of ${sessionCards.length}`;
                const pct = ((currentCardIdx) / sessionCards.length) * 100;
                progressBar.style.width = `${pct}%`;
            }

            // Save input and proceed to next card
            nextBtn.addEventListener('click', () => {
                const textAns = userAnswerText.value.trim();
                const card = sessionCards[currentCardIdx];
                card.userAnswer = textAns;
                card.userImage = currentBase64Image;

                currentCardIdx++;
                renderCard();
            });

            // --- LLM AI grading processor ---
            async function processGradingSession() {
                showView('loading');
                loadingText.textContent = 'AI is evaluating your answers and grading your performance...';

                try {
                    const apiConfig = await window.dbStore.get('apiConfig');
                    const mode = await window.dbStore.get('executionMode') || 'cloud';
                    
                    let key = '', provider = 'local', model = '';
                    if (mode === 'cloud' && apiConfig) {
                        key = apiConfig.key || '';
                        provider = apiConfig.provider || 'gemini';
                        model = apiConfig.model || (provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash');
                    }

                    // Request structured evaluations from LLM
                    const evaluations = await evaluateAnswersWithAI(sessionCards, selectedChunksList, model, key, provider);

                    // Map evaluations back to FSRS Review updates
                    const results = [];
                    for (let i = 0; i < sessionCards.length; i++) {
                        const card = sessionCards[i];
                        const evalItem = evaluations.find(ev => ev.id === card.id) || {
                            rating: 3,
                            feedback: "Quiz answered and submitted successfully."
                        };

                        // 1. Calculate and update next FSRS spacing record
                        const updatedFSRS = scheduleFSRS(card.reviewState, evalItem.rating);
                        
                        // 2. Write straight to database
                        await window.dbStore.db.fsrsReviews.put(updatedFSRS);

                        // Save results display object
                        results.push({
                            question: card.front,
                            answer: card.userAnswer || '(No text answer provided)',
                            rating: evalItem.rating,
                            feedback: evalItem.feedback,
                            imageAttached: !!card.userImage
                        });
                    }

                    // Render Results List UI
                    renderResultsList(results);
                    showView('done');
                } catch (e) {
                    console.error('[SpacedRepetition] Grading session failed:', e);
                    alert(`AI Grading error: ${e.message}. Reverting to local grading...`);
                    
                    // Offline fallback: bulk save standard FSRS Good ratings
                    const results = [];
                    for (let i = 0; i < sessionCards.length; i++) {
                        const card = sessionCards[i];
                        const updatedFSRS = scheduleFSRS(card.reviewState, 3); // Default rating: Good
                        await window.dbStore.db.fsrsReviews.put(updatedFSRS);

                        results.push({
                            question: card.front,
                            answer: card.userAnswer || '(No text answer provided)',
                            rating: 3,
                            feedback: "Offline fallback grading: Card marked as Good and scheduling updated.",
                            imageAttached: !!card.userImage
                        });
                    }
                    renderResultsList(results);
                    showView('done');
                }
            }

            function renderResultsList(results) {
                resultsList.innerHTML = '';
                results.forEach((item, idx) => {
                    const cardDiv = document.createElement('div');
                    cardDiv.className = 'sr-result-item';

                    let badgeClass = 'good', badgeLabel = 'Good';
                    if (item.rating === 1) { badgeClass = 'again'; badgeLabel = 'Again'; }
                    else if (item.rating === 2) { badgeClass = 'hard'; badgeLabel = 'Hard'; }
                    else if (item.rating === 4) { badgeClass = 'easy'; badgeLabel = 'Easy'; }

                    cardDiv.innerHTML = `
                        <div class="sr-result-header">
                            <span style="font-weight:600; color:var(--text-muted);">Card #${idx + 1}</span>
                            <span class="sr-result-badge ${badgeClass}">${badgeLabel}</span>
                        </div>
                        <div class="sr-result-q">${item.question}</div>
                        <div class="sr-result-ans">
                            <b>Your Answer:</b> ${item.answer} 
                            ${item.imageAttached ? `<i>[Multimodal Image Attached]</i>` : ''}
                        </div>
                        <div class="sr-result-fb">
                            <b>AI Feedback:</b> ${item.feedback}
                        </div>
                    `;
                    resultsList.appendChild(cardDiv);
                });
            }

            doneHomeBtn.addEventListener('click', () => {
                showView('setup');
                loadStats();
            });

            // Helpers for view toggling
            function showView(viewName) {
                viewSetup.classList.toggle('hidden', viewName !== 'setup');
                viewLoading.classList.toggle('hidden', viewName !== 'loading');
                viewSession.classList.toggle('hidden', viewName !== 'session');
                viewDone.classList.toggle('hidden', viewName !== 'done');
            }
        }
    };

    window.NeuroSparkTools.push(toolDefinition);
    console.log('[Tools] Loaded tool: ' + toolDefinition.name);
})();
