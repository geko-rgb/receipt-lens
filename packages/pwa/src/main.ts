import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { billStore } from "./lib/bill/bill-document.svelte.js";
import { registerServiceWorker } from "./lib/sw/registration.js";
import { storage } from "./lib/storage/storage-state.svelte.js";

// Ticket 14 (DECISIONS/0023 P7): the root is the only trigger of disk writes, so the session is wired here
// rather than opened by whichever view needs it. Attaching costs nothing — the database is not opened until
// something actually reads or writes (P7's rule that a capture-only visit opens no store).
billStore.attach(storage.session());

const target = document.getElementById("app");
if (!target) throw new Error("missing #app mount point");

mount(App, { target });

// Ticket 17 (DECISIONS/0027 W10): registration is application code and its failure is an ordinary start. A
// blocked worker (Playwright's default context, W19), a disabled one, or a deployment that never shipped sw.js
// must not break a route, a view, the OCR path or persistence — so the outcome is recorded and dropped.
void registerServiceWorker({
  register: (url, options) => navigator.serviceWorker.register(url, options),
}).then((outcome) => {
  if (!outcome.registered) console.info("receipt-lens: service worker unavailable", outcome.error);
});
