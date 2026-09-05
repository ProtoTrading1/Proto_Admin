import { subcategoryOptionsFromTree, childrenOfTree } from './taxonomyAdmin';

export function subcategoryOptions(categoryId, tree) {
  return subcategoryOptionsFromTree(tree, categoryId);
}

export function allNodesFlat(nodes, depth = 0) {
  return (nodes || []).flatMap((n) => [
    { id: n.id, label: n.label, depth },
    ...allNodesFlat(n.children, depth + 1),
  ]);
}

export function findNodePath(tree, targetId, path = []) {
  for (const node of tree || []) {
    if (node.id === targetId) return [...path, node.id];
    if (node.children?.length) {
      const found = findNodePath(node.children, targetId, [...path, node.id]);
      if (found) return found;
    }
  }
  return null;
}

export function childrenOf(tree, id) {
  return childrenOfTree(tree, id);
}
