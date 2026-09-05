import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, FolderTree, GripVertical, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';

function buildPathFromRoot(tree, targetId, path = []) {
  for (const node of tree) {
    const next = [...path, node.id];
    if (node.id === targetId) return next;
    if (node.children?.length) {
      const hit = buildPathFromRoot(node.children, targetId, next);
      if (hit) return hit;
    }
  }
  return null;
}

export function getCategoriesAtPath(tree, browsePath = []) {
  let nodes = tree || [];
  for (const id of browsePath) {
    const found = nodes.find((node) => node.id === id);
    if (!found?.children?.length) return [];
    nodes = found.children;
  }
  return nodes;
}

export function resolvePathLabels(tree, path = []) {
  const labels = [];
  let nodes = tree || [];
  for (const id of path) {
    const found = nodes.find((node) => node.id === id);
    if (!found) break;
    labels.push(found.label);
    nodes = found.children || [];
  }
  return labels;
}

function nodeMatches(node, query) {
  return String(node.label || '').toLowerCase().includes(query);
}

function filterTree(nodes, query) {
  if (!query) return nodes;
  const out = [];
  for (const node of nodes || []) {
    const childMatches = node.children?.length ? filterTree(node.children, query) : [];
    if (nodeMatches(node, query) || childMatches.length) {
      out.push({
        ...node,
        children: nodeMatches(node, query) ? (node.children || []) : childMatches,
      });
    }
  }
  return out;
}

function collectIds(nodes, ids = []) {
  for (const node of nodes || []) {
    ids.push(node.id);
    if (node.children?.length) collectIds(node.children, ids);
  }
  return ids;
}

/** Reorder children of a specific parent node (deep in the tree). */
function reorderChildrenInTree(tree, parentId, newChildren) {
  return tree.map((node) => {
    if (node.id === parentId) return { ...node, children: newChildren };
    if (node.children?.length) {
      return { ...node, children: reorderChildrenInTree(node.children, parentId, newChildren) };
    }
    return node;
  });
}

function RowActions({ node, nodeType, onEditNode, onDeleteNode, onAddChild }) {
  const [open, setOpen] = useState(false);

  if (!onEditNode && !onDeleteNode && !onAddChild) return null;

  return (
    <div className={`cat-sidebar-actions${open ? ' cat-sidebar-actions--open' : ''}`}>
      <button
        type="button"
        className="cat-sidebar-actions-trigger"
        aria-label={`Actions for ${node.label}`}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <>
          <button type="button" className="cat-sidebar-actions-backdrop" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="cat-sidebar-actions-menu" role="menu">
            {onAddChild && (
              <button
                type="button"
                role="menuitem"
                onClick={(e) => { e.stopPropagation(); onAddChild(node.id); setOpen(false); }}
              >
                <Plus size={14} /> Add child
              </button>
            )}
            {onEditNode && (
              <button
                type="button"
                role="menuitem"
                onClick={(e) => { e.stopPropagation(); onEditNode({ id: node.id, label: node.label, type: nodeType }); setOpen(false); }}
              >
                <Pencil size={14} /> Rename
              </button>
            )}
            {onDeleteNode && (
              <button
                type="button"
                role="menuitem"
                className="cat-sidebar-actions-menu--danger"
                onClick={(e) => { e.stopPropagation(); onDeleteNode({ id: node.id, label: node.label, type: nodeType }); setOpen(false); }}
              >
                <Trash2 size={14} /> Delete
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CategoryRow({
  node,
  depth,
  selectedPath,
  pathHere,
  hasChildren,
  open,
  onToggle,
  onSelect,
  nodeType,
  onEditNode,
  onDeleteNode,
  onAddChild,
  onDrillIn,
  stackMode = false,
  showDragHandle = false,
  productCount = null,
}) {
  const isSelected = selectedPath.length > 0 && selectedPath[selectedPath.length - 1] === node.id;
  const isOnPath = selectedPath.includes(node.id);

  return (
    <div
      className={`cat-sidebar-item-row${isSelected ? ' cat-sidebar-item-row--active' : ''}${isOnPath && !isSelected ? ' cat-sidebar-item-row--path' : ''}${stackMode ? ' cat-sidebar-item-row--stack' : ''}${showDragHandle ? ' cat-sidebar-item-row--draggable' : ''}`}
      style={{ '--cat-depth': depth }}
    >
      {showDragHandle && (
        <span className="cat-sidebar-drag-handle" aria-hidden="true">
          <GripVertical size={14} />
        </span>
      )}
      {!stackMode && (hasChildren ? (
        <button
          type="button"
          className="cat-sidebar-toggle"
          aria-label={open ? `Collapse ${node.label}` : `Expand ${node.label}`}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
        >
          {open ? <ChevronDown size={16} strokeWidth={2.2} /> : <ChevronRight size={16} strokeWidth={2.2} />}
        </button>
      ) : (
        <span className="cat-sidebar-toggle cat-sidebar-toggle--spacer" aria-hidden="true" />
      ))}
      <button
        type="button"
        className="cat-sidebar-item"
        onClick={onSelect}
        title={node.label}
      >
        <span className="cat-sidebar-label">
          {node.label}
          {productCount != null && productCount > 0 && (
            <span className="cat-sidebar-count">{productCount}</span>
          )}
        </span>
      </button>
      {stackMode && hasChildren && onDrillIn && (
        <button
          type="button"
          className="cat-sidebar-drill"
          aria-label={`Browse ${node.label} subcategories`}
          onClick={(e) => { e.stopPropagation(); onDrillIn(); }}
        >
          <ChevronRight size={18} strokeWidth={2.2} />
        </button>
      )}
      <RowActions
        node={node}
        nodeType={nodeType}
        onEditNode={onEditNode}
        onDeleteNode={onDeleteNode}
        onAddChild={onAddChild}
      />
    </div>
  );
}

/** Renders a draggable flat list of sibling nodes. */
function DraggableSiblingList({ nodes, parentId, onReorderSiblings, renderItem }) {
  const [draggingId, setDraggingId] = useState(null);
  const [overId, setOverId] = useState(null);
  const dragNodeRef = useRef(null);

  const handleDragStart = (e, id) => {
    e.stopPropagation();
    dragNodeRef.current = id;
    setDraggingId(id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, id) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (id !== dragNodeRef.current) setOverId(id);
  };

  const handleDrop = (e, targetId) => {
    e.preventDefault();
    e.stopPropagation();
    const sourceId = dragNodeRef.current;
    if (!sourceId || sourceId === targetId) {
      setDraggingId(null); setOverId(null); dragNodeRef.current = null;
      return;
    }
    const fromIdx = nodes.findIndex((n) => n.id === sourceId);
    const toIdx = nodes.findIndex((n) => n.id === targetId);
    if (fromIdx === -1 || toIdx === -1) {
      setDraggingId(null); setOverId(null); dragNodeRef.current = null;
      return;
    }
    const next = [...nodes];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    onReorderSiblings(parentId, next);
    setDraggingId(null); setOverId(null); dragNodeRef.current = null;
  };

  const handleDragEnd = () => {
    setDraggingId(null); setOverId(null); dragNodeRef.current = null;
  };

  return nodes.map((node) => (
    <div
      key={node.id}
      draggable
      onDragStart={(e) => handleDragStart(e, node.id)}
      onDragOver={(e) => handleDragOver(e, node.id)}
      onDrop={(e) => handleDrop(e, node.id)}
      onDragEnd={handleDragEnd}
      className={`cat-sidebar-drag-item${draggingId === node.id ? ' cat-sidebar-drag-item--dragging' : ''}${overId === node.id ? ' cat-sidebar-drag-item--over' : ''}`}
    >
      {renderItem(node, true)}
    </div>
  ));
}

function TreeBranch({
  node,
  depth,
  selectedPath,
  onSelectPath,
  isOpen,
  onToggle,
  ancestors,
  onEditNode,
  onDeleteNode,
  onAddChild,
  forceOpen,
  onReorderSiblings,
  showDragHandle = false,
  productCounts = {},
}) {
  const hasChildren = node.children?.length > 0;
  const pathHere = [...ancestors, node.id];
  const open = forceOpen || isOpen(node.id);

  return (
    <div className="cat-sidebar-node">
      <CategoryRow
        node={node}
        depth={depth}
        selectedPath={selectedPath}
        pathHere={pathHere}
        hasChildren={hasChildren}
        open={open}
        onToggle={() => onToggle(node.id)}
        onSelect={() => onSelectPath(pathHere)}
        nodeType="subcategory"
        onEditNode={onEditNode}
        onDeleteNode={onDeleteNode}
        onAddChild={onAddChild}
        showDragHandle={showDragHandle}
        productCount={productCounts[node.id]}
      />
      {hasChildren && open && (
        onReorderSiblings ? (
          <DraggableSiblingList
            nodes={node.children}
            parentId={node.id}
            onReorderSiblings={onReorderSiblings}
            renderItem={(child, showHandle) => (
              <TreeBranch
                key={child.id}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelectPath={onSelectPath}
                isOpen={isOpen}
                onToggle={onToggle}
                ancestors={pathHere}
                onEditNode={onEditNode}
                onDeleteNode={onDeleteNode}
                onAddChild={onAddChild}
                forceOpen={forceOpen}
                onReorderSiblings={onReorderSiblings}
                showDragHandle={showHandle}
                productCounts={productCounts}
              />
            )}
          />
        ) : (
          node.children.map((child) => (
            <TreeBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelectPath={onSelectPath}
              isOpen={isOpen}
              onToggle={onToggle}
              ancestors={pathHere}
              onEditNode={onEditNode}
              onDeleteNode={onDeleteNode}
              onAddChild={onAddChild}
              forceOpen={forceOpen}
              productCounts={productCounts}
            />
          ))
        )
      )}
    </div>
  );
}

function StackNavigation({
  tree,
  selectedPath,
  onSelectPath,
  onEditNode,
  onDeleteNode,
  onAddChild,
  filterQuery,
  displayTree,
  browsePath,
  setBrowsePath,
  onReorderSiblings,
  canDrag = false,
}) {
  const levelNodes = filterQuery ? displayTree : getCategoriesAtPath(tree, browsePath);
  const breadcrumbLabels = resolvePathLabels(tree, browsePath);
  const currentFolderLabel = breadcrumbLabels[breadcrumbLabels.length - 1] || '';
  const currentFilterPath = browsePath;

  const handleSelectRoot = (nodeId) => {
    const path = buildPathFromRoot(tree, nodeId) || [nodeId];
    onSelectPath(path);
  };

  const handleDrillIn = (pathHere) => {
    setBrowsePath(pathHere);
  };

  const renderStackRow = (node, pathHere, hasChildren, nodeType, showDragHandle = false) => (
    <div key={node.id} className="cat-sidebar-root">
      <CategoryRow
        node={node}
        depth={0}
        selectedPath={selectedPath}
        pathHere={pathHere}
        hasChildren={hasChildren}
        open={false}
        onToggle={() => {}}
        onSelect={() => (
          hasChildren
            ? handleDrillIn(pathHere)
            : onSelectPath(pathHere)
        )}
        onDrillIn={hasChildren ? () => handleDrillIn(pathHere) : undefined}
        nodeType={nodeType}
        onEditNode={onEditNode}
        onDeleteNode={onDeleteNode}
        onAddChild={onAddChild}
        stackMode
        showDragHandle={showDragHandle}
      />
    </div>
  );

  const stackParentId = browsePath.length ? browsePath[browsePath.length - 1] : null;
  const stackSiblings = filterQuery
    ? displayTree
    : (browsePath.length === 0 ? tree : levelNodes);

  const stackList = canDrag && onReorderSiblings && !filterQuery ? (
    <DraggableSiblingList
      nodes={stackSiblings}
      parentId={stackParentId}
      onReorderSiblings={onReorderSiblings}
      renderItem={(node, showHandle) => {
        const pathHere = browsePath.length === 0 ? [node.id] : [...browsePath, node.id];
        const hasChildren = !!node.children?.length;
        const nodeType = browsePath.length === 0 ? 'category' : 'subcategory';
        return renderStackRow(node, pathHere, hasChildren, nodeType, showHandle);
      }}
    />
  ) : null;

  return (
    <>
      {!filterQuery && browsePath.length === 0 && (
        <button
          type="button"
          className={`cat-sidebar-all${!selectedPath.length ? ' cat-sidebar-all--active' : ''}`}
          onClick={() => onSelectPath([])}
        >
          <FolderTree size={16} strokeWidth={2.2} />
          <span>All categories</span>
        </button>
      )}

      {!filterQuery && browsePath.length > 0 && (
        <div className="cat-sidebar-level-header">
          {currentFolderLabel && (
            <h3 className="cat-sidebar-level-title">{currentFolderLabel}</h3>
          )}
          <button
            type="button"
            className="cat-sidebar-level-filter"
            onClick={() => onSelectPath(currentFilterPath)}
          >
            Show products in {currentFolderLabel || 'this category'}
          </button>
        </div>
      )}

      {filterQuery ? (
        displayTree.map((node) => (
          <div key={node.id} className="cat-sidebar-root">
            <CategoryRow
              node={node}
              depth={0}
              selectedPath={selectedPath}
              pathHere={[node.id]}
              hasChildren={!!node.children?.length}
              open={false}
              onToggle={() => {}}
              onSelect={() => handleSelectRoot(node.id)}
              nodeType="category"
              onEditNode={onEditNode}
              onDeleteNode={onDeleteNode}
              onAddChild={onAddChild}
              stackMode
            />
          </div>
        ))
      ) : stackList || (browsePath.length === 0 ? (
        tree.map((node) => renderStackRow(
          node,
          [node.id],
          !!node.children?.length,
          'category',
        ))
      ) : (
        levelNodes.map((node) => renderStackRow(
          node,
          [...browsePath, node.id],
          !!node.children?.length,
          'subcategory',
        ))
      ))}
    </>
  );
}

/** Expandable category tree — up to 4 sub-levels under each main category. */
export default function CategorySidebar({
  tree = [],
  selectedPath = [],
  onSelectPath,
  showUncategorized = false,
  uncategorizedCount = 0,
  onEditNode,
  onDeleteNode,
  onAddChild,
  showSearch = true,
  variant = 'tree',
  className = '',
  isActive = true,
  onStackNavChange,
  onReorder,
  productCounts = {},
}) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [browsePath, setBrowsePath] = useState([]);
  const stackMode = variant === 'stack';

  const filterQuery = filter.trim().toLowerCase();
  const displayTree = useMemo(
    () => (filterQuery ? filterTree(tree, filterQuery) : tree),
    [tree, filterQuery],
  );

  useEffect(() => {
    if (!isActive) {
      setBrowsePath([]);
      setFilter('');
    }
  }, [isActive]);

  useEffect(() => {
    if (!stackMode || filterQuery) return;
    if (!selectedPath.length) {
      setBrowsePath([]);
      return;
    }
    setBrowsePath(selectedPath.slice(0, -1));
  }, [stackMode, filterQuery, selectedPath.join('|')]);

  useEffect(() => {
    if (!stackMode || !onStackNavChange) return;
    const parentPath = browsePath.slice(0, -1);
    const parentFolderLabel = parentPath.length
      ? resolvePathLabels(tree, parentPath).slice(-1)[0]
      : 'All categories';
    const currentFolderLabel = resolvePathLabels(tree, browsePath).slice(-1)[0] || '';
    onStackNavChange({
      canGoBack: browsePath.length > 0 && !filterQuery,
      parentFolderLabel,
      currentFolderLabel,
      goBack: () => setBrowsePath(parentPath),
    });
  }, [stackMode, browsePath, filterQuery, tree, onStackNavChange]);

  useEffect(() => {
    if (!selectedPath.length) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      selectedPath.forEach((id) => next.add(id));
      return next;
    });
    setCollapsed((prev) => {
      const next = new Set(prev);
      selectedPath.forEach((id) => next.delete(id));
      return next;
    });
  }, [selectedPath.join('|')]);

  useEffect(() => {
    if (!filterQuery) return;
    const ids = collectIds(displayTree);
    setExpanded((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    setCollapsed(new Set());
  }, [filterQuery, displayTree]);

  const isOpen = (id) => {
    if (filterQuery) return true;
    const isOnPath = selectedPath.includes(id);
    return (expanded.has(id) || isOnPath) && !collapsed.has(id);
  };

  const toggle = (id) => {
    if (filterQuery) return;
    const open = isOpen(id);
    if (open) {
      setCollapsed((prev) => new Set(prev).add(id));
    } else {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setExpanded((prev) => new Set(prev).add(id));
    }
  };

  const handleSelectRoot = (nodeId) => {
    const path = buildPathFromRoot(tree, nodeId) || [nodeId];
    onSelectPath(path);
  };

  // Called from DraggableSiblingList at any level. parentId=null means root.
  const handleReorderSiblings = (parentId, newSiblings) => {
    if (!onReorder) return;
    const newTree = parentId == null
      ? newSiblings
      : reorderChildrenInTree(tree, parentId, newSiblings);
    onReorder(newTree);
  };

  const canDrag = !!onReorder && !filterQuery;

  return (
    <div className={`cat-sidebar-wrap${stackMode ? ' cat-sidebar-wrap--stack' : ''}${className ? ` ${className}` : ''}`}>
      {showSearch && (
        <label className="cat-sidebar-search">
          <Search size={15} />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search categories…"
            className="cat-sidebar-search-input"
            aria-label="Search categories"
          />
        </label>
      )}

      <nav className="cat-sidebar" aria-label="Category filter">
        {!stackMode && (
        <button
          type="button"
          className={`cat-sidebar-all${!selectedPath.length ? ' cat-sidebar-all--active' : ''}`}
          onClick={() => onSelectPath([])}
        >
          <FolderTree size={16} strokeWidth={2.2} />
          <span>
            All categories
            {productCounts.__all__ > 0 && (
              <span className="cat-sidebar-count">{productCounts.__all__}</span>
            )}
          </span>
        </button>
        )}

        {showUncategorized && (
          <button
            type="button"
            className={`cat-sidebar-all cat-sidebar-all--sub${selectedPath[0] === '__uncategorized__' ? ' cat-sidebar-all--active' : ''}`}
            onClick={() => onSelectPath(['__uncategorized__'])}
          >
            <span>
              Uncategorized
              {(uncategorizedCount > 0 || productCounts.__uncategorized__ > 0) && (
                <span className="cat-sidebar-count">{uncategorizedCount || productCounts.__uncategorized__}</span>
              )}
            </span>
          </button>
        )}

        {stackMode ? (
          <StackNavigation
            tree={tree}
            selectedPath={selectedPath}
            onSelectPath={onSelectPath}
            onEditNode={onEditNode}
            onDeleteNode={onDeleteNode}
            onAddChild={onAddChild}
            filterQuery={filterQuery}
            displayTree={displayTree}
            browsePath={browsePath}
            setBrowsePath={setBrowsePath}
            onReorderSiblings={canDrag ? handleReorderSiblings : null}
            canDrag={canDrag}
          />
        ) : canDrag ? (
          <DraggableSiblingList
            nodes={displayTree}
            parentId={null}
            onReorderSiblings={handleReorderSiblings}
            renderItem={(node, showHandle) => (
              <div className="cat-sidebar-root">
                <CategoryRow
                  node={node}
                  depth={0}
                  selectedPath={selectedPath}
                  pathHere={[node.id]}
                  hasChildren={!!node.children?.length}
                  open={isOpen(node.id)}
                  onToggle={() => toggle(node.id)}
                  onSelect={() => handleSelectRoot(node.id)}
                  nodeType="category"
                  onEditNode={onEditNode}
                  onDeleteNode={onDeleteNode}
                  onAddChild={onAddChild}
                  showDragHandle={showHandle}
                  productCount={productCounts[node.id]}
                />
                {node.children?.length && isOpen(node.id) && (
                  <DraggableSiblingList
                    nodes={node.children}
                    parentId={node.id}
                    onReorderSiblings={handleReorderSiblings}
                    renderItem={(child, showChildHandle) => (
                      <TreeBranch
                        key={child.id}
                        node={child}
                        depth={1}
                        selectedPath={selectedPath}
                        onSelectPath={onSelectPath}
                        isOpen={isOpen}
                        onToggle={toggle}
                        ancestors={[node.id]}
                        onEditNode={onEditNode}
                        onDeleteNode={onDeleteNode}
                        onAddChild={onAddChild}
                        forceOpen={false}
                        onReorderSiblings={handleReorderSiblings}
                        showDragHandle={showChildHandle}
                        productCounts={productCounts}
                      />
                    )}
                  />
                )}
              </div>
            )}
          />
        ) : (
          displayTree.map((node) => (
            <div key={node.id} className="cat-sidebar-root">
              <CategoryRow
                node={node}
                depth={0}
                selectedPath={selectedPath}
                pathHere={[node.id]}
                hasChildren={!!node.children?.length}
                open={isOpen(node.id)}
                onToggle={() => toggle(node.id)}
                onSelect={() => handleSelectRoot(node.id)}
                nodeType="category"
                onEditNode={onEditNode}
                onDeleteNode={onDeleteNode}
                onAddChild={onAddChild}
                productCount={productCounts[node.id]}
              />
              {node.children?.length && isOpen(node.id) && node.children.map((child) => (
                <TreeBranch
                  key={child.id}
                  node={child}
                  depth={1}
                  selectedPath={selectedPath}
                  onSelectPath={onSelectPath}
                  isOpen={isOpen}
                  onToggle={toggle}
                  ancestors={[node.id]}
                  onEditNode={onEditNode}
                  onDeleteNode={onDeleteNode}
                  onAddChild={onAddChild}
                  forceOpen={!!filterQuery}
                />
              ))}
            </div>
          ))
        )}

        {filterQuery && !displayTree.length && (
          <p className="cat-sidebar-empty">No categories match &ldquo;{filter.trim()}&rdquo;</p>
        )}
      </nav>
    </div>
  );
}
