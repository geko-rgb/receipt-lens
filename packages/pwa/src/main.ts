import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { billStore } from "./lib/bill/bill-document.svelte.js";
import { storage } from "./lib/storage/storage-state.svelte.js";

// Ticket 14 (DECISIONS/0023 P7): the root is the only trigger of disk writes, so the session is wired here
// rather than opened by whichever view needs it. Attaching costs nothing — the database is not opened until
// something actually reads or writes (P7's rule that a capture-only visit opens no store).
billStore.attach(storage.session());

const target = document.getElementById("app");
if (!target) throw new Error("missing #app mount point");

mount(App, { target });
