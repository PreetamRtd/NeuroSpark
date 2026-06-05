/**
 * NeuroSpark Tool: RAG Semantic Search
 * Performs semantic search over vectorized documents in the current deck.
 */
(function() {
    if (!window.NeuroSparkTools) window.NeuroSparkTools = [];

    // Helper for cosine similarity
    function cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
        let dotProduct = 0.0;
        let normA = 0.0;
        let normB = 0.0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    const toolDefinition = {
        id: 'rag-search',
        name: 'Semantic RAG Search',
        description: 'Perform vector-based similarity search over document chunks offline.',
        icon: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><path d="M8 11h6"></path><path d="M11 8v6"></path></svg>`,
        
        render: (container, deck, onBack) => {
            // Render the tool interface
            container.innerHTML = `
                <div class="tool-view" style="display: flex; flex-direction: column; gap: 16px; width: 100%; height: 100%;">
                    <!-- Header -->
                    <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 12px;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="color: var(--primary-color); display: flex;">${toolDefinition.icon}</span>
                            <h4 style="font-size: 0.875rem; font-weight: 600; color: var(--text-color); margin: 0;">${toolDefinition.name}</h4>
                        </div>
                        <button type="button" id="closeToolBtn" style="background: none; border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 8px; font-size: 0.75rem; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; gap: 4px; transition: color 0.12s;">
                            <span>Back</span>
                        </button>
                    </div>

                    <!-- Search Input Row -->
                    <div style="display: flex; gap: 8px; width: 100%;">
                        <input type="text" id="ragSearchQuery" placeholder="Ask something about your sources..." style="flex: 1; height: 36px; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-color); background-color: var(--bg-input); color: var(--text-color); font-size: 0.8125rem; outline: none;" autocomplete="off">
                        <button type="button" id="ragSearchBtn" style="height: 36px; padding: 0 16px; border-radius: 6px; border: none; background-color: var(--primary-color); color: #ffffff; font-size: 0.8125rem; font-weight: 500; cursor: pointer; transition: background-color 0.12s;">
                            Search
                        </button>
                    </div>

                    <!-- Results Area -->
                    <div id="ragSearchResults" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; min-height: 280px;">
                        <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); font-size: 0.75rem; text-align: center; padding: 32px;">
                            Enter a query to semantic search your vectorized source documents.
                        </div>
                    </div>
                </div>
            `;

            // Bind Back Button
            container.querySelector('#closeToolBtn').addEventListener('click', onBack);

            // Bind Search Handler
            const searchInput = container.querySelector('#ragSearchQuery');
            const searchBtn = container.querySelector('#ragSearchBtn');
            const resultsContainer = container.querySelector('#ragSearchResults');

            async function performSearch() {
                const query = searchInput.value.trim();
                if (!query) return;

                // Check if we have documents
                if (!deck.sources || deck.sources.length === 0) {
                    resultsContainer.innerHTML = `
                        <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #ef4444; font-size: 0.75rem; text-align: center; padding: 32px;">
                            No source documents in this Deck. Please upload files first.
                        </div>
                    `;
                    return;
                }

                // Show loading spinner
                resultsContainer.innerHTML = `
                    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 12px; color: var(--text-muted); font-size: 0.8125rem;">
                        <div class="status-dot" style="background-color: var(--primary-color); width: 10px; height: 10px; animation: badge-pulse 1.2s infinite ease-in-out;"></div>
                        <span>Vectorizing query and searching...</span>
                    </div>
                `;

                try {
                    // 1. Get embedding model name
                    const modelName = typeof window.getSelectedEmbeddingModel === 'function' 
                        ? await window.getSelectedEmbeddingModel() 
                        : 'Xenova/all-MiniLM-L6-v2';

                    // 2. Compute query embedding vector
                    if (typeof window.computeEmbedding !== 'function') {
                        throw new Error("Local embedding engine is not ready.");
                    }
                    const queryVector = await window.computeEmbedding(query, modelName);

                    // 3. Search similarities across all chunk vectors in all sources
                    const matches = [];
                    deck.sources.forEach(source => {
                        if (source.chunks && source.chunks.length > 0) {
                            source.chunks.forEach((chunk, chunkIdx) => {
                                if (chunk.embedding && chunk.embedding.length > 0) {
                                    const score = cosineSimilarity(queryVector, chunk.embedding);
                                    matches.push({
                                        sourceName: source.name,
                                        text: chunk.text,
                                        score: score,
                                        chunkIdx: chunkIdx
                                    });
                                }
                            });
                        }
                    });

                    // 4. Sort matches by score descending
                    matches.sort((a, b) => b.score - a.score);

                    // 5. Render top 3 matches
                    const topMatches = matches.slice(0, 3);
                    if (topMatches.length === 0 || topMatches[0].score < 0.1) {
                        resultsContainer.innerHTML = `
                            <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); font-size: 0.75rem; text-align: center; padding: 32px;">
                                No relevant matches found. Try uploading documents or re-phrase your query.
                            </div>
                        `;
                        return;
                    }

                    resultsContainer.innerHTML = '';
                    topMatches.forEach((match, idx) => {
                        const scorePct = Math.round(match.score * 100);
                        const matchDiv = document.createElement('div');
                        matchDiv.style.backgroundColor = 'var(--bg-input)';
                        matchDiv.style.border = '1px solid var(--border-color)';
                        matchDiv.style.borderRadius = '6px';
                        matchDiv.style.padding = '10px 12px';
                        matchDiv.style.display = 'flex';
                        matchDiv.style.flexDirection = 'column';
                        matchDiv.style.gap = '6px';

                        matchDiv.innerHTML = `
                            <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.6875rem;">
                                <span style="font-weight: 600; color: var(--text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px;">
                                    📄 ${match.sourceName}
                                </span>
                                <span style="font-weight: 600; color: ${scorePct > 60 ? '#22c55e' : 'var(--primary-color)'};">
                                    ${scorePct}% Match
                                </span>
                            </div>
                            <p style="font-size: 0.75rem; color: var(--text-label); line-height: 1.4; margin: 0; white-space: pre-wrap; font-family: var(--font-sans); word-break: break-word;">
                                "${match.text}"
                            </p>
                        `;
                        resultsContainer.appendChild(matchDiv);
                    });

                } catch (err) {
                    console.error("[RAG Search Tool] Error:", err);
                    resultsContainer.innerHTML = `
                        <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #ef4444; font-size: 0.75rem; text-align: center; padding: 32px;">
                            Search failed: ${err.message}
                        </div>
                    `;
                }
            }

            searchBtn.addEventListener('click', performSearch);
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') performSearch();
            });
        }
    };

    window.NeuroSparkTools.push(toolDefinition);
    console.log('[Tools] Loaded tool: ' + toolDefinition.name);
})();
