/** Components are compiled by Svelte, not by tsc; this only keeps the TS entry typechecking. */
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<Record<string, never>>;
  export default component;
}
