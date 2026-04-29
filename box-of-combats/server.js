/**
 * Box of Combats — Server
 * WebSocket server with Library of Ruina-style combat engine
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = 9120;
const BACKUP_DIR = path.join(__dirname, 'fight_backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ─── State ───────────────────────────────────────────────────────────
const clients = new Map();   // ws → { id, username, persona, fightId }
const fights = new Map();    // fightId → FightState
let nextClientId = 1;
let nextFightId = 1;

// ─── Helpers ─────────────────────────────────────────────────────────
function uid() { return 'p' + (nextClientId++); }
function fid() { return 'f' + (nextFightId++); }
function roll(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch(e) {} }
function broadcast(fightId, msg) {
  for (const [ws, c] of clients) {
    if (c.fightId === fightId) send(ws, msg);
  }
}
function broadcastLobby() {
  const list = [];
  for (const [id, f] of fights) {
    list.push({
      id, name: f.name, host: f.hostUsername,
      count: Object.keys(f.participants).length,
      phase: f.phase
    });
  }
  for (const [ws, c] of clients) {
    if (!c.fightId) send(ws, { type: 'fight_list', fights: list });
  }
}

function getAliveParticipants(fight) {
  return Object.entries(fight.participants).filter(([, p]) => p.alive);
}

// ─── Fight State Factory ─────────────────────────────────────────────
function createFightState(id, name, hostId, hostUsername) {
  return {
    id, name, hostId, hostUsername,
    phase: 'waiting',   // waiting | speed | declaration | ready_check | resolution | round_end
    round: 0,
    participants: {},
    declarationOrder: [],
    currentDeclarationIdx: -1,
    combatLog: [],
    resolutionResults: []
  };
}

function addParticipant(fight, playerId, username, persona, isHost) {
  const slots = persona.moveSlots || 1;
  const effectiveSlots = isHost && slots === 3 ? 6 : Math.min(slots, 3);
  fight.participants[playerId] = {
    username,
    persona: JSON.parse(JSON.stringify(persona)),
    side: 'left',
    currentHP: persona.hp,
    maxHP: persona.hp,
    currentStagger: 0,
    staggerThreshold: persona.staggerThreshold,
    statusEffects: { bleed: 0, burn: 0, tremor: 0, poise: 0, charge: 0 },
    alive: true,
    staggered: false,       // true = skip entire next turn
    skipThisTurn: false,     // flag set when stagger triggers, consumed next round
    moveSlots: effectiveSlots,
    speedDice: [],
    declarations: [],        // [{ moveIndex, targetId }] indexed by slot
    proceeded: false,
    isHost
  };
}

// ─── Backup / Recovery ──────────────────────────────────────────────
function saveFightBackup(fight) {
  const file = path.join(BACKUP_DIR, fight.id + '.json');
  try { fs.writeFileSync(file, JSON.stringify(fight, null, 2)); } catch(e) {}
}

// ─── Combat Engine ──────────────────────────────────────────────────

// Phase 1: Speed
function startSpeedPhase(fight) {
  fight.round++;
  fight.phase = 'speed';
  fight.declarationOrder = [];
  fight.currentDeclarationIdx = -1;
  fight.resolutionResults = [];

  const logEntries = [`── Round ${fight.round} ──`];

  for (const [pid, p] of Object.entries(fight.participants)) {
    p.speedDice = [];
    p.declarations = [];
    p.proceeded = false;

    if (!p.alive) continue;

    // Check if this participant is staggered (skip this turn)
    if (p.skipThisTurn) {
      p.skipThisTurn = false;
      p.staggered = false;
      p.currentStagger = 0;
      logEntries.push(`${p.username} is recovering from stagger — skips this round`);
      continue;
    }

    const smin = p.persona.speedRange?.[0] || 1;
    const smax = p.persona.speedRange?.[1] || 6;

    for (let s = 0; s < p.moveSlots; s++) {
      const val = roll(smin, smax);
      p.speedDice.push(val);
      fight.declarationOrder.push({ playerId: pid, slotIndex: s, speedValue: val });
    }
  }

  // Sort declaration order: highest speed first, ties broken randomly
  fight.declarationOrder.sort((a, b) => {
    if (b.speedValue !== a.speedValue) return b.speedValue - a.speedValue;
    return Math.random() - 0.5;
  });

  fight.combatLog.push(...logEntries);

  // Log speed rolls
  for (const [pid, p] of Object.entries(fight.participants)) {
    if (p.speedDice.length > 0) {
      fight.combatLog.push(`${p.username} speed: [${p.speedDice.join(', ')}]`);
    }
  }

  // If no declarations needed (everyone staggered/dead), skip to end of turn
  if (fight.declarationOrder.length === 0) {
    fight.combatLog.push('No actions this round.');
    endOfTurn(fight);
    return;
  }

  // Move to declaration phase
  fight.phase = 'declaration';
  fight.currentDeclarationIdx = 0;
  saveFightBackup(fight);
}

// Phase 2: Declaration — get current declarer
function getCurrentDeclarer(fight) {
  if (fight.currentDeclarationIdx < 0 || fight.currentDeclarationIdx >= fight.declarationOrder.length) return null;
  return fight.declarationOrder[fight.currentDeclarationIdx];
}

function submitDeclaration(fight, playerId, slotIndex, moveIndex, targetId) {
  const p = fight.participants[playerId];
  if (!p) return 'Player not found';
  if (!p.alive) return 'You are dead';

  const current = getCurrentDeclarer(fight);
  if (!current || current.playerId !== playerId || current.slotIndex !== slotIndex) {
    return 'Not your turn to declare';
  }

  const move = p.persona.moves?.[moveIndex];
  if (!move) return 'Invalid move';

  const target = fight.participants[targetId];
  if (!target) return 'Invalid target';
  if (!target.alive) return 'Target is dead';

  // Store declaration
  p.declarations[slotIndex] = { moveIndex, targetId };
  fight.combatLog.push(
    `${p.username} [slot ${slotIndex + 1}, spd ${current.speedValue}]: ${move.name} (${move.type}) → ${target.username}`
  );

  // Advance to next declaration
  fight.currentDeclarationIdx++;

  // If all declarations made, move to ready check
  if (fight.currentDeclarationIdx >= fight.declarationOrder.length) {
    fight.phase = 'ready_check';
    fight.combatLog.push('All moves declared — waiting for all participants to proceed.');
    // Reset proceeded flags
    for (const [, pp] of Object.entries(fight.participants)) {
      pp.proceeded = false;
    }
  }

  saveFightBackup(fight);
  return null; // success
}

// Phase 3: Ready Check
function submitProceed(fight, playerId) {
  const p = fight.participants[playerId];
  if (!p) return;
  p.proceeded = true;

  // Check if all alive participants have proceeded
  const allReady = getAliveParticipants(fight).every(([, pp]) => pp.proceeded || pp.skipThisTurn);
  if (allReady) {
    resolveAllClashes(fight);
  }
}

function forceProceed(fight) {
  for (const [, p] of Object.entries(fight.participants)) {
    if (p.alive) p.proceeded = true;
  }
  resolveAllClashes(fight);
}

// Phase 4: Resolution
function resolveAllClashes(fight) {
  fight.phase = 'resolution';
  fight.combatLog.push('── Resolution ──');

  // Track which declaration slots have been consumed (by a clash)
  const consumed = new Set(); // "playerId:slotIndex"

  // Process on-use passives for all declarations
  for (const entry of fight.declarationOrder) {
    const p = fight.participants[entry.playerId];
    if (!p || !p.alive) continue;
    const decl = p.declarations[entry.slotIndex];
    if (!decl) continue;
    const move = p.persona.moves?.[decl.moveIndex];
    if (!move) continue;

    // Trigger on-use passives
    if (move.onUsePassives) {
      for (const passive of move.onUsePassives) {
        applyPassiveEffect(fight, entry.playerId, decl.targetId, passive);
      }
    }
  }

  // Resolve in declaration order
  for (let i = 0; i < fight.declarationOrder.length; i++) {
    const entry = fight.declarationOrder[i];
    const key = `${entry.playerId}:${entry.slotIndex}`;
    if (consumed.has(key)) continue;

    const attacker = fight.participants[entry.playerId];
    if (!attacker || !attacker.alive) continue;

    const decl = attacker.declarations[entry.slotIndex];
    if (!decl) continue;

    const attackMove = attacker.persona.moves?.[decl.moveIndex];
    if (!attackMove) continue;

    const targetId = decl.targetId;
    const target = fight.participants[targetId];
    if (!target || !target.alive) {
      fight.combatLog.push(`${attacker.username}'s ${attackMove.name} — target is dead, skipped`);
      consumed.add(key);
      continue;
    }

    // Check if target has an unconsumed declaration targeting this attacker
    let clashEntry = null;
    for (let j = 0; j < fight.declarationOrder.length; j++) {
      if (i === j) continue;
      const other = fight.declarationOrder[j];
      const otherKey = `${other.playerId}:${other.slotIndex}`;
      if (consumed.has(otherKey)) continue;
      if (other.playerId !== targetId) continue;

      const otherDecl = target.declarations[other.slotIndex];
      if (!otherDecl) continue;
      if (otherDecl.targetId !== entry.playerId) continue;

      clashEntry = { index: j, entry: other, decl: otherDecl };
      break;
    }

    consumed.add(key);

    if (clashEntry) {
      // Clash!
      consumed.add(`${clashEntry.entry.playerId}:${clashEntry.entry.slotIndex}`);
      const defenseMove = target.persona.moves?.[clashEntry.decl.moveIndex];
      resolveClash(fight, entry.playerId, attackMove, targetId, defenseMove);
    } else {
      // Uncontested
      resolveUncontested(fight, entry.playerId, attackMove, targetId);
    }

    // Check death after each resolution
    checkDeath(fight, targetId);
    checkDeath(fight, entry.playerId);
  }

  endOfTurn(fight);
}

function resolveClash(fight, attackerId, attackMove, defenderId, defenseMove) {
  const atk = fight.participants[attackerId];
  const def = fight.participants[defenderId];

  fight.combatLog.push(
    `CLASH: ${atk.username}'s ${attackMove.name} vs ${def.username}'s ${defenseMove.name}`
  );

  const atkDice = attackMove.dice || [];
  const defDice = defenseMove.dice || [];
  const maxLen = Math.max(atkDice.length, defDice.length);

  let dodgeNextDie = false; // Dodge persists to next die

  for (let d = 0; d < maxLen; d++) {
    if (!atk.alive || !def.alive) break;

    const ad = atkDice[d];
    const dd = defDice[d];

    // If dodge effect persists from previous die
    if (dodgeNextDie && ad) {
      fight.combatLog.push(`  Die ${d + 1}: ${atk.username}'s die negated by lingering dodge`);
      dodgeNextDie = false;
      // If defender has a die here, it's not consumed since dodge already handled it
      continue;
    }

    if (ad && dd) {
      // Both sides have dice — clash
      let atkRoll = roll(ad.min, ad.max);
      let defRoll = roll(dd.min, dd.max);

      // Apply poise bonus
      if (atk.statusEffects.poise > 0) {
        atkRoll += atk.statusEffects.poise;
        fight.combatLog.push(`  ${atk.username} poise bonus: +${atk.statusEffects.poise}`);
        atk.statusEffects.poise = 0;
      }
      if (def.statusEffects.poise > 0) {
        defRoll += def.statusEffects.poise;
        fight.combatLog.push(`  ${def.username} poise bonus: +${def.statusEffects.poise}`);
        def.statusEffects.poise = 0;
      }

      fight.combatLog.push(
        `  Die ${d + 1}: ${atk.username} ${atkRoll} [${ad.min}-${ad.max}] ${ad.damageType || ''} vs ${def.username} ${defRoll} [${dd.min}-${dd.max}] ${dd.damageType || ''}`
      );

      if (defenseMove.type === 'Block') {
        // Block: auto-negates damage, deals stagger to attacker
        const staggerDmg = defRoll;
        fight.combatLog.push(`  → Block! Negates damage, deals ${staggerDmg} stagger to ${atk.username}`);
        applyStagger(fight, attackerId, staggerDmg);
        triggerOnHitPassives(fight, defenderId, attackerId, defenseMove);
      } else if (defenseMove.type === 'Dodge') {
        if (defRoll >= atkRoll) {
          fight.combatLog.push(`  → Dodge success! Negates this die and the next`);
          dodgeNextDie = true;
          triggerOnHitPassives(fight, defenderId, attackerId, defenseMove);
        } else {
          // Dodge fails, attack connects
          const dmg = calcDamage(fight, attackerId, atkRoll, ad);
          fight.combatLog.push(`  → Dodge failed! ${atk.username} deals ${dmg} damage`);
          applyDamage(fight, defenderId, dmg);
          applyOnHitEffect(fight, attackerId, defenderId, ad);
          triggerOnHitPassives(fight, attackerId, defenderId, attackMove);
        }
      } else if (defenseMove.type === 'Counter') {
        // Counter clashes like attack — higher wins
        if (atkRoll > defRoll) {
          const dmg = calcDamage(fight, attackerId, atkRoll, ad);
          fight.combatLog.push(`  → ${atk.username} wins clash, deals ${dmg} damage`);
          applyDamage(fight, defenderId, dmg);
          applyOnHitEffect(fight, attackerId, defenderId, ad);
          triggerOnHitPassives(fight, attackerId, defenderId, attackMove);
        } else if (defRoll > atkRoll) {
          const dmg = calcDamage(fight, defenderId, defRoll, dd);
          fight.combatLog.push(`  → ${def.username} wins counter, deals ${dmg} damage`);
          applyDamage(fight, attackerId, dmg);
          applyOnHitEffect(fight, defenderId, attackerId, dd);
          triggerOnHitPassives(fight, defenderId, attackerId, defenseMove);
        } else {
          fight.combatLog.push(`  → Tie! Both miss`);
        }
      } else {
        // Attack vs Attack
        if (atkRoll > defRoll) {
          const dmg = calcDamage(fight, attackerId, atkRoll, ad);
          fight.combatLog.push(`  → ${atk.username} wins, deals ${dmg} damage`);
          applyDamage(fight, defenderId, dmg);
          applyOnHitEffect(fight, attackerId, defenderId, ad);
          triggerOnHitPassives(fight, attackerId, defenderId, attackMove);
        } else if (defRoll > atkRoll) {
          const dmg = calcDamage(fight, defenderId, defRoll, dd);
          fight.combatLog.push(`  → ${def.username} wins, deals ${dmg} damage`);
          applyDamage(fight, attackerId, dmg);
          applyOnHitEffect(fight, defenderId, attackerId, dd);
          triggerOnHitPassives(fight, defenderId, attackerId, defenseMove);
        } else {
          fight.combatLog.push(`  → Tie! Both miss`);
        }
      }
    } else if (ad && !dd) {
      // Attacker has remaining dice, uncontested
      let atkRoll = roll(ad.min, ad.max);
      if (atk.statusEffects.poise > 0) {
        atkRoll += atk.statusEffects.poise;
        atk.statusEffects.poise = 0;
      }
      const dmg = calcDamage(fight, attackerId, atkRoll, ad);
      fight.combatLog.push(`  Die ${d + 1}: ${atk.username} uncontested ${atkRoll} → ${dmg} damage to ${def.username}`);
      applyDamage(fight, defenderId, dmg);
      applyOnHitEffect(fight, attackerId, defenderId, ad);
      triggerOnHitPassives(fight, attackerId, defenderId, attackMove);
    } else if (!ad && dd) {
      // Defender has remaining dice (counter/attack), uncontested
      if (defenseMove.type === 'Counter' || defenseMove.type === 'Attack') {
        let defRoll = roll(dd.min, dd.max);
        if (def.statusEffects.poise > 0) {
          defRoll += def.statusEffects.poise;
          def.statusEffects.poise = 0;
        }
        const dmg = calcDamage(fight, defenderId, defRoll, dd);
        fight.combatLog.push(`  Die ${d + 1}: ${def.username} uncontested ${defRoll} → ${dmg} damage to ${atk.username}`);
        applyDamage(fight, attackerId, dmg);
        applyOnHitEffect(fight, defenderId, attackerId, dd);
        triggerOnHitPassives(fight, defenderId, attackerId, defenseMove);
      }
    }
  }
}

function resolveUncontested(fight, attackerId, move, targetId) {
  const atk = fight.participants[attackerId];
  const target = fight.participants[targetId];
  if (!atk || !target) return;

  fight.combatLog.push(`${atk.username}'s ${move.name} hits ${target.username} uncontested`);

  const dice = move.dice || [];
  for (let d = 0; d < dice.length; d++) {
    if (!target.alive) break;
    const die = dice[d];
    let atkRoll = roll(die.min, die.max);

    if (atk.statusEffects.poise > 0) {
      atkRoll += atk.statusEffects.poise;
      fight.combatLog.push(`  ${atk.username} poise bonus: +${atk.statusEffects.poise}`);
      atk.statusEffects.poise = 0;
    }

    if (move.type === 'Attack' || move.type === 'Counter') {
      const dmg = calcDamage(fight, attackerId, atkRoll, die);
      fight.combatLog.push(`  Die ${d + 1}: ${atkRoll} [${die.min}-${die.max}] → ${dmg} damage`);
      applyDamage(fight, targetId, dmg);
      applyOnHitEffect(fight, attackerId, targetId, die);
      triggerOnHitPassives(fight, attackerId, targetId, move);
    } else if (move.type === 'Block') {
      fight.combatLog.push(`  Die ${d + 1}: Block (no incoming attack)`);
    } else if (move.type === 'Dodge') {
      fight.combatLog.push(`  Die ${d + 1}: Dodge (no incoming attack)`);
    }
  }
}

function calcDamage(fight, attackerId, rollValue, die) {
  const atk = fight.participants[attackerId];
  let dmg = rollValue;

  // Apply charge bonus
  if (atk.statusEffects.charge > 0) {
    dmg += atk.statusEffects.charge;
    fight.combatLog.push(`  ${atk.username} charge bonus: +${atk.statusEffects.charge}`);
    atk.statusEffects.charge = 0;
  }

  return Math.max(0, dmg);
}

function applyDamage(fight, targetId, dmg) {
  const target = fight.participants[targetId];
  if (!target || !target.alive) return;

  if (target.staggered) {
    // When staggered, damage goes to HP with bonus? In LoR, staggered units take extra damage.
    // For simplicity, just apply to HP
    target.currentHP = Math.max(0, target.currentHP - dmg);
  } else {
    target.currentHP = Math.max(0, target.currentHP - dmg);
  }
}

function applyStagger(fight, targetId, staggerDmg) {
  const target = fight.participants[targetId];
  if (!target || !target.alive || target.staggered) return;

  target.currentStagger += staggerDmg;
  fight.combatLog.push(`  ${target.username} takes ${staggerDmg} stagger (${target.currentStagger}/${target.staggerThreshold})`);

  if (target.currentStagger >= target.staggerThreshold) {
    target.staggered = true;
    target.skipThisTurn = true;
    target.currentStagger = 0;
    fight.combatLog.push(`  !! ${target.username} is STAGGERED — will skip next turn !!`);
  }
}

function applyOnHitEffect(fight, attackerId, targetId, die) {
  if (!die.onHitEffect) return;
  const eff = die.onHitEffect;
  const target = fight.participants[targetId];
  const atk = fight.participants[attackerId];
  if (!target || !atk) return;

  const recipient = eff.target === 'self' ? atk : target;
  const recipientId = eff.target === 'self' ? attackerId : targetId;
  const recipientName = recipient.username;

  const effectName = eff.statusEffect?.toLowerCase();
  const amount = eff.amount || 1;

  if (effectName && recipient.statusEffects.hasOwnProperty(effectName)) {
    recipient.statusEffects[effectName] += amount;
    fight.combatLog.push(`  Applied ${amount} ${effectName} to ${recipientName} (now ${recipient.statusEffects[effectName]})`);
  }
}

function triggerOnHitPassives(fight, attackerId, targetId, move) {
  if (!move.onHitPassives) return;
  for (const passive of move.onHitPassives) {
    applyPassiveEffect(fight, attackerId, targetId, passive);
  }
}

function applyPassiveEffect(fight, ownerId, targetId, passive) {
  if (!passive || !passive.effect) return;
  const eff = passive.effect;
  const owner = fight.participants[ownerId];
  const target = fight.participants[targetId];
  if (!owner || !target) return;

  const recipient = eff.target === 'self' ? owner : target;
  const recipientName = recipient.username;

  switch (eff.type) {
    case 'apply_status': {
      const status = eff.statusEffect?.toLowerCase();
      const amount = eff.amount || 1;
      if (status && recipient.statusEffects.hasOwnProperty(status)) {
        recipient.statusEffects[status] += amount;
        fight.combatLog.push(`  Passive [${passive.name}]: +${amount} ${status} to ${recipientName}`);
      }
      break;
    }
    case 'heal': {
      const amount = eff.amount || 0;
      recipient.currentHP = Math.min(recipient.maxHP, recipient.currentHP + amount);
      fight.combatLog.push(`  Passive [${passive.name}]: ${recipientName} heals ${amount}`);
      break;
    }
    case 'damage': {
      const amount = eff.amount || 0;
      recipient.currentHP = Math.max(0, recipient.currentHP - amount);
      fight.combatLog.push(`  Passive [${passive.name}]: ${recipientName} takes ${amount} damage`);
      break;
    }
    case 'stagger': {
      const amount = eff.amount || 0;
      const rid = eff.target === 'self' ? ownerId : targetId;
      applyStagger(fight, rid, amount);
      fight.combatLog.push(`  Passive [${passive.name}]: ${recipientName} takes ${amount} stagger`);
      break;
    }
    case 'modify_roll': {
      // This is handled by poise/charge status effects, just apply them
      const status = eff.statusEffect?.toLowerCase();
      const amount = eff.amount || 1;
      if (status && recipient.statusEffects.hasOwnProperty(status)) {
        recipient.statusEffects[status] += amount;
        fight.combatLog.push(`  Passive [${passive.name}]: +${amount} ${status} to ${recipientName}`);
      }
      break;
    }
  }
}

function checkDeath(fight, playerId) {
  const p = fight.participants[playerId];
  if (!p || !p.alive) return;
  if (p.currentHP <= 0) {
    p.alive = false;
    p.currentHP = 0;
    fight.combatLog.push(`☠ ${p.username} has been defeated and is now a spectator`);
  }
}

// Phase 5: End of Turn
function endOfTurn(fight) {
  fight.combatLog.push('── End of Turn ──');

  for (const [pid, p] of Object.entries(fight.participants)) {
    if (!p.alive) continue;

    // Bleed
    if (p.statusEffects.bleed > 0) {
      const dmg = p.statusEffects.bleed;
      p.currentHP = Math.max(0, p.currentHP - dmg);
      fight.combatLog.push(`${p.username} bleeds for ${dmg} (${p.statusEffects.bleed - 1} bleed remaining)`);
      p.statusEffects.bleed = Math.max(0, p.statusEffects.bleed - 1);
      checkDeath(fight, pid);
    }

    // Burn
    if (p.statusEffects.burn > 0) {
      const dmg = p.statusEffects.burn;
      p.currentHP = Math.max(0, p.currentHP - dmg);
      fight.combatLog.push(`${p.username} burns for ${dmg} (${p.statusEffects.burn - 1} burn remaining)`);
      p.statusEffects.burn = Math.max(0, p.statusEffects.burn - 1);
      checkDeath(fight, pid);
    }

    // Tremor
    if (p.statusEffects.tremor >= 5) {
      const dmg = p.statusEffects.tremor;
      fight.combatLog.push(`${p.username} tremor bursts for ${dmg} (stagger)`);
      applyStagger(fight, pid, dmg);
      p.statusEffects.tremor = 0;
    }

    // Check stagger
    if (p.currentStagger >= p.staggerThreshold && !p.staggered) {
      p.staggered = true;
      p.skipThisTurn = true;
      p.currentStagger = 0;
      fight.combatLog.push(`!! ${p.username} is STAGGERED !!`);
    }
  }

  // Check if fight is over (only 0 or 1 alive on one side, or only 1 alive total)
  const alive = getAliveParticipants(fight);
  if (alive.length <= 1) {
    fight.phase = 'round_end';
    if (alive.length === 1) {
      fight.combatLog.push(`=== ${alive[0][1].username} is the last one standing! ===`);
    } else {
      fight.combatLog.push(`=== No survivors ===`);
    }
  } else {
    fight.phase = 'round_end';
    fight.combatLog.push(`Round ${fight.round} complete. Host may start the next round.`);
  }

  saveFightBackup(fight);
}

// Reset fight
function resetFight(fight) {
  fight.phase = 'waiting';
  fight.round = 0;
  fight.declarationOrder = [];
  fight.currentDeclarationIdx = -1;
  fight.combatLog = ['Fight has been reset.'];
  fight.resolutionResults = [];

  for (const [, p] of Object.entries(fight.participants)) {
    p.currentHP = p.maxHP;
    p.currentStagger = 0;
    p.statusEffects = { bleed: 0, burn: 0, tremor: 0, poise: 0, charge: 0 };
    p.alive = true;
    p.staggered = false;
    p.skipThisTurn = false;
    p.speedDice = [];
    p.declarations = [];
    p.proceeded = false;
  }

  saveFightBackup(fight);
}

// ─── Sanitize fight state for client ────────────────────────────────
function sanitizeFightState(fight) {
  const participants = {};
  for (const [pid, p] of Object.entries(fight.participants)) {
    participants[pid] = {
      username: p.username,
      personaName: p.persona?.name || 'Unknown',
      side: p.side,
      currentHP: p.currentHP,
      maxHP: p.maxHP,
      currentStagger: p.currentStagger,
      staggerThreshold: p.staggerThreshold,
      statusEffects: { ...p.statusEffects },
      alive: p.alive,
      staggered: p.staggered,
      skipThisTurn: p.skipThisTurn,
      moveSlots: p.moveSlots,
      speedDice: p.speedDice,
      proceeded: p.proceeded,
      isHost: p.isHost,
      // Send move list (names + types only for display, full data for own moves)
      moves: (p.persona.moves || []).map(m => ({
        name: m.name, type: m.type,
        diceCount: (m.dice || []).length,
        dice: (m.dice || []).map(d => ({ min: d.min, max: d.max, damageType: d.damageType }))
      })),
      declarations: p.declarations.map(d => d ? {
        moveIndex: d.moveIndex,
        moveName: p.persona.moves?.[d.moveIndex]?.name || '?',
        moveType: p.persona.moves?.[d.moveIndex]?.type || '?',
        targetId: d.targetId
      } : null)
    };
  }

  return {
    id: fight.id,
    name: fight.name,
    hostId: fight.hostId,
    phase: fight.phase,
    round: fight.round,
    participants,
    declarationOrder: fight.declarationOrder,
    currentDeclarationIdx: fight.currentDeclarationIdx,
    combatLog: fight.combatLog.slice(-100) // last 100 entries
  };
}

// ─── Recover fights from backups ─────────────────────────────────────
try {
  const backupFiles = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json'));
  for (const file of backupFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, file), 'utf-8'));
      if (data && data.id) {
        fights.set(data.id, data);
        // Update nextFightId to avoid collisions
        const num = parseInt(data.id.replace('f', ''));
        if (!isNaN(num) && num >= nextFightId) nextFightId = num + 1;
        console.log(`  Recovered fight: ${data.name} (${data.id})`);
      }
    } catch(e) {}
  }
  if (backupFiles.length > 0) console.log(`  ${backupFiles.length} fight(s) recovered from backup`);
} catch(e) {}

// ─── WebSocket Server ───────────────────────────────────────────────
const wss = new WebSocket.Server({ port: PORT });
console.log(`Box of Combats server running on port ${PORT}`);

wss.on('connection', (ws) => {
  const clientId = uid();
  clients.set(ws, { id: clientId, username: null, persona: null, fightId: null });
  send(ws, { type: 'connected', playerId: clientId });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    const client = clients.get(ws);
    if (!client) return;

    switch (msg.type) {

      case 'register': {
        client.username = msg.username;
        client.persona = msg.persona;
        send(ws, { type: 'registered', playerId: client.id, username: client.username });
        broadcastLobby();
        break;
      }

      case 'list_fights': {
        broadcastLobby();
        break;
      }

      case 'create_fight': {
        if (!client.username || !client.persona) {
          send(ws, { type: 'error', message: 'Register with a persona first' });
          break;
        }
        const fightId = fid();
        const fight = createFightState(fightId, msg.name || `${client.username}'s Fight`, client.id, client.username);
        addParticipant(fight, client.id, client.username, client.persona, true);
        fights.set(fightId, fight);
        client.fightId = fightId;
        send(ws, { type: 'joined_fight', fightId });
        broadcast(fightId, { type: 'fight_state', state: sanitizeFightState(fight) });
        broadcastLobby();
        break;
      }

      case 'join_fight': {
        if (!client.username || !client.persona) {
          send(ws, { type: 'error', message: 'Register with a persona first' });
          break;
        }
        const fight = fights.get(msg.fightId);
        if (!fight) { send(ws, { type: 'error', message: 'Fight not found' }); break; }

        const pCount = Object.keys(fight.participants).length;
        if (pCount >= 6) { send(ws, { type: 'error', message: 'Fight is full (6 max)' }); break; }

        // Check if reconnecting
        if (fight.participants[client.id]) {
          // Reconnect — restore state
          client.fightId = msg.fightId;
          send(ws, { type: 'joined_fight', fightId: msg.fightId });
          broadcast(msg.fightId, { type: 'fight_state', state: sanitizeFightState(fight) });
        } else {
          addParticipant(fight, client.id, client.username, client.persona, false);
          client.fightId = msg.fightId;
          fight.combatLog.push(`${client.username} joined the fight`);
          send(ws, { type: 'joined_fight', fightId: msg.fightId });
          broadcast(msg.fightId, { type: 'fight_state', state: sanitizeFightState(fight) });
          broadcastLobby();
        }
        break;
      }

      case 'leave_fight': {
        const fId = client.fightId;
        if (!fId) break;
        const fight = fights.get(fId);
        if (fight) {
          const p = fight.participants[client.id];
          if (p) {
            fight.combatLog.push(`${p.username} left the fight`);
          }
          delete fight.participants[client.id];

          // If host left, remove fight
          if (fight.hostId === client.id) {
            fights.delete(fId);
            broadcast(fId, { type: 'fight_ended', reason: 'Host left' });
          } else {
            broadcast(fId, { type: 'fight_state', state: sanitizeFightState(fight) });
          }
        }
        client.fightId = null;
        send(ws, { type: 'left_fight' });
        broadcastLobby();
        break;
      }

      case 'pick_side': {
        const fight = fights.get(client.fightId);
        if (!fight || !fight.participants[client.id]) break;
        fight.participants[client.id].side = msg.side === 'right' ? 'right' : 'left';
        broadcast(client.fightId, { type: 'fight_state', state: sanitizeFightState(fight) });
        break;
      }

      case 'start_round': {
        const fight = fights.get(client.fightId);
        if (!fight) break;
        if (fight.hostId !== client.id) { send(ws, { type: 'error', message: 'Only the host can start rounds' }); break; }
        if (fight.phase !== 'waiting' && fight.phase !== 'round_end') {
          send(ws, { type: 'error', message: 'Cannot start round in current phase' }); break;
        }
        if (getAliveParticipants(fight).length < 2) {
          send(ws, { type: 'error', message: 'Need at least 2 alive participants' }); break;
        }
        startSpeedPhase(fight);
        broadcast(client.fightId, { type: 'fight_state', state: sanitizeFightState(fight) });
        // Notify first declarer
        notifyCurrentDeclarer(fight);
        break;
      }

      case 'declare_move': {
        const fight = fights.get(client.fightId);
        if (!fight || fight.phase !== 'declaration') break;
        const err = submitDeclaration(fight, client.id, msg.slotIndex, msg.moveIndex, msg.targetId);
        if (err) { send(ws, { type: 'error', message: err }); break; }
        broadcast(client.fightId, { type: 'fight_state', state: sanitizeFightState(fight) });
        // Notify next declarer
        if (fight.phase === 'declaration') {
          notifyCurrentDeclarer(fight);
        }
        break;
      }

      case 'proceed': {
        const fight = fights.get(client.fightId);
        if (!fight || fight.phase !== 'ready_check') break;
        submitProceed(fight, client.id);
        broadcast(client.fightId, { type: 'fight_state', state: sanitizeFightState(fight) });
        break;
      }

      case 'force_proceed': {
        const fight = fights.get(client.fightId);
        if (!fight || fight.phase !== 'ready_check') break;
        if (fight.hostId !== client.id) { send(ws, { type: 'error', message: 'Only host can force proceed' }); break; }
        forceProceed(fight);
        broadcast(client.fightId, { type: 'fight_state', state: sanitizeFightState(fight) });
        break;
      }

      case 'reset_fight': {
        const fight = fights.get(client.fightId);
        if (!fight) break;
        if (fight.hostId !== client.id) { send(ws, { type: 'error', message: 'Only host can reset' }); break; }
        resetFight(fight);
        broadcast(client.fightId, { type: 'fight_state', state: sanitizeFightState(fight) });
        break;
      }
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client && client.fightId) {
      const fight = fights.get(client.fightId);
      if (fight && fight.participants[client.id]) {
        fight.combatLog.push(`${fight.participants[client.id].username} disconnected`);
        // Don't remove — they can rejoin
        broadcast(client.fightId, { type: 'fight_state', state: sanitizeFightState(fight) });
      }
    }
    clients.delete(ws);
  });
});

function notifyCurrentDeclarer(fight) {
  const current = getCurrentDeclarer(fight);
  if (!current) return;
  for (const [ws, c] of clients) {
    if (c.id === current.playerId) {
      send(ws, {
        type: 'your_turn_declare',
        slotIndex: current.slotIndex,
        speedValue: current.speedValue
      });
    }
  }
}
