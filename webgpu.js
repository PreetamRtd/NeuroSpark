/**
 * NeuroSpark WebGPU and Local Model File System Manager
 * Industry-standard WebGPU hardware acceleration setup and directory handles wrapper.
 */
class WebGPUManager {
  constructor() {
    this.adapter = null;
    this.device = null;
    this.supported = 'gpu' in navigator;
  }

  /**
   * Check if WebGPU is supported by the current browser/hardware.
   * @returns {boolean}
   */
  isSupported() {
    return this.supported;
  }

  /**
   * Initializes the WebGPU device context.
   * @returns {Promise<{success: boolean, deviceName: string, error: string|null}>}
   */
  async init() {
    if (!this.supported) {
      return { success: false, deviceName: '', error: 'WebGPU is not supported in this browser.' };
    }

    try {
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) {
        return { success: false, deviceName: '', error: 'No GPU adapter found.' };
      }

      this.device = await this.adapter.requestDevice();
      
      // Attempt to extract device information (supported on modern browsers)
      let deviceName = 'Generic GPU Accelerator';
      if (this.adapter.info) {
        deviceName = this.adapter.info.description || this.adapter.info.architecture || deviceName;
      } else if (this.adapter.limits) {
        deviceName = `WebGPU Device (Max Texture Size: ${this.adapter.limits.maxTextureDimension2D || 'unknown'})`;
      }

      console.log(`[WebGPU] Initialized on device: ${deviceName}`);
      return { success: true, deviceName, error: null };
    } catch (err) {
      console.error('[WebGPU] Initialization failed:', err);
      return { success: false, deviceName: '', error: err.message };
    }
  }

  /**
   * Requests a Local Model Directory Handle using the browser File System Access API.
   * This is how Web-LLMs load model weights (like Gemma GGUF/ONNX) directly from disk.
   * @returns {Promise<{success: boolean, folderName: string, handle: FileSystemDirectoryHandle|null}>}
   */
  async selectModelDirectory() {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('File System Access API is not supported in this browser. Please use Chrome/Edge.');
    }

    try {
      const handle = await window.showDirectoryPicker({
        mode: 'read'
      });
      return { success: true, folderName: handle.name, handle };
    } catch (err) {
      if (err.name === 'AbortError') {
        return { success: false, folderName: '', handle: null }; // User cancelled the picker
      }
      throw err;
    }
  }

  /**
   * Verifies if permission is granted for a given directory handle.
   * @param {FileSystemDirectoryHandle} handle 
   * @param {boolean} requestIfMissing 
   * @returns {Promise<boolean>}
   */
  async verifyPermission(handle, requestIfMissing = false) {
    if (!handle) return false;
    const opts = { mode: 'read' };
    try {
      if ((await handle.queryPermission(opts)) === 'granted') {
        return true;
      }
      if (requestIfMissing) {
        if ((await handle.requestPermission(opts)) === 'granted') {
          return true;
        }
      }
    } catch (err) {
      console.warn('[WebGPU] Failed to query or request permission:', err);
    }
    return false;
  }
}

// Expose WebGPU manager globally
window.gpuManager = new WebGPUManager();

