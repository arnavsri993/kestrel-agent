# Kestrel iOS Companion & Mobile Web Browser

Kestrel for iOS is a native application designed to be both your primary mobile web browser and an intelligent companion to the Kestrel desktop agent.

---

## 1. Architecture Overview

```
+-------------------------------------------------------------------------+
|                              Kestrel iOS                                |
|  +-----------------------------+     +-------------------------------+  |
|  |     Mobile Web Browser      |     |      Agent AI Companion       |  |
|  |  • WebKit Multi-Tab Engine  |     |  • Real-Time Task Stream (SSE)|  |
|  |  • Private Mode + Face ID   |     |  • Interactive Approval Gates |  |
|  |  • Privacy Content Blocker  |     |  • Voice Talk & Hands-Free    |  |
|  |  • Typography Reader View   |     |  • Paired Node Protocol       |  |
|  |  • Speed Dial & Bookmarks   |     |  • Task Queue & Supervision   |  |
|  +--------------+--------------+     +---------------+---------------+  |
|                 |                                    |                  |
|                 +-----------------+------------------+                  |
|                                   |                                     |
|                     +-------------v-------------+                       |
|                     | In-Browser AI Assistant   |                       |
|                     | • 1-Tap Page Summary      |                       |
|                     | • Contextual Web Q&A      |                       |
|                     | • Structured Extraction   |                       |
|                     | • Desktop Kestrel Handoff |                       |
|                     +---------------------------+                       |
+-----------------------------------+-------------------------------------+
                                    |
            TLS / HTTPS + SSE       |   Authenticated Gateway API
                                    v
+-------------------------------------------------------------------------+
|                          Kestrel Desktop Host                           |
|  • Remote Gateway (/v1/sessions, /v1/jobs, /v1/jobs/:id/resume)        |
|  • Live SSE Event Stream (/v1/events)                                   |
|  • Paired Node Protocol (/v1/nodes/beacon, /v1/nodes/:id/poll)          |
|  • Execution Engine, Policy Boundaries & Verification                   |
+-------------------------------------------------------------------------+
```

---

## 2. Core Browser Features

### Modern WebKit Browser Engine
- **Multi-Tab Management**: Seamless 2-column grid switcher with live snapshot thumbnails, tab search filter, duplicate tab, and instant tab restoration.
- **Private Browsing with Biometrics**: Isolated non-persistent cookie/cache storage. Private tabs can be locked behind Face ID / Touch ID authentication.
- **Content & Tracking Blocker**: Powered by `WKContentRuleListStore` compiling declarative rules to block cross-site tracking scripts, cryptominers, telemetry, and intrusive ads.
- **Omnibox Search Bar**: Smart address field supporting instant search queries, domain navigation, SSL padlock verification, reader mode triggers, and search engine selection (DuckDuckGo, Google, Bing, Ecosia, Kestrel AI Search).
- **Distraction-Free Reader Mode**: Clean typography rendering with customizable fonts (Serif / Sans-Serif), sizing (A- / A+), and themes (Dark Obsidian, Warm Sepia, Light).
- **Download Manager**: Background file downloading via `URLSessionDownloadDelegate`, progress tracking, and integration with the iOS Share Sheet and Files app.

---

## 3. Deep Agent Companion Features

### Real-Time Task Supervision & SSE
- Live connection to the Kestrel Desktop Gateway over loopback or LAN.
- Real-time streaming event log displaying lifecycle events (`tool.started`, `tool.progress`, `tool.completed`).
- Background task review queue with live status indicators (`running`, `waiting_approval`, `completed`).

### Interactive Safety Gate Approvals
- Consequential tools (file modification, shell command execution, sending emails, payments) pause execution at the safety gate boundary.
- High-visibility interactive cards present tool parameters and risk ratings (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`).
- One-tap **Approve Action** or **Reject** directly from the mobile app or notification.

### In-Browser AI Page Assistant
- Floating AI action pill on every webpage.
- **Summarize**: Generates structured summaries with key takeaways.
- **Ask Page**: Grounded conversational Q&A using the page's live DOM context.
- **Extract Data**: Transforms tables, lists, and unformatted data into clean Markdown / JSON.
- **Send to Desktop**: Dispatches the active URL and research prompt directly into an active desktop Kestrel session.

### Hands-Free Voice Talk Mode
- Speech transcription powered by `SFSpeechRecognizer` and `AVAudioEngine`.
- Live pulsating audio orb visualizer and text-to-speech feedback via `AVSpeechSynthesizer`.

### Paired Node Protocol Implementation
- Conforms to Kestrel's Paired Node Specification (`/v1/nodes/beacon` and `/v1/nodes/:id/poll`).
- Advertises node capabilities: `location`, `talk`, `voiceWake`, `activePresence`.
- Responds to `location.get` contracts with permission-gated accuracy modes (`coarse`, `balanced`, `precise`).

---

## 4. How to Build and Run in Xcode

1. Open Xcode on macOS.
2. Select **File > Open** and choose `apps/ios/Package.swift` or create an iOS App project pointing to `apps/ios/KestrelBrowser/Sources`.
3. Set the target device to an **iOS Simulator (e.g. iPhone 16 Pro)** or a connected physical iOS device.
4. Ensure the deployment target is set to **iOS 17.0+**.
5. Press **Cmd + R** to build and run.

### Pairing with Desktop Kestrel
1. On your Mac running Kestrel Desktop, note the gateway port (default: `4040`) or run `corepack pnpm dev:desktop`.
2. In Kestrel iOS, tap the **Agent Hub** icon in the bottom navigation bar.
3. Tap **Pair Device Now**, enter your Mac's IP address (e.g., `http://192.168.1.50:4040` or `http://127.0.0.1:4040`), Pairing ID, and one-time code.
4. Once paired, tokens are securely stored in the iOS Keychain and real-time streaming begins immediately.
