/**
 * categoryTree (backend mirror of dine-frontend/src/utils/categoryTree.js).
 *
 * One resolver so category hierarchy behaves identically on billing, menu,
 * reports and print. Keep this in sync with the frontend copy.
 *
 * Backward compatible by design:
 *  - Old data: item.category = parent, item.subCategory = child (the leaf).
 *  - New data: item.category = leaf category id at any depth.
 *  - Legacy free-text: item.category not present in the tree -> its own node.
 *
 * A store is hierarchical ONLY when some category has a (resolvable) parentId.
 * Flat stores resolve to single-node paths, so every consumer keeps old behavior.
 *
 * Categories come from restaurantData.categories: { id, name, emoji, parentId,
 * displayOrder? }. `id` is a slug of the name; matching also accepts the name.
 */

const MAX_DEPTH = 12;

const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

function buildCategoryIndex(categories) {
  const list = Array.isArray(categories) ? categories.filter(Boolean) : [];

  const byKey = new Map();
  for (const c of list) {
    if (c.id != null) byKey.set(norm(c.id), c);
  }
  for (const c of list) {
    const nk = norm(c.name);
    if (nk && !byKey.has(nk)) byKey.set(nk, c);
  }

  const resolve = (idOrName) => byKey.get(norm(idOrName)) || null;

  const childrenMap = new Map();
  for (const c of list) {
    if (!c.parentId) continue;
    const parent = resolve(c.parentId);
    const pk = parent ? norm(parent.id) : norm(c.parentId);
    if (!childrenMap.has(pk)) childrenMap.set(pk, []);
    childrenMap.get(pk).push(c);
  }

  const childrenOf = (idOrName) => {
    const node = resolve(idOrName);
    const key = node ? norm(node.id) : norm(idOrName);
    return (childrenMap.get(key) || []).slice();
  };

  const hasTree = list.some((c) => c.parentId && resolve(c.parentId));

  // Roots = categories with no (resolvable) parent.
  const roots = list.filter((c) => !c.parentId || !resolve(c.parentId));

  return { list, byKey, resolve, childrenOf, roots, hasTree };
}

function leafCategoryKey(item) {
  if (!item) return '';
  return norm(item.subCategory) || norm(item.category);
}

function resolveCategoryPath(item, index) {
  if (!item) return [];
  // Prefer sub-category (deepest) but fall back to category if the sub-category
  // isn't in the tree — so a real category is never lost to a stale subCategory.
  let leaf = null;
  const candidates = [];
  if (item.subCategory) candidates.push(item.subCategory);
  if (item.category) candidates.push(item.category);
  for (const cand of candidates) {
    const n = index && index.resolve ? index.resolve(cand) : null;
    if (n) { leaf = n; break; }
  }
  if (!leaf) {
    if (!candidates.length) return [];
    const raw = item.subCategory || item.category || '';
    return [{ id: norm(raw), name: raw, synthetic: true }];
  }
  const path = [];
  const seen = new Set();
  let node = leaf;
  let depth = 0;
  while (node && depth < MAX_DEPTH) {
    const key = norm(node.id);
    if (seen.has(key)) break;
    seen.add(key);
    path.push(node);
    if (!node.parentId) break;
    const parent = index.resolve(node.parentId);
    if (!parent) break;
    node = parent;
    depth++;
  }
  return path.reverse();
}

/** [root, …, leaf] as ids (lowercased). Convenience for report grouping keys. */
function categoryPathIds(item, index) {
  return resolveCategoryPath(item, index).map((n) => norm(n.id));
}

/** top-level ancestor node (or the leaf/synthetic if flat). */
function topLevelCategory(item, index) {
  const path = resolveCategoryPath(item, index);
  return path.length ? path[0] : null;
}

function isAncestorOrSelf(nodeIdOrName, item, index) {
  const targetNode = index && index.resolve ? index.resolve(nodeIdOrName) : null;
  const targetKey = targetNode ? norm(targetNode.id) : norm(nodeIdOrName);
  if (!targetKey) return false;
  const path = resolveCategoryPath(item, index);
  return path.some((n) => norm(n.id) === targetKey || norm(n.name) === targetKey);
}

function descendantIdsOf(idOrName, index) {
  const out = [];
  const seen = new Set();
  const walk = (key, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const child of index.childrenOf(key)) {
      const ck = norm(child.id);
      if (seen.has(ck)) continue;
      seen.add(ck);
      out.push(child.id);
      walk(child.id, depth + 1);
    }
  };
  walk(idOrName, 0);
  return out;
}

/**
 * Turn a FLAT category sales breakdown into an ordered HIERARCHICAL one.
 *
 * Input rows: [{ category, itemsSold, revenue, ... }] where `category` is a
 * category id or name (as stored on order items). Output: rows ordered as a
 * tree (parent, then its children indented) with:
 *   - depth       0 = top-level, 1 = sub, 2 = sub-sub …
 *   - isParent    true if it has children with data
 *   - itemsSold/revenue = ROLLED-UP totals (node + all its descendants) so a
 *     parent row shows its whole section's total (like eZee).
 *
 * Because parent rows are rolled up, a grand total must sum ONLY depth===0 rows
 * (children are already included in their parent) — the caller/UI does that.
 *
 * Flat stores (no tree) => returns the rows unchanged with depth:0 — identical
 * to the old flat report.
 */
function buildCategoryReport(rows, categories) {
  const list = Array.isArray(rows) ? rows : [];
  const index = buildCategoryIndex(categories);
  if (!index.hasTree) return list.map((r) => ({ ...r, depth: 0, isParent: false }));

  // Direct totals keyed by resolved node id (or the raw key if not in tree).
  const direct = new Map();
  for (const r of list) {
    const node = index.resolve(r.category);
    const id = node ? norm(node.id) : norm(r.category);
    const cur = direct.get(id) || { itemsSold: 0, revenue: 0, name: node ? node.name : r.category, inTree: !!node, extra: r };
    cur.itemsSold += r.itemsSold || 0;
    cur.revenue += r.revenue || 0;
    direct.set(id, cur);
  }

  const rollup = (nodeId, depth) => {
    if (depth > MAX_DEPTH) return { itemsSold: 0, revenue: 0 };
    const self = direct.get(norm(nodeId)) || { itemsSold: 0, revenue: 0 };
    const tot = { itemsSold: self.itemsSold || 0, revenue: self.revenue || 0 };
    for (const child of index.childrenOf(nodeId)) {
      const c = rollup(child.id, depth + 1);
      tot.itemsSold += c.itemsSold;
      tot.revenue += c.revenue;
    }
    return tot;
  };

  const out = [];
  const emitted = new Set();
  const walk = (node, depth) => {
    if (depth > MAX_DEPTH) return;
    const roll = rollup(node.id, 0);
    if (roll.itemsSold === 0 && roll.revenue === 0) return; // no data anywhere in subtree
    const kids = index.childrenOf(node.id);
    out.push({ category: node.name, categoryId: node.id, itemsSold: roll.itemsSold, revenue: roll.revenue, depth, isParent: kids.length > 0 });
    emitted.add(norm(node.id));
    kids.forEach((child) => walk(child, depth + 1));
  };
  // Roots sorted by rolled-up revenue (desc) for a sensible top order.
  index.roots
    .map((r) => ({ r, rev: rollup(r.id, 0).revenue }))
    .sort((a, b) => b.rev - a.rev)
    .forEach(({ r }) => walk(r, 0));

  // Append any row not yet emitted as a top-level fallback. This covers legacy
  // (not-in-tree) categories AND pathological cyclic nodes that `walk` can't
  // reach from a root — so revenue can NEVER silently vanish from the report.
  for (const [id, val] of direct) {
    if (!emitted.has(id)) {
      out.push({ category: val.name, categoryId: id, itemsSold: val.itemsSold, revenue: val.revenue, depth: 0, isParent: false });
    }
  }
  return out;
}

module.exports = {
  buildCategoryIndex,
  buildCategoryReport,
  leafCategoryKey,
  resolveCategoryPath,
  categoryPathIds,
  topLevelCategory,
  isAncestorOrSelf,
  descendantIdsOf,
};
