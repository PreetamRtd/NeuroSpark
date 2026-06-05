/**
 * NeuroSpark Offline Storage Manager
 * Industry-standard storage utility using IndexedDB with LocalStorage fallback.
 */
class OfflineStorage {
  constructor(dbName = 'NeuroSparkDB', storeName = 'dashboardStore') {
    this.dbName = dbName;
    this.storeName = storeName;
    this.db = null;
    this.initPromise = this.initDB();
  }

  /**
   * Initializes IndexedDB.
   */
  initDB() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) {
        console.warn('[Storage] IndexedDB not supported, falling back to LocalStorage');
        resolve(null);
        return;
      }

      const request = indexedDB.open(this.dbName, 1);

      request.onerror = (event) => {
        console.error('[Storage] Database failed to open:', event.target.error);
        resolve(null);
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('[Storage] IndexedDB initialized successfully');
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
          console.log(`[Storage] Object store "${this.storeName}" created`);
        }
      };
    });
  }

  /**
   * Gets a value from the database by its key.
   * @param {string} key 
   * @returns {Promise<any>}
   */
  async get(key) {
    await this.initPromise;
    if (this.db) {
      return new Promise((resolve) => {
        const transaction = this.db.transaction([this.storeName], 'readonly');
        const store = transaction.objectStore(this.storeName);
        const request = store.get(key);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          console.error('[Storage] Error reading from IndexedDB:', request.error);
          resolve(this.fallbackGet(key));
        };
      });
    } else {
      return this.fallbackGet(key);
    }
  }

  /**
   * Sets a value in the database under the specified key.
   * @param {string} key 
   * @param {any} value 
   * @returns {Promise<boolean>}
   */
  async set(key, value) {
    await this.initPromise;
    if (this.db) {
      return new Promise((resolve) => {
        const transaction = this.db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.put(value, key);

        request.onsuccess = () => resolve(true);
        request.onerror = () => {
          console.error('[Storage] Error writing to IndexedDB:', request.error);
          resolve(this.fallbackSet(key, value));
        };
      });
    } else {
      return this.fallbackSet(key, value);
    }
  }

  /**
   * Removes a value from the database by its key.
   * @param {string} key 
   * @returns {Promise<boolean>}
   */
  async remove(key) {
    await this.initPromise;
    if (this.db) {
      return new Promise((resolve) => {
        const transaction = this.db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.delete(key);

        request.onsuccess = () => resolve(true);
        request.onerror = () => {
          console.error('[Storage] Error deleting from IndexedDB:', request.error);
          resolve(this.fallbackRemove(key));
        };
      });
    } else {
      return this.fallbackRemove(key);
    }
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

// Bind to window to expose globally
window.dbStore = new OfflineStorage();
