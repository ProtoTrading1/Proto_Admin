import { subcategoryOptionsFromTree } from '../../lib/taxonomyAdmin';

function childrenOf(tree, id) {
  if (!id) return [];
  const stack = [...(tree || [])];
  while (stack.length) {
    const node = stack.shift();
    if (node.id === id) return node.children || [];
    if (node.children?.length) stack.push(...node.children);
  }
  return [];
}

/**
 * Full-depth cascading category picker for the Product Loader.
 *
 * `value` is a contiguous array of taxonomy node ids — [mainId, child1Id,
 * child2Id, ...] — as deep as the tree goes (no fixed cap). It emits the new
 * contiguous id array via onChange. A new empty picker appears one level below
 * the deepest selection whenever that level has children, so every subcategory
 * is reachable. Mirrors the arbitrary-depth picker in BulkMoveModal.
 */
export default function CategoryPathSelect({
  taxonomyTree = [],
  value = [],
  onChange,
  mainLabel = 'Default category',
  mainPlaceholder = '— Select if needed —',
}) {
  const mainId = value[0] || '';
  const childIds = value.slice(1);

  // Render one picker per level while the previous level has a value and there
  // are options — stops one level past the deepest populated selection.
  const childFields = [];
  let parentId = mainId;
  for (let level = 1; parentId; level += 1) {
    const options = level === 1
      ? subcategoryOptionsFromTree(taxonomyTree, mainId)
      : childrenOf(taxonomyTree, parentId);
    if (!options.length) break;
    const currentValue = childIds[level - 1] || '';
    childFields.push({ level, options, currentValue });
    parentId = currentValue;
  }

  const setMain = (id) => onChange?.(id ? [id] : []);
  // Truncate any deeper selections when a level changes, keeping a contiguous path.
  const setChild = (level, id) => onChange?.([mainId, ...childIds.slice(0, level - 1), id].filter(Boolean));

  return (
    <>
      <label>
        {mainLabel}
        <select
          className="adm-select adm-select--enhanced"
          value={mainId}
          onChange={(e) => setMain(e.target.value)}
        >
          <option value="">{mainPlaceholder}</option>
          {(taxonomyTree || []).map((cat) => <option key={cat.id} value={cat.id}>{cat.label}</option>)}
        </select>
      </label>
      {childFields.map(({ level, options, currentValue }) => (
        <label key={level}>
          {level === 1 ? 'Subcategory' : `Subcategory ${level}`}
          <select
            className="adm-select adm-select--enhanced"
            value={currentValue}
            onChange={(e) => setChild(level, e.target.value)}
          >
            <option value="">— Optional —</option>
            {options.map((opt) => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
          </select>
        </label>
      ))}
    </>
  );
}
