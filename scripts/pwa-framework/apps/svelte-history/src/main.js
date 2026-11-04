import { mount } from "svelte";
import App from "./App.svelte";

mount(App, { target: document.getElementById("app") });
window.__probeMounted = true;
