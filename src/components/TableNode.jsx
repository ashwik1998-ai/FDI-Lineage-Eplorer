import React, { memo, useState } from 'react';
import { Handle, Position } from 'reactflow';

const CALC_KEYWORDS = ['Avg','Total','Count','Rate','Amount','Margin','Sum','Pct','Percent','Ratio'];
const isCalcCol = (col) => CALC_KEYWORDS.some(k => col.includes(k));

const TableNode = ({ data }) => {
  const isPhysical    = data.type === 'Physical Table';
  const isExtensible  = data.isExtensible;
  const [collapsed, setCollapsed] = useState(false);

  const typeClass = isPhysical ? 'tnode-phys' : 'tnode-pres';
  const handleClass = isPhysical ? 'rf-handle rf-handle-phys' : 'rf-handle rf-handle-pres';

  return (
    <div className={`tnode ${typeClass} ${collapsed ? 'collapsed' : ''}`}>
      {/* ── Header (clickable to collapse) ── */}
      <div className="tnode-header" onClick={() => setCollapsed(p => !p)}>
        <div className="tnode-title-row">
          <span className="tnode-type-icon">{isPhysical ? '🗄️' : '📊'}</span>
          <span className="tnode-name" title={data.label}>
            {data.label?.split('.').pop() ?? data.label}
          </span>
          <span className="tnode-collapse-icon">▼</span>
        </div>
        <div className="tnode-meta">
          <span className="tnode-type-label">
            {isPhysical ? 'Physical Table' : 'Presentation Table'}
          </span>
          {isExtensible && <span className="tnode-ext-badge">🔌 Ext</span>}
          <span className="tnode-col-pill">{data.columns?.length ?? 0} cols</span>
        </div>
      </div>

      {/* ── Column rows ── */}
      <div className="tnode-cols">
        {(data.columns ?? []).map((col) => {
          const isCalc = !isPhysical && isCalcCol(col);
          const isActive = data.activeColumn === col;

          return (
            <div
              key={col}
              className={`tnode-col-row ${isActive ? 'col-active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                data.onColumnClick?.(col);
              }}
            >
              {/* Presentation table: target handle on RIGHT */}
              {!isPhysical && (
                <Handle
                  type="target"
                  position={Position.Right}
                  id={`col-${col}`}
                  className={handleClass}
                  style={{ right: -5 }}
                />
              )}

              <span className="tnode-col-icon">{isCalc ? 'ƒ' : '◆'}</span>
              <span className="tnode-col-name" title={col}>{col}</span>
              {isCalc && <span className="tnode-calc-badge">calc</span>}

              {/* Physical table: source handle on LEFT */}
              {isPhysical && (
                <Handle
                  type="source"
                  position={Position.Left}
                  id={`col-${col}`}
                  className={handleClass}
                  style={{ left: -5 }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Table-level handles (used for non-column-specific edges) */}
      {!isPhysical && (
        <Handle
          type="target"
          position={Position.Right}
          id="table-target"
          className={handleClass}
          style={{ right: -5, top: '50%' }}
        />
      )}
      {isPhysical && (
        <Handle
          type="source"
          position={Position.Left}
          id="table-source"
          className={handleClass}
          style={{ left: -5, top: '50%' }}
        />
      )}
    </div>
  );
};

export default memo(TableNode);
