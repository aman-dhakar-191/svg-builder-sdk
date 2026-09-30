<script lang="ts">
  import { fly } from "../lib/motion.js";
  import { COMMANDS, formatKeys, type Command } from "../lib/commands.js";
  import { session } from "../lib/session.svelte.js";

  const MENUS = ["File", "Edit", "Path", "View"] as const;
  let open: (typeof MENUS)[number] | null = $state(null);
  let active = $state(-1);
  let bar: HTMLElement;

  const items = (m: string): Command[] => COMMANDS.filter((c) => c.menu === m);

  function toggle(m: (typeof MENUS)[number]): void {
    open = open === m ? null : m;
    active = -1;
  }
  function choose(c: Command): void {
    open = null;
    session.run(c.action);
  }
  function onKeydown(e: KeyboardEvent): void {
    if (!open) return;
    const list = items(open);
    if (e.key === "Escape") open = null;
    else if (e.key === "ArrowDown") active = (active + 1) % list.length;
    else if (e.key === "ArrowUp") active = (active - 1 + list.length) % list.length;
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const i = MENUS.indexOf(open) + (e.key === "ArrowRight" ? 1 : -1);
      open = MENUS[(i + MENUS.length) % MENUS.length]!;
      active = 0;
    } else if (e.key === "Enter" && active >= 0) choose(list[active]!);
    else return;
    e.preventDefault();
  }
</script>

<svelte:window
  onpointerdown={(e) => { if (open && !bar.contains(e.target as Node)) open = null; }}
  onkeydown={onKeydown}
  onblur={() => (open = null)}
/>

<nav class="menubar" bind:this={bar} aria-label="Menu">
  {#each MENUS as m}
    <div class="menu">
      <button
        class="top"
        aria-haspopup="menu"
        aria-expanded={open === m}
        onclick={() => toggle(m)}
        onpointerenter={() => { if (open && open !== m) { open = m; active = -1; } }}
      >{m}</button>
      {#if open === m}
        <ul class="dropdown" role="menu" transition:fly={{ y: -4, duration: 120 }}>
          {#each items(m) as c, i}
            {#if c.separator}<li class="sep" role="separator"></li>{/if}
            <li role="none">
              <button role="menuitem" class:active={i === active} onclick={() => choose(c)} onpointerenter={() => (active = i)}>
                <span>{c.label}</span>{#if c.keys}<span class="keys">{formatKeys(c.keys)}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/each}
</nav>

<style>
  .menubar { display: flex; gap: 1px; }
  .menu { position: relative; }
  .top { border: 0; background: none; padding: 5px 9px; border-radius: 6px; color: var(--muted); transition: background var(--fast), color var(--fast); }
  .top:hover, .top[aria-expanded="true"] { background: var(--hover); color: var(--fg); }
  .dropdown { position: absolute; top: calc(100% + 4px); left: 0; z-index: 50; min-width: 250px; margin: 0; padding: 5px; list-style: none; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); }
  .dropdown button { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 18px; border: 0; background: none; text-align: left; padding: 6px 10px; border-radius: 6px; white-space: nowrap; }
  .dropdown button.active { background: var(--ink-soft); }
  .keys { font: 11px var(--f-mono); color: var(--muted); }
  .sep { height: 1px; background: var(--line); margin: 4px 6px; }
</style>
