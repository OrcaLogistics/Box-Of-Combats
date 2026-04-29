# Box of Combats

A Library of Ruina-style combat overlay application for Windows. Built with Electron and WebSockets. Designed to run as an always-on-top overlay during gaming sessions.

## Prerequisites

- **Node.js** (v18 or newer) — download from [https://nodejs.org](https://nodejs.org)
- **Windows 10/11**

## Quick Start

1. **Install dependencies** — double-click `SETUP.bat`
2. **Start the server** — double-click `START_SERVER.bat`
3. **Start the app** — double-click `START_CLIENT.bat` (each player runs their own client)

## Controls

- `Ctrl+Shift+C` — toggle overlay visibility
- Drag the title bar to move the window
- Resize from edges/corners

## How to Play

### 1. Build a Persona

Open **Persona Workshop** from the main menu.

- Click **+ New** to create a persona
- Set HP, Stagger Threshold, Speed Range (min–max), and Move Slots (1–3)
- Add **Moves** — each move has a type (Attack, Dodge, Block, Counter) and one or more dice
- Each die has a min–max roll range, a damage type (Slash/Pierce/Blunt), and an optional on-hit status effect
- Add **Passives** to the persona or to individual moves (on-hit or on-use)
- Click **Set as Active** to select which persona you bring into fights

### 2. Connect to a Fight

Open **Fight Lobby** from the main menu.

- Enter the server address (default: `ws://localhost:9120` for local play)
- Enter your display name and click **Connect**
- Create a new fight or join an existing one

### 3. Fight!

The host controls the flow of combat. Each round follows these phases:

**Speed Phase** — everyone's speed dice are rolled automatically.

**Declaration Phase** — in order from highest speed to lowest, each player picks a move and a target for each of their speed slots.

**Ready Check** — everyone clicks "Proceed" to confirm they're ready for resolution. The host can force-proceed if someone is AFK.

**Resolution Phase** — clashes and uncontested attacks are resolved die by die. Results appear in the combat log.

**End of Turn** — status effects tick (Bleed, Burn, Tremor), stagger and death are checked, and the round ends.

## Combat Mechanics

### Move Types

| Type | Behavior |
|------|----------|
| Attack | Offensive. Dice deal damage on win. |
| Dodge | Defensive. If dodge die >= attack die, negates that die AND the next die. |
| Block | Defensive. Auto-negates the current attacking die. Deals stagger damage to attacker. |
| Counter | Hybrid. Clashes like attack dice — winner deals damage. |

### Status Effects

| Status | Effect |
|--------|--------|
| Bleed | End of turn: take damage = Bleed count, then count -1 |
| Burn | End of turn: take damage = Burn count, then count -1 |
| Tremor | End of turn: if 5+ stacks, burst damage = count (hits stagger bar), then resets to 0 |
| Poise | Adds bonus to next roll = Poise count, then consumed |
| Charge | Adds bonus damage to next attack = Charge count, then consumed |

### Stagger

When the stagger bar fills, the unit is staggered: they skip their entire next turn, and the stagger bar resets.

### Death

When HP hits 0, the unit dies and becomes a spectator for the rest of the fight.

### Move Slots

Personas have 1–3 move slots. Each slot gets one speed die and one declaration per round. Hosts automatically get 6 slots if their persona has 3 (host advantage).

## Multiplayer Setup

For LAN play, all players connect to the same server address (the host's IP on port 9120). For internet play, the server host needs to port-forward 9120 or use a tunneling service.

## File Structure

```
box-of-combats/
  package.json        — dependencies
  server.js           — WebSocket server + combat engine
  main.js             — Electron main process
  preload.js          — IPC bridge
  index.html          — all UI (single-page app)
  SETUP.bat           — install dependencies
  START_SERVER.bat     — run the server
  START_CLIENT.bat     — run the overlay client
  fight_backups/      — auto-saved fight state (crash recovery)
```

Persona data is saved in the app's local storage and persists across restarts.
