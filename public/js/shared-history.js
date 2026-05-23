/**
 * Per-client command stack for shared plan sessions.
 * Each command records entity-level before/after; undo applies inverses only
 * when affected entities still match the post-command snapshot (not stale).
 */

import { cloneLayout } from './default-layout.js';

const ROOT_KEYS = ['name', 'bounds', 'meta', 'unit', 'version'];

/** @typedef {{ kind: string, id: string, before: object | null, after: object | null }} EntityChange */

/** @typedef {{ changes: EntityChange[], label?: string }} LayoutCommand */

function fp(obj) {
  return JSON.stringify(obj);
}

function pickRoot(layout) {
  const o = {};
  for (const k of ROOT_KEYS) {
    if (layout[k] !== undefined) o[k] = cloneLayout(layout[k]);
  }
  return o;
}

/**
 * @param {object} prev
 * @param {object} next
 * @returns {LayoutCommand}
 */
export function buildLayoutCommand(prev, next) {
  /** @type {EntityChange[]} */
  const changes = [];

  const collections = [
    ['item', 'items'],
    ['wall', 'walls'],
    ['label', 'roomLabels'],
    ['opening', 'openings'],
  ];

  for (const [kind, key] of collections) {
    const a = prev[key] || [];
    const b = next[key] || [];
    const prevMap = new Map(a.map((e) => [e.id, e]));
    const nextMap = new Map(b.map((e) => [e.id, e]));

    for (const [id, afterEnt] of nextMap) {
      const beforeEnt = prevMap.get(id);
      if (!beforeEnt) {
        changes.push({
          kind,
          id,
          before: null,
          after: cloneLayout(afterEnt),
        });
      } else if (fp(beforeEnt) !== fp(afterEnt)) {
        changes.push({
          kind,
          id,
          before: cloneLayout(beforeEnt),
          after: cloneLayout(afterEnt),
        });
      }
    }
    for (const [id, beforeEnt] of prevMap) {
      if (!nextMap.has(id)) {
        changes.push({
          kind,
          id,
          before: cloneLayout(beforeEnt),
          after: null,
        });
      }
    }
  }

  const prevBg = prev.backgroundImage ?? null;
  const nextBg = next.backgroundImage ?? null;
  if (fp(prevBg) !== fp(nextBg)) {
    changes.push({
      kind: 'background',
      id: '__bg__',
      before: prevBg ? cloneLayout(prevBg) : null,
      after: nextBg ? cloneLayout(nextBg) : null,
    });
  }

  const prevRoot = pickRoot(prev);
  const nextRoot = pickRoot(next);
  if (fp(prevRoot) !== fp(nextRoot)) {
    changes.push({
      kind: 'root',
      id: '__root__',
      before: prevRoot,
      after: nextRoot,
    });
  }

  return { changes };
}

function findInLayout(layout, kind, id) {
  if (kind === 'item') return layout.items?.find((e) => e.id === id);
  if (kind === 'wall') return layout.walls?.find((e) => e.id === id);
  if (kind === 'label') return (layout.roomLabels || []).find((e) => e.id === id);
  if (kind === 'opening') return layout.openings?.find((e) => e.id === id);
  if (kind === 'background') return layout.backgroundImage ?? null;
  if (kind === 'root') {
    return pickRoot(layout);
  }
  return undefined;
}

function arrayKeyForKind(kind) {
  if (kind === 'item') return 'items';
  if (kind === 'wall') return 'walls';
  if (kind === 'label') return 'roomLabels';
  if (kind === 'opening') return 'openings';
  return null;
}

/** @param {EntityChange} ch */
function entityMatchesAfter(layout, ch) {
  const { kind, id, after } = ch;
  if (kind === 'background') {
    const cur = layout.backgroundImage ?? null;
    return fp(cur) === fp(after);
  }
  if (kind === 'root') {
    return fp(pickRoot(layout)) === fp(after);
  }
  const cur = findInLayout(layout, kind, id);
  if (after === null) return cur === undefined;
  if (!cur) return false;
  return fp(cur) === fp(after);
}

/** @param {LayoutCommand} cmd @param {object} layout */
export function canApplyInverse(cmd, layout) {
  if (!cmd?.changes?.length) return false;
  return cmd.changes.every((ch) => entityMatchesAfter(layout, ch));
}

/** @param {LayoutCommand} cmd @param {object} layout */
export function canApplyForward(cmd, layout) {
  if (!cmd?.changes?.length) return false;
  return cmd.changes.every((ch) => {
    const { kind, id, before } = ch;
    if (kind === 'background') {
      const cur = layout.backgroundImage ?? null;
      return fp(cur) === fp(before);
    }
    if (kind === 'root') {
      return fp(pickRoot(layout)) === fp(before);
    }
    const cur = findInLayout(layout, kind, id);
    if (before === null) return cur === undefined;
    if (!cur) return false;
    return fp(cur) === fp(before);
  });
}

function upsertEntity(layout, kind, entity) {
  const key = arrayKeyForKind(kind);
  if (!key) return;
  if (!layout[key]) layout[key] = [];
  const arr = layout[key];
  const i = arr.findIndex((e) => e.id === entity.id);
  if (i >= 0) arr[i] = cloneLayout(entity);
  else arr.push(cloneLayout(entity));
}

function removeEntity(layout, kind, id) {
  const key = arrayKeyForKind(kind);
  if (!key || !layout[key]) return;
  layout[key] = layout[key].filter((e) => e.id !== id);
}

/** @param {LayoutCommand} cmd @param {object} layout */
export function applyInverse(cmd, layout) {
  for (let i = cmd.changes.length - 1; i >= 0; i--) {
    const ch = cmd.changes[i];
    const { kind, id, before } = ch;
    if (kind === 'background') {
      if (before) layout.backgroundImage = cloneLayout(before);
      else delete layout.backgroundImage;
      continue;
    }
    if (kind === 'root') {
      if (before) {
        for (const k of ROOT_KEYS) {
          if (before[k] !== undefined) layout[k] = cloneLayout(before[k]);
        }
      }
      continue;
    }
    if (before === null) removeEntity(layout, kind, id);
    else upsertEntity(layout, kind, before);
  }
}

/** @param {LayoutCommand} cmd @param {object} layout */
export function applyForward(cmd, layout) {
  for (const ch of cmd.changes) {
    const { kind, id, after } = ch;
    if (kind === 'background') {
      if (after) layout.backgroundImage = cloneLayout(after);
      else delete layout.backgroundImage;
      continue;
    }
    if (kind === 'root') {
      if (after) {
        for (const k of ROOT_KEYS) {
          if (after[k] !== undefined) layout[k] = cloneLayout(after[k]);
        }
      }
      continue;
    }
    if (after === null) removeEntity(layout, kind, id);
    else upsertEntity(layout, kind, after);
  }
}

/** @param {LayoutCommand[]} stack @param {object} layout @param {'undo'|'redo'} mode */
export function findApplicableCommand(stack, layout, mode) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const cmd = stack[i];
    const ok =
      mode === 'undo' ? canApplyInverse(cmd, layout) : canApplyForward(cmd, layout);
    if (ok) return { index: i, cmd };
  }
  return null;
}
