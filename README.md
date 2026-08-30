# earcue

Real-time teleprompter — listens to a conversation and drafts your next line with the Gemini Live API.

A plain HTML/JS app: it captures microphone audio in the browser, streams it to the Gemini Live bidirectional API (`gemini-2.5-flash-native-audio-preview`), and shows a suggested next line to say based on the conversation so far. No build step, no backend — the Gemini API key is entered client-side by the user and never leaves the browser except to talk to Google's API.

## Run locally

Open `index.html` in a browser (or serve the folder with any static file server) and paste a Gemini API key into the settings panel.

## Files

- `index.html` — UI shell
- `app.js` — capture, Gemini Live WebSocket wiring, and suggestion rendering
- `capture-worklet.js` — AudioWorklet for low-latency mic capture
- `assets/` — styling
