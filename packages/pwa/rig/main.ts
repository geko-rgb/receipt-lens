/**
 * Ticket 14 — the migration rig entry point (DECISIONS/0023 P9, S1). Built by `pnpm build:rig` into
 * `packages/pwa/rig/dist`, which is never inside `packages/pwa/dist/app`; `smoke.spec.ts` asserts that.
 */
import { mount } from "svelte";
import Rig from "./Rig.svelte";

const target = document.getElementById("rig");
if (!target) throw new Error("missing #rig mount point");

mount(Rig, { target });
