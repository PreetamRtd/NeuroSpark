/**
 * NeuroSpark High-Performance Offline Storage Manager
 * Industry-standard storage utility using Dexie.js (IndexedDB) with LocalStorage fallback.
 * Handles data normalization (splitting decks into decks, sources, chunks, and FSRS tables)
 * while maintaining backward compatibility with the existing nested key-value API.
 */
class OfflineStorage {
  constructor(dbName = 'NeuroSparkDB') {
    this.dbName = dbName;
    this.useLocalStorage = false;
    this.db = null;

    if (typeof Dexie === 'undefined') {
      console.warn('[Storage] Dexie.js is not loaded. Falling back to LocalStorage.');
      this.useLocalStorage = true;
      this.initPromise = Promise.resolve();
      return;
    }

    try {
      this.db = new Dexie(this.dbName);
      this.db.version(1).stores({
        settings: 'key',
        decks: 'id, title, createdAt',
        sources: 'id, deckId',
        chunks: 'id, deckId, sourceId, index',
        fsrsReviews: 'chunkId, deckId, state, due'
      });
      this.initPromise = this.db.open().catch(e => {
        console.error('[Storage] Dexie database failed to open:', e);
        this.useLocalStorage = true;
      });
    } catch (e) {
      console.error('[Storage] Failed to initialize Dexie:', e);
      this.useLocalStorage = true;
      this.initPromise = Promise.resolve();
    }
  }

  /**
   * Gets a value from the database.
   * Special logic maps key="decks" to query across decks, sources, and chunks.
   */
  async get(key) {
    await this.initPromise;
    if (this.useLocalStorage) {
      return this.fallbackGet(key);
    }

    try {
      if (key === 'decks') {
        return await this.loadAllDecksTransformed();
      }
      const item = await this.db.settings.get(key);
      return item ? item.value : undefined;
    } catch (e) {
      console.error('[Storage] Error reading from Dexie:', e);
      return this.fallbackGet(key);
    }
  }

  /**
   * Sets a value in the database.
   * Special logic maps key="decks" to write normalized records across tables.
   */
  async set(key, value) {
    await this.initPromise;
    if (this.useLocalStorage) {
      return this.fallbackSet(key, value);
    }

    try {
      if (key === 'decks') {
        await this.saveAllDecksTransformed(value);
        return true;
      }
      await this.db.settings.put({ key, value });
      return true;
    } catch (e) {
      console.error('[Storage] Error writing to Dexie:', e);
      return this.fallbackSet(key, value);
    }
  }

  /**
   * Removes a key or wipes deck contents.
   */
  async remove(key) {
    await this.initPromise;
    if (this.useLocalStorage) {
      return this.fallbackRemove(key);
    }

    try {
      if (key === 'decks') {
        await this.db.transaction('rw', [this.db.decks, this.db.sources, this.db.chunks], async () => {
          await this.db.decks.clear();
          await this.db.sources.clear();
          await this.db.chunks.clear();
        });
        return true;
      }
      await this.db.settings.delete(key);
      return true;
    } catch (e) {
      console.error('[Storage] Error deleting from Dexie:', e);
      return this.fallbackRemove(key);
    }
  }

  // --- Normalization Helpers for Decks ---

  /**
   * Queries all flat tables and reconstructs the legacy nested JSON structure
   * to guarantee full compatibility with the existing UI code.
   */
  async loadAllDecksTransformed() {
    return await this.db.transaction('r', [this.db.decks, this.db.sources, this.db.chunks], async () => {
      const decks = await this.db.decks.toArray();
      const sources = await this.db.sources.toArray();
      const chunks = await this.db.chunks.toArray();

      // Group sources by deckId
      const sourcesByDeck = {};
      sources.forEach(src => {
        if (!sourcesByDeck[src.deckId]) sourcesByDeck[src.deckId] = [];
        src.chunks = [];
        sourcesByDeck[src.deckId].push(src);
      });

      // Group chunks by sourceId
      const chunksBySource = {};
      chunks.forEach(chunk => {
        if (!chunksBySource[chunk.sourceId]) chunksBySource[chunk.sourceId] = [];
        chunksBySource[chunk.sourceId].push(chunk);
      });

      // Assemble chunks inside their respective sources
      sources.forEach(src => {
        const sourceChunks = chunksBySource[src.id] || [];
        sourceChunks.sort((a, b) => a.index - b.index);
        src.chunks = sourceChunks.map(c => ({
          text: c.text,
          embedding: c.embedding
        }));
      });

      // Assemble sources inside their respective decks
      decks.forEach(deck => {
        deck.sources = sourcesByDeck[deck.id] || [];
      });

      return decks;
    });
  }

  /**
   * Receives a nested JSON array of decks and splits it into normalized tables.
   * Uses bulk operations and transactions for speed.
   */
  async saveAllDecksTransformed(decksArray) {
    if (!Array.isArray(decksArray)) return;

    await this.db.transaction('rw', [this.db.decks, this.db.sources, this.db.chunks], async () => {
      const keepDeckIds = decksArray.map(d => d.id);
      const keepSourceIds = [];

      const flatDecks = [];
      const flatSources = [];
      const flatChunks = [];

      decksArray.forEach(deck => {
        flatDecks.push({
          id: deck.id,
          title: deck.title,
          createdAt: deck.createdAt,
          itemCount: deck.itemCount
        });

        (deck.sources || []).forEach(src => {
          keepSourceIds.push(src.id);
          flatSources.push({
            id: src.id,
            deckId: deck.id,
            name: src.name,
            size: src.size,
            type: src.type,
            content: src.content
          });

          (src.chunks || []).forEach((chunk, index) => {
            flatChunks.push({
              id: `${src.id}_ch_${index}`,
              deckId: deck.id,
              sourceId: src.id,
              index: index,
              text: chunk.text,
              embedding: chunk.embedding
            });
          });
        });
      });

      // Bulk write decks and sources metadata
      await this.db.decks.bulkPut(flatDecks);
      await this.db.sources.bulkPut(flatSources);

      // Clear obsolete chunks of active sources first, then bulk insert new ones
      if (keepSourceIds.length > 0) {
        await this.db.chunks.where('sourceId').anyOf(keepSourceIds).delete();
      }
      await this.db.chunks.bulkPut(flatChunks);

      // Clean up deleted decks
      const obsoleteDecks = await this.db.decks.where('id').noneOf(keepDeckIds).primaryKeys();
      if (obsoleteDecks.length > 0) {
        await this.db.decks.bulkDelete(obsoleteDecks);
        await this.db.sources.where('deckId').anyOf(obsoleteDecks).delete();
        await this.db.chunks.where('deckId').anyOf(obsoleteDecks).delete();
      }

      // Clean up deleted sources
      const obsoleteSources = await this.db.sources.where('id').noneOf(keepSourceIds).primaryKeys();
      if (obsoleteSources.length > 0) {
        await this.db.sources.bulkDelete(obsoleteSources);
        await this.db.chunks.where('sourceId').anyOf(obsoleteSources).delete();
      }
    });
  }

  // --- LocalStorage Fallback Methods ---

  fallbackGet(key) {
    try {
      const data = localStorage.getItem(`${this.dbName}_${key}`);
      return data ? JSON.parse(data) : undefined;
    } catch (e) {
      return undefined;
    }
  }

  fallbackSet(key, value) {
    try {
      localStorage.setItem(`${this.dbName}_${key}`, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  fallbackRemove(key) {
    try {
      localStorage.removeItem(`${this.dbName}_${key}`);
      return true;
    } catch (e) {
      return false;
    }
  }
}

// Bind to window to expose database globally
window.dbStore = new OfflineStorage();
