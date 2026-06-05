# NeuroSpark ⚡

**NeuroSpark** is an industry-standard, lightweight Progressive Web App (PWA) designed for modern browser-based offline document interaction and intelligence. Inspired by tools like Google NotebookLM, it lets users organize documents into cohesive "Decks" and query them using either cloud APIs or **fully local, offline AI models running on the user's hardware via WebGPU**.

🔗 **Live Deployment:** [preetamrtd.github.io/NeuroSpark/](https://preetamrtd.github.io/NeuroSpark/)
📂 **Repository:** [github.com/PreetamRtd/NeuroSpark](https://github.com/PreetamRtd/NeuroSpark)

---

## 🚀 Key Features

* **Fully Offline AI Engine (WebGPU):** Run lightweight LLMs (like Qwen-2.5-0.5B-Instruct-ONNX) and embedding tools (like Nomic or BGE) entirely in-browser. Zero server costs, 100% data privacy.
* **On-Demand PWA Cache Storage:** Download models directly from Hugging Face and store them securely inside standard sandboxed browser storage.
* **Dual Execution Modes:** Easily toggle between Cloud APIs (Gemini, OpenAI, Claude) and local offline execution.
* **Beautiful Minimalist Design:** Premium responsive design with smooth micro-animations, clean card/grid layouts, and a dedicated **pitch-black dark theme** to prevent eye strain.
* **Local Sandboxed Persistence:** All decks, source files, and configuration credentials are saved locally on your device using IndexedDB with fallback caching.

---

## 🛠️ Tech Stack

* **Core:** HTML5, Vanilla JavaScript (ES6+), WebGPU API
* **Styling:** Vanilla CSS (Responsive variables, custom transitions, adaptive design system)
* **Local Database:** IndexedDB (via standard asynchronous transaction wrapper)
* **Offline Storage Cache:** PWA Cache Storage API (for caching model files, configs, and application shell assets)
* **PWA Capability:** Service Worker caching (`sw.js`) and `manifest.json` for standalone home-screen installations

---

## 📦 File Structure

```text
NeuroSpark/
├── assets/
│   ├── brain-2.png         # Project illustration / mockup asset
│   ├── icon-192.png        # PWA splash icon (192px)
│   └── icon-512.png        # PWA splash icon (512px)
├── index.html              # Main application markup & UI view router
├── index.css               # Pitch-black responsive style system
├── storage.js              # Offline database controller (IndexedDB wrapper)
├── webgpu.js               # WebGPU hardware status & file handle diagnostic utility
├── sw.js                   # Service Worker (stale-while-revalidate asset caching)
├── manifest.json           # PWA standalone application manifest
└── README.md               # Hackathon submission documentation
```

---

## ⚡ Quick Start (Local Run)

Since the PWA uses standard modern browser APIs like WebGPU and Service Workers, it must be run over a secure context (`localhost` or `https://`).

1. **Clone the repository:**
   ```bash
   git clone https://github.com/PreetamRtd/NeuroSpark.git
   cd NeuroSpark
   ```

2. **Start a local HTTP server:**
   You can use python, node, or any light server:
   ```bash
   # Python 3
   python3 -m http.server 3000
   
   # Or Node.js (npx)
   npx http-server -p 3000
   ```

3. **Open in browser:**
   Navigate to `http://localhost:3000` on any WebGPU-compatible browser (e.g. Chrome, Edge, Opera, or Safari 18+).

---

## 📝 Submission Checklist
- [x] WebGPU diagnostics integrated
- [x] Local ONNX model downloading & local file directory selection active
- [x] Mobile layout overflow fixes completed
- [x] Pitch-black dark theme implemented
- [x] Offline installation configuration verified (PWA score: 100%)
