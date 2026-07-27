import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactFlow, {
  ReactFlowProvider,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  MarkerType,
  useViewport,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { toPng } from 'html-to-image';
import TableNode from './components/TableNode';

// ─── Constants ───────────────────────────────────────────────────────────────
const nodeTypes = { tableNode: TableNode };
const RECENT_KEY = 'fdi_recent_v2';

// ─── Cache Version (bump this to invalidate all cached data after schema changes) ───
const CACHE_VERSION = 'v3';
const CACHE_PREFIX = `fdi_${CACHE_VERSION}_`;

// ─── sessionStorage-backed lineage cache ─────────────────────────────────────
// Survives browser refresh. Uses sessionStorage (cleared when tab/window closes).
// Falls back to a plain object if sessionStorage is unavailable or quota exceeded.
const _memFallback = {};

function ssGet(key) {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return _memFallback[key] || null; }
}

function ssSet(key, value) {
  try {
    sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
  } catch {
    // If sessionStorage is full, trim oldest entries and retry
    try {
      // Remove oldest half of our cache entries
      const ours = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(CACHE_PREFIX)) ours.push(k);
      }
      ours.slice(0, Math.ceil(ours.length / 2)).forEach(k => sessionStorage.removeItem(k));
      sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
    } catch {
      _memFallback[key] = value;
    }
  }
}

// ─── Per-request in-memory caches (survive within same tab session) ──────────
const matchCache = {};
const explanationCache = {};

// ─── Markdown Renderer Helper ────────────────────────────────────────────────
function renderMarkdown(md) {
  if (!md) return '';
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers
    .replace(/^### (.*$)/gim, '<h4 style="color:var(--primary);margin-top:18px;margin-bottom:8px;font-weight:700;font-size:13.5px;">$1</h4>')
    .replace(/^## (.*$)/gim, '<h3 style="color:var(--text-h);margin-top:22px;margin-bottom:10px;font-weight:700;font-size:15px;border-bottom:1px solid var(--border);padding-bottom:4px;width:100%;">$1</h3>')
    .replace(/^# (.*$)/gim, '<h2 style="color:var(--text-h);margin-top:26px;margin-bottom:12px;font-weight:800;font-size:17px;width:100%;">$1</h2>')
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--text-h);font-weight:700;">$1</strong>')
    // Code blocks
    .replace(/`(.*?)`/g, '<code style="background:rgba(0,0,0,0.2);padding:2px 6px;border-radius:4px;font-family:var(--font-mono);font-size:11.5px;color:var(--primary);">$1</code>')
    // Lists
    .replace(/^\s*-\s+(.*$)/gim, '<li style="margin-left:16px;margin-bottom:6px;list-style-type:disc;color:var(--text-body);">$1</li>')
    .replace(/^\s*\*\s+(.*$)/gim, '<li style="margin-left:16px;margin-bottom:6px;list-style-type:disc;color:var(--text-body);">$1</li>')
    .replace(/^\s*\d+\.\s+(.*$)/gim, '<li style="margin-left:16px;margin-bottom:6px;list-style-type:decimal;color:var(--text-body);">$1</li>')
    // Line breaks
    .replace(/\n/g, '<br/>');

  return <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%' }} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const getRecent   = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
const pushRecent  = (item) => {
  const prev = getRecent().filter(r => r.slug !== item.slug);
  localStorage.setItem(RECENT_KEY, JSON.stringify([item, ...prev].slice(0, 5)));
};
const shortName   = (fullName = '') => fullName.split('.').pop() ?? fullName;
const slugify     = (s = '') => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const parsePvoPlan = (planText) => {
  if (!planText) return { intro: '', pvos: [], guide: '' };
  const result = { intro: '', pvos: [], guide: '' };
  
  // Split content by PVO sections
  const parts = planText.split(/###\s*PVO\s*/i);
  if (parts.length <= 1) {
    result.intro = planText;
    return result;
  }
  
  result.intro = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    let detailsText = part;
    let guideText = '';
    
    // Split guide if it's inside this part
    const guideMatch = part.split(/###\s*(Sandbox|FDI Sandbox|Guide|Sandbox Framework Guide)/i);
    if (guideMatch.length > 1) {
      detailsText = guideMatch[0];
      guideText = '### ' + guideMatch.slice(1).join('');
      result.guide = guideText;
    }
    
    const firstLineEnd = detailsText.indexOf('\n');
    const firstLine = firstLineEnd !== -1 ? detailsText.substring(0, firstLineEnd) : detailsText;
    const rankMatch = firstLine.match(/^(\d+)[\s:]*([^\n]+)/);
    const rank = rankMatch ? rankMatch[1] : String(i);
    const name = rankMatch ? rankMatch[2].trim() : firstLine.trim();
    
    let score = '90%';
    const scoreMatch = detailsText.match(/\*\*Match Score:\s*([^*\n]+)\*\*/i);
    if (scoreMatch) {
      score = scoreMatch[1].trim();
    }
    
    result.pvos.push({
      rank,
      name,
      score,
      details: '### PVO ' + firstLine + '\n' + (firstLineEnd !== -1 ? detailsText.substring(firstLineEnd + 1) : '')
    });
  }
  
  return result;
};

const extractField = (text = '', label) => {
  if (!text) return '';
  let regexes = [];
  if (label === 'pattern') {
    regexes = [
      /-\s*\*\*Extensibility\s+Pattern:\*\*\s*([^\n]+)/i,
      /Extensibility\s+Pattern\s*[:*-\s]+([^\n]+)/i,
      /\*\*Extensibility\s+Pattern\*\*:\s*([^\n]+)/i
    ];
  } else if (label === 'table') {
    regexes = [
      /-\s*\*\*Target\s+FDI\s+Warehouse\s+Table:\*\*\s*([^\n]+)/i,
      /Target\s+FDI\s+(Warehouse\s+)?Table\s*[:*-\s]+([^\n]+)/i,
      /\*\*Target\s+FDI\s+Warehouse\s+Table\*\*:\s*([^\n]+)/i
    ];
  } else if (label === 'key') {
    regexes = [
      /-\s*\*\*Join\s+Key:\*\*\s*([^\n]+)/i,
      /Join\s+Key\s*[:*-\s]+([^\n]+)/i,
      /\*\*Join\s+Key\*\*:\s*([^\n]+)/i
    ];
  }
  for (const r of regexes) {
    const match = text.match(r);
    if (match) return match[1].replace(/[*_`]/g, '').trim();
  }
  return '';
};

function SearchableSelect({ options, value, onChange, placeholder, style }) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);

  const selectedOption = options.find(o => o.value === value);
  const displayLabel = selectedOption ? selectedOption.label : '';

  const filtered = options.filter(o => 
    o.label.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
        setSearch('');
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', minWidth: '220px', ...style }}>
      <div 
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) setSearch('');
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          background: 'var(--bg-card, #181C27)',
          border: isOpen ? '1px solid var(--primary)' : '1px solid var(--border-md, #374151)',
          borderRadius: '8px',
          cursor: 'pointer',
          color: 'var(--text-h)',
          fontSize: '13px',
          height: '38px',
          boxSizing: 'border-box',
          boxShadow: isOpen ? '0 0 0 2px var(--primary-bg)' : 'none',
          transition: 'all 0.15s'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
          {isOpen ? (
            <>
              <span style={{ fontSize: '12px', color: 'var(--primary)', flexShrink: 0 }}>🔍</span>
              <input 
                type="text"
                autoFocus
                value={search}
                placeholder="Type to filter..."
                onChange={(e) => setSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-h)',
                  outline: 'none',
                  width: '100%',
                  fontSize: '13px',
                  padding: '0'
                }}
              />
            </>
          ) : (
            <span style={{ 
              whiteSpace: 'nowrap', 
              overflow: 'hidden', 
              textOverflow: 'ellipsis',
              flex: 1,
              color: selectedOption ? 'var(--text-h)' : 'var(--text-muted)'
            }}>
              {displayLabel || placeholder || 'Select...'}
            </span>
          )}
        </div>
        <span style={{ fontSize: '9px', color: 'var(--text-faint)', marginLeft: '8px', flexShrink: 0 }}>{isOpen ? '▲' : '▼'}</span>
      </div>

      {isOpen && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: '0',
          right: '0',
          background: '#181C27',
          border: '1px solid rgba(255, 255, 255, 0.15)',
          borderRadius: '8px',
          maxHeight: '220px',
          overflowY: 'auto',
          zIndex: 99999,
          boxShadow: '0 12px 32px rgba(0,0,0,0.85)',
          padding: '4px'
        }}>
          {filtered.length > 0 ? (
            filtered.map((opt) => (
              <div
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  setIsOpen(false);
                  setSearch('');
                }}
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '12.5px',
                  color: opt.value === value ? '#fff' : 'var(--text-h)',
                  background: opt.value === value ? 'var(--primary)' : 'transparent',
                  transition: 'background 0.1s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}
                onMouseEnter={(e) => {
                  if (opt.value !== value) {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (opt.value !== value) {
                    e.currentTarget.style.background = 'transparent';
                  }
                }}
              >
                {opt.label}
              </div>
            ))
          ) : (
            <div style={{ padding: '10px 12px', color: 'var(--text-faint)', fontSize: '12.5px', textAlign: 'center' }}>
              No matching subject areas found
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function exportCSV(mappings, saName) {
  const header = 'Subject Area,Presentation Table,Presentation Column,Physical Table,Physical Column\n';
  const rows   = mappings.map(m =>
    [saName, m.presentationTable, m.presentationColumn, m.physicalTable, m.physicalColumn]
      .map(v => `"${(v || '').replace(/"/g, '""')}"`)
      .join(',')
  ).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url; a.download = `${saName}_lineage.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ─── Pillar Stats Bar ────────────────────────────────────────────────────────
function PillarStatsBar({ subjectAreas }) {
  const stats = useMemo(() => {
    const c = { ERP: 0, HCM: 0, SCM: 0, CX: 0 };
    subjectAreas.forEach(sa => (sa.pillars || [sa.pillar]).forEach(p => { if (p in c) c[p]++; }));
    return c;
  }, [subjectAreas]);

  return (
    <div className="stats-bar">
      <div className="stat-pill stat-pill-erp">
        <span className="stat-pill-icon">⚙️</span>
        <span className="stat-pill-label">ERP</span>
        <span className="stat-pill-count">{stats.ERP}</span>
      </div>
      <div className="stat-pill stat-pill-hcm">
        <span className="stat-pill-icon">👥</span>
        <span className="stat-pill-label">HCM</span>
        <span className="stat-pill-count">{stats.HCM}</span>
      </div>
      <div className="stat-pill stat-pill-scm">
        <span className="stat-pill-icon">🔗</span>
        <span className="stat-pill-label">SCM</span>
        <span className="stat-pill-count">{stats.SCM}</span>
      </div>
      <div className="stat-pill stat-pill-cx">
        <span className="stat-pill-icon">💡</span>
        <span className="stat-pill-label">CX</span>
        <span className="stat-pill-count">{stats.CX}</span>
      </div>
      <div className="stat-pill stat-pill-total">
        <span className="stat-pill-icon">🧬</span>
        <span className="stat-pill-label">Total</span>
        <span className="stat-pill-count">{subjectAreas.length}</span>
      </div>
    </div>
  );
}

// ─── Zoom Badge (must be inside ReactFlow context) ───────────────────────────
function ZoomBadge() {
  const { zoom } = useViewport();
  return (
    <>
      <div className="zoom-badge">{Math.round(zoom * 100)}%</div>
      <div className="pan-hint">Scroll = Zoom · Drag = Pan</div>
    </>
  );
}

// ─── Flow Canvas Inner ───────────────────────────────────────────────────────
function FlowCanvas({ nodes, edges, nodeTypes }) {
  return (
    <div style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        minZoom={0.05}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <MiniMap
          nodeStrokeColor={n => n.data?.type === 'Physical Table' ? '#6366F1' : '#F97316'}
          nodeColor={() => 'rgba(255,255,255,0.9)'}
          maskColor="rgba(0,0,0,0.08)"
          className="flow-minimap"
        />
        <Controls className="flow-controls" showInteractive={false} />
        <Background variant={BackgroundVariant.Dots} color="#D1D5DB" gap={20} size={1} />
        <ZoomBadge />
      </ReactFlow>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//   MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  // ── Core workspace & state ──────────────────────────────────────────────────
  const [workspace,       setWorkspace]       = useState('fdi'); // 'fdi' | 'otbi'
  const [subjectAreas,    setSubjectAreas]    = useState([]);
  const [otbiSubjectAreas, setOtbiSubjectAreas] = useState([]);
  
  // FDI workspace selections
  const [selectedPillar,  setSelectedPillar]  = useState('all');
  const [selectedSA,      setSelectedSA]      = useState('');
  const [selectedPresTable, setSelectedPresTable] = useState(null);
  const [sidebarSearch,   setSidebarSearch]   = useState('');

  // OTBI workspace selections
  const [selectedOtbiArea,  setSelectedOtbiArea]  = useState('all'); // 'all' | 'finance' | 'hcm' | 'scm' | 'cx' | 'project'
  const [selectedOtbiSA,    setSelectedOtbiSA]    = useState('');
  const [selectedOtbiTable, setSelectedOtbiTable] = useState(null);
  const [otbiSidebarSearch, setOtbiSidebarSearch] = useState('');


  // Raw API data — plain state, NOT ReactFlow state (prevents feedback loop)
  const [nodes,    setNodes]    = useState([]);
  const [edges,    setEdges]    = useState([]);
  const [mappings, setMappings] = useState([]);
  const [activeColumn, setActiveColumn] = useState(null); // { tableId, colName }

  // UI
  const [darkMode,       setDarkMode]       = useState(true);
  const [searchOpen,     setSearchOpen]     = useState(false);
  const [searchQuery,    setSearchQuery]     = useState('');
  const [searchResults,  setSearchResults]   = useState([]);
  const [searchLoading,  setSearchLoading]   = useState(false);
  const [metricDetails,  setMetricDetails]   = useState(null);
  const [aiExplanation,  setAiExplanation]   = useState('');
  const [aiExplainLoading, setAiExplainLoading] = useState(false);
  const [drawerTab,      setDrawerTab]       = useState('mappings'); // 'mappings' | 'explain'

  // OTBI AI Match states
  const [aiMatchedFdi,       setAiMatchedFdi]       = useState([]); // Structured array
  const [aiMatchedFdiError,  setAiMatchedFdiError]  = useState('');
  const [exactMatchedFdi,    setExactMatchedFdi]    = useState([]);
  const [aiMatchedFdiLoading, setAiMatchedFdiLoading] = useState(false);
  const [otbiDrawerTab,      setOtbiDrawerTab]      = useState('mappings'); // 'mappings' | 'grok'

  const [recentlyViewed, setRecentlyViewed]  = useState(getRecent);
  const [focusedIdx,     setFocusedIdx]      = useState(-1);

  // Compare
  const [compareMode,   setCompareMode]   = useState(false);
  const [compareSA,     setCompareSA]     = useState('');
  const [cmpNodes,      setCmpNodes]      = useState([]);
  const [cmpEdges,      setCmpEdges]      = useState([]);
  const [cmpMappings,   setCmpMappings]   = useState([]);
  const [cmpPresTable,  setCmpPresTable]  = useState(null);

  // PVO Finder states
  const [pvoOtbiSA,      setPvoOtbiSA]      = useState('');
  const [pvoFdiSA,       setPvoFdiSA]       = useState('');
  const [pvoExplanation, setPvoExplanation] = useState('');
  const [pvoResult,      setPvoResult]      = useState('');
  const [pvoLoading,     setPvoLoading]     = useState(false);
  const [pvoError,       setPvoError]       = useState('');
  const [pvoStepIndex,   setPvoStepIndex]   = useState(0);
  const [pvoCards,       setPvoCards]       = useState([]); // Parsed PVO scorecard items
  const [selectedPvoIdx, setSelectedPvoIdx] = useState(0); // Currently selected PVO index

  // AI Engine states
  const [aiProvider, setAiProvider] = useState(() => localStorage.getItem('fdi_ai_provider') || 'gemini');
  const [customApiKey, setCustomApiKey] = useState(() => localStorage.getItem('fdi_custom_api_key') || '');
  const [useCustomKey, setUseCustomKey] = useState(() => localStorage.getItem('fdi_use_custom_key') === 'true');
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [serverAiConfig, setServerAiConfig] = useState({ geminiConfigured: true, grokConfigured: true, defaultProvider: 'gemini' });

  // Chatbot states
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([
    {
      role: 'assistant',
      content: '👋 Hi! I am your **Oracle Enterprise Analytics AI Consultant**.\n\nAsk me anything about **FDI (FAW)**, **OAC**, **OTBI**, **OCI Services (ADW, GoldenGate, OIC)**, or **Fusion ERP/HCM/SCM/CX PVO Data Extensibility**!',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  const scrollToChatBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (chatOpen) scrollToChatBottom();
  }, [chatMessages, chatOpen]);

  const handleSendChatMessage = async (textToSend) => {
    const query = (textToSend || chatInput).trim();
    if (!query || chatLoading) return;

    const userMsg = {
      role: 'user',
      content: query,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    const newMessages = [...chatMessages, userMsg];
    setChatMessages(newMessages);
    setChatInput('');
    setChatLoading(true);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages.map(m => ({ role: m.role, content: m.content })),
          provider: aiProvider,
          customApiKey: useCustomKey ? customApiKey : ''
        })
      }).then(r => r.json());

      if (res.error) throw new Error(res.error);

      setChatMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: res.reply || 'No response returned.',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ]);
    } catch (err) {
      setChatMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: `⚠️ Error: ${err.message}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const parsedPlan = useMemo(() => {
    return parsePvoPlan(pvoResult);
  }, [pvoResult]);

  // ── Init + URL restore ──────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const data = await fetch('/api/subject-areas').then(r => r.json());
        setSubjectAreas(data);

        const otbiData = await fetch('/api/otbi/subject-areas').then(r => r.json()).catch(() => []);
        setOtbiSubjectAreas(otbiData);

        if (otbiData.length) {
          setPvoOtbiSA(otbiData[0].name);
        }
        if (data.length) {
          setPvoFdiSA(data[0].name);
        }

        const p = new URLSearchParams(window.location.search);
        const urlSA = p.get('sa');
        const urlFolder = p.get('folder') || p.get('table');
        const urlWS = p.get('ws') || p.get('workspace') || 'fdi';
        setWorkspace(urlWS);

        if (urlWS === 'otbi') {
          if (urlSA && otbiData.find(x => x.slug === urlSA)) {
            setSelectedOtbiSA(urlSA);
            if (urlFolder) setSelectedOtbiTable(decodeURIComponent(urlFolder));
          } else if (otbiData.length) {
            setSelectedOtbiSA(otbiData[0].slug);
          }
        } else {
          if (urlSA && data.find(x => x.slug === urlSA)) {
            setSelectedSA(urlSA);
            if (urlFolder) setSelectedPresTable(decodeURIComponent(urlFolder));
          } else if (data.length) {
            setSelectedSA(data[0].slug);
          }
        }
      } catch (e) { console.error('Init failed', e); }
    })();
  }, []);

  // ── URL sync ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const p = new URLSearchParams();
    p.set('ws', workspace);
    if (workspace === 'otbi') {
      if (selectedOtbiSA) p.set('sa', selectedOtbiSA);
      if (selectedOtbiTable) p.set('folder', encodeURIComponent(selectedOtbiTable));
    } else {
      if (selectedSA) p.set('sa', selectedSA);
      if (selectedPresTable) p.set('folder', encodeURIComponent(selectedPresTable));
    }
    window.history.replaceState({}, '', '?' + p.toString());
  }, [workspace, selectedSA, selectedPresTable, selectedOtbiSA, selectedOtbiTable]);

  // ── Load lineage (FDI) ────────────────────────────────────────────────────────
  useEffect(() => {
    if (workspace !== 'fdi' || !selectedSA) return;

    // 1. Check sessionStorage first (survives refresh even after server restart)
    const cached = ssGet(`fdi_${selectedSA}`);
    if (cached) {
      setNodes(cached.nodes);
      setEdges(cached.edges);
      setMappings(cached.mappings);
      setActiveColumn(null);
      setMetricDetails(null);
      setSelectedPresTable(null);
      return;
    }

    setNodes([]); setEdges([]); setMappings([]);
    setActiveColumn(null); setMetricDetails(null); setSelectedPresTable(null);

    (async () => {
      try {
        const data = await fetch(`/api/lineage/${selectedSA}`).then(r => r.json());
        const nodesList = data.nodes || [];
        const edgesList = data.edges || [];
        const mappingsList = data.mappings || [];
        
        // Store in sessionStorage so refresh = 0 DB reads
        ssSet(`fdi_${selectedSA}`, { nodes: nodesList, edges: edgesList, mappings: mappingsList });
        
        setNodes(nodesList);
        setEdges(edgesList);
        setMappings(mappingsList);
        
        const sa = subjectAreas.find(x => x.slug === selectedSA);
        if (sa) { pushRecent({ slug: sa.slug, name: sa.name, pillar: sa.pillar }); setRecentlyViewed(getRecent()); }
      } catch (e) { console.error('Lineage load failed', e); }
    })();
  }, [workspace, selectedSA, subjectAreas]);

  // ── Load lineage (OTBI) ───────────────────────────────────────────────────────
  useEffect(() => {
    if (workspace !== 'otbi' || !selectedOtbiSA) return;

    // 1. Check sessionStorage first
    const cached = ssGet(`otbi_${selectedOtbiSA}`);
    if (cached) {
      setNodes(cached.nodes);
      setEdges(cached.edges);
      setMappings(cached.mappings);
      setActiveColumn(null);
      setMetricDetails(null);
      setSelectedOtbiTable(null);
      return;
    }

    setNodes([]); setEdges([]); setMappings([]);
    setActiveColumn(null); setMetricDetails(null); setSelectedOtbiTable(null);

    (async () => {
      try {
        const data = await fetch(`/api/otbi/lineage/${selectedOtbiSA}`).then(r => r.json());
        const nodesList = data.nodes || [];
        const edgesList = data.edges || [];
        const mappingsList = data.mappings || [];
        
        // Store in sessionStorage so refresh = 0 DB reads
        ssSet(`otbi_${selectedOtbiSA}`, { nodes: nodesList, edges: edgesList, mappings: mappingsList });
        
        setNodes(nodesList);
        setEdges(edgesList);
        setMappings(mappingsList);
      } catch (e) { console.error('OTBI lineage load failed', e); }
    })();
  }, [workspace, selectedOtbiSA]);

  // ── Load compare lineage ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!compareMode || !compareSA) return;

    const cached = ssGet(`fdi_${compareSA}`);
    if (cached) {
      setCmpNodes(cached.nodes);
      setCmpEdges(cached.edges);
      setCmpMappings(cached.mappings);
      setCmpPresTable(null);
      return;
    }

    setCmpNodes([]); setCmpEdges([]); setCmpMappings([]); setCmpPresTable(null);
    (async () => {
      try {
        const data = await fetch(`/api/lineage/${compareSA}`).then(r => r.json());
        const nodesList = data.nodes || [];
        const edgesList = data.edges || [];
        const mappingsList = data.mappings || [];
        
        ssSet(`fdi_${compareSA}`, { nodes: nodesList, edges: edgesList, mappings: mappingsList });
        
        setCmpNodes(nodesList);
        setCmpEdges(edgesList);
        setCmpMappings(mappingsList);
      } catch {}
    })();
  }, [compareSA, compareMode]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  useEffect(() => {
    const handle = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setSearchOpen(p => !p); return; }
      if (e.key === 'Escape') { setSearchOpen(false); setActiveColumn(null); setMetricDetails(null); return; }
      if (!searchOpen) {
        if (e.key === 'ArrowDown')  { e.preventDefault(); setFocusedIdx(p => Math.min(p + 1, filteredFolders.length - 1)); }
        if (e.key === 'ArrowUp')    { e.preventDefault(); setFocusedIdx(p => Math.max(p - 1, 0)); }
        if (e.key === 'Enter' && focusedIdx >= 0) setSelectedPresTable(filteredFolders[focusedIdx]?.name);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [searchOpen, focusedIdx]);

  // ── Global search ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!searchOpen) { setSearchResults([]); return; }
    const q = searchQuery.toLowerCase();
    if (searchQuery.length < 2) {
      setSearchResults(subjectAreas.filter(sa => sa.name.toLowerCase().includes(q)).slice(0, 8)
        .map(sa => ({ type: 'Subject Area', label: sa.name, pillar: sa.pillar, action: () => { setSelectedSA(sa.slug); } })));
      return;
    }
    setSearchLoading(true);
    const t = setTimeout(async () => {
      try {
        const data = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`).then(r => r.json());
        const colResults = data.slice(0, 10).map(d => ({
          type: 'Column', label: d.presColumn,
          sub: `${d.subjectArea} › ${shortName(d.presTable)}`,
          pillar: d.pillar,
          action: () => { setSelectedSA(d.subjectAreaSlug); setTimeout(() => setSelectedPresTable(d.presTable), 400); }
        }));
        const saResults = subjectAreas.filter(sa => sa.name.toLowerCase().includes(q)).slice(0, 4)
          .map(sa => ({ type: 'Subject Area', label: sa.name, pillar: sa.pillar, action: () => setSelectedSA(sa.slug) }));
        setSearchResults([...saResults, ...colResults]);
      } catch { setSearchResults([]); }
      finally { setSearchLoading(false); }
    }, 280);
    return () => clearTimeout(t);
  }, [searchQuery, searchOpen, subjectAreas]);

  // ── Filtered subject areas ────────────────────────────────────────────────────
  const filteredSAs = useMemo(() =>
    subjectAreas.filter(sa => selectedPillar === 'all' || sa.pillar === selectedPillar || (sa.pillars || []).includes(selectedPillar)),
    [subjectAreas, selectedPillar]);

  const filteredOtbiSAs = useMemo(() => {
    if (selectedOtbiArea === 'all') return otbiSubjectAreas;
    return otbiSubjectAreas.filter(sa => {
      const table = sa.sourceTable;
      if (selectedOtbiArea === 'finance' && table === '"OTBI-Finance"') return true;
      if (selectedOtbiArea === 'hcm' && table === '"OTBI-HCM"') return true;
      if (selectedOtbiArea === 'scm' && table === '"OTBI-SCM"') return true;
      if (selectedOtbiArea === 'cx' && table === '"OTBI-CX"') return true;
      if (selectedOtbiArea === 'project' && table === '"OTBI-Project"') return true;
      return false;
    });
  }, [otbiSubjectAreas, selectedOtbiArea]);

  // ── Presentation folders from loaded nodes ────────────────────────────────────
  const presFolders = useMemo(() =>
    nodes
      .filter(n => n.data?.type === 'Presentation Table')
      .map(n => ({ name: n.id, colCount: n.data?.columns?.length || 0 }))
      .sort((a, b) => shortName(a.name).localeCompare(shortName(b.name))),
    [nodes]);

  const filteredFolders = useMemo(() => {
    const q = (workspace === 'otbi' ? otbiSidebarSearch : sidebarSearch).toLowerCase();
    if (!q) return presFolders;
    return presFolders.filter(f => {
      const matchTable = f.name.toLowerCase().includes(q);
      if (matchTable) return true;
      
      const nodeObj = nodes.find(n => n.id === f.name);
      const columns = nodeObj?.data?.columns || [];
      return columns.some(col => col.toLowerCase().includes(q));
    });
  }, [workspace, presFolders, sidebarSearch, otbiSidebarSearch, nodes]);

  // ── Compare folders ───────────────────────────────────────────────────────────
  const cmpFolders = useMemo(() =>
    cmpNodes.filter(n => n.data?.type === 'Presentation Table')
      .map(n => ({ name: n.id, colCount: n.data?.columns?.length || 0 }))
      .sort((a, b) => shortName(a.name).localeCompare(shortName(b.name))),
    [cmpNodes]);

  // ── Build processedNodes: Presentation LEFT, Physical RIGHT ───────────────────
  const processedNodes = useMemo(() => {
    if (workspace === 'otbi') {
      if (!selectedOtbiTable) return [];
      const presRaw = nodes.find(n => n.id === selectedOtbiTable);
      return [{
        id: selectedOtbiTable,
        type: 'tableNode',
        position: { x: 150, y: 40 },
        data: {
          ...(presRaw?.data || { label: selectedOtbiTable, type: 'Presentation Table', columns: [] }),
          label: selectedOtbiTable,
          activeColumn: activeColumn?.tableId === selectedOtbiTable ? activeColumn.colName : null,
          onColumnClick: (col) => handleColumnClick(selectedOtbiTable, col),
        }
      }];
    }

    if (!selectedPresTable) return [];

    const physSet = new Set(
      mappings.filter(m => m.presentationTable === selectedPresTable).map(m => m.physicalTable)
    );

    const result = [];

    const presRaw = nodes.find(n => n.id === selectedPresTable);
    const physCount = physSet.size;
    const presY = Math.max(0, (physCount * 140 - (presRaw?.data?.columns?.length || 0) * 22) / 2);

    result.push({
      id: selectedPresTable,
      type: 'tableNode',
      position: { x: 0, y: presY },
      data: {
        ...(presRaw?.data || { label: selectedPresTable, type: 'Presentation Table', columns: [] }),
        label: selectedPresTable,
        activeColumn: activeColumn?.tableId === selectedPresTable ? activeColumn.colName : null,
        onColumnClick: (col) => handleColumnClick(selectedPresTable, col),
      },
    });

    let yIdx = 0;
    physSet.forEach(physId => {
      const physRaw = nodes.find(n => n.id === physId);
      const fallbackCols = physRaw
        ? null
        : [...new Set(mappings.filter(m => m.physicalTable === physId && m.presentationTable === selectedPresTable).map(m => m.physicalColumn))];

      result.push({
        id: physId,
        type: 'tableNode',
        position: { x: 620, y: yIdx * 140 },
        data: {
          ...(physRaw?.data || { label: physId, type: 'Physical Table', columns: fallbackCols || [], isExtensible: false }),
          label: physId,
          activeColumn: activeColumn
            ? mappings.find(m => m.physicalTable === physId && m.presentationTable === selectedPresTable &&
                (m.presentationColumn === activeColumn.colName || m.physicalColumn === activeColumn.colName))
              ? activeColumn.tableId !== selectedPresTable
                ? mappings.find(m => m.physicalTable === physId && m.physicalColumn === activeColumn.colName)?.physicalColumn
                : mappings.find(m => m.physicalTable === physId && m.presentationColumn === activeColumn.colName)?.physicalColumn
              : null
            : null,
          onColumnClick: (col) => handleColumnClick(physId, col),
        },
      });
      yIdx++;
    });

    return result;
  }, [workspace, selectedPresTable, selectedOtbiTable, nodes, mappings, activeColumn]);

  // ── Build processedEdges ──────────────────────────────────────────────────────
  const processedEdges = useMemo(() => {
    if (workspace === 'otbi') {
      return [];
    }

    if (!selectedPresTable) return [];

    const physSet = new Set(
      mappings.filter(m => m.presentationTable === selectedPresTable).map(m => m.physicalTable)
    );

    if (activeColumn) {
      let activeMappings;
      if (activeColumn.tableId === selectedPresTable) {
        activeMappings = mappings.filter(m =>
          m.presentationTable === selectedPresTable && m.presentationColumn === activeColumn.colName
        );
      } else {
        activeMappings = mappings.filter(m =>
          m.physicalTable === activeColumn.tableId &&
          m.physicalColumn === activeColumn.colName &&
          m.presentationTable === selectedPresTable
        );
      }
      return activeMappings.map((m, i) => ({
        id: `col-edge-${i}`,
        source: m.physicalTable,
        target: m.presentationTable,
        sourceHandle: `col-${m.physicalColumn}`,
        targetHandle: `col-${m.presentationColumn}`,
        animated: true,
        style: { stroke: '#F97316', strokeWidth: 3 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#F97316' },
      }));
    }

    return Array.from(physSet).map((phys, i) => ({
      id: `tbl-edge-${i}`,
      source: phys,
      target: selectedPresTable,
      sourceHandle: 'table-source',
      targetHandle: 'table-target',
      animated: false,
      style: { stroke: '#F97316', strokeWidth: 2, opacity: 0.7 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#F97316' },
    }));
  }, [workspace, selectedPresTable, selectedOtbiTable, mappings, activeColumn]);

  // ── Column click handler ────────────────────────────────────────────────────
  const handleColumnClick = useCallback((tableId, colName) => {
    setActiveColumn(prev => {
      const isDeselect = prev?.tableId === tableId && prev?.colName === colName;
      if (isDeselect) {
        setMetricDetails(null);
        setAiExplanation('');
        setAiMatchedFdi([]);
        setAiMatchedFdiError('');
        setExactMatchedFdi([]);
        return null;
      }

      if (workspace === 'otbi') {
        if (tableId === selectedOtbiTable) {
          const matches = mappings.filter(
            m => m.presentationTable === tableId && m.presentationColumn === colName
          );
          setMetricDetails({
            name: colName,
            tableName: tableId,
            mappings: matches.map(m => ({
              physicalTable: m.pvoName,
              physicalColumn: m.pvoAttribute
            }))
          });
          setAiMatchedFdi([]);
          setAiMatchedFdiError('');
          setExactMatchedFdi([]);
          setOtbiDrawerTab('mappings');
        } else {
          setMetricDetails(null);
          setAiMatchedFdi([]);
          setAiMatchedFdiError('');
          setExactMatchedFdi([]);
        }
      } else {
        if (tableId === selectedPresTable) {
          const matches = mappings.filter(
            m => m.presentationTable === tableId && m.presentationColumn === colName
          );
          setMetricDetails({
            name: colName,
            tableName: tableId,
            mappings: matches
          });
          setAiExplanation('');
          setDrawerTab('mappings');
        } else {
          setMetricDetails(null);
          setAiExplanation('');
        }
      }

      return { tableId, colName };
    });
  }, [workspace, selectedPresTable, selectedOtbiTable, mappings]);


  // ── Compare processed nodes & edges ──────────────────────────────────────────
  const cmpProcessedNodes = useMemo(() => {
    if (!cmpPresTable) return [];
    const physSet = new Set(cmpMappings.filter(m => m.presentationTable === cmpPresTable).map(m => m.physicalTable));
    const result = [];
    const presRaw = cmpNodes.find(n => n.id === cmpPresTable);
    result.push({
      id: cmpPresTable, type: 'tableNode',
      position: { x: 0, y: physSet.size * 60 },
      data: { ...(presRaw?.data || { label: cmpPresTable, type: 'Presentation Table', columns: [] }) },
    });
    let yi = 0;
    physSet.forEach(pid => {
      const physRaw = cmpNodes.find(n => n.id === pid);
      result.push({
        id: pid, type: 'tableNode',
        position: { x: 620, y: yi * 140 },
        data: { ...(physRaw?.data || { label: pid, type: 'Physical Table', columns: [] }) },
      });
      yi++;
    });
    return result;
  }, [cmpPresTable, cmpNodes, cmpMappings]);

  const cmpProcessedEdges = useMemo(() => {
    if (!cmpPresTable) return [];
    return [...new Set(cmpMappings.filter(m => m.presentationTable === cmpPresTable).map(m => m.physicalTable))]
      .map((phys, i) => ({
        id: `cmp-edge-${i}`, source: phys, target: cmpPresTable,
        sourceHandle: 'table-source', targetHandle: 'table-target',
        style: { stroke: '#6366F1', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#6366F1' },
      }));
  }, [cmpPresTable, cmpMappings]);

  // ── PNG Export ────────────────────────────────────────────────────────────────
  const handleExportPNG = () => {
    const el = document.querySelector('.react-flow__renderer');
    if (!el) return;
    toPng(el, { backgroundColor: '#F3F4F6', pixelRatio: 2 })
      .then(url => { const a = document.createElement('a'); a.href = url; a.download = `${shortName(selectedPresTable)}.png`; a.click(); })
      .catch(console.error);
  };

  // ── SA change ────────────────────────────────────────────────────────────────
  const handlePillarChange = (e) => {
    const pillar = e.target.value;
    setSelectedPillar(pillar);
    const matched = subjectAreas.filter(sa => pillar === 'all' || sa.pillar === pillar || (sa.pillars || []).includes(pillar));
    if (matched.length) setSelectedSA(matched[0].slug);
  };

  const handleOtbiAreaChange = (e) => {
    const area = e.target.value;
    setSelectedOtbiArea(area);
    const matched = otbiSubjectAreas.filter(sa => {
      if (area === 'all') return true;
      const table = sa.sourceTable;
      if (area === 'finance' && table === '"OTBI-Finance"') return true;
      if (area === 'hcm' && table === '"OTBI-HCM"') return true;
      if (area === 'scm' && table === '"OTBI-SCM"') return true;
      if (area === 'cx' && table === '"OTBI-CX"') return true;
      if (area === 'project' && table === '"OTBI-Project"') return true;
      return false;
    });
    if (matched.length) {
      setSelectedOtbiSA(matched[0].slug);
      setSelectedOtbiTable(null);
    } else {
      setSelectedOtbiSA('');
      setSelectedOtbiTable(null);
    }
  };

  const currentSAName = subjectAreas.find(x => x.slug === selectedSA)?.name || '';

  // ── AI Fetchers ─────────────────────────────────────────────────────────────
  const fetchAiExplanation = useCallback(async () => {
    if (!metricDetails || aiExplanation || aiExplainLoading) return;
    
    const cacheKey = `${currentSAName}||${metricDetails.tableName}||${metricDetails.name}`;
    if (explanationCache[cacheKey]) {
      setAiExplanation(explanationCache[cacheKey]);
      return;
    }

    setAiExplainLoading(true);
    try {
      const res = await fetch('/api/ai/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectArea: currentSAName,
          presentationTable: metricDetails.tableName,
          presentationColumn: metricDetails.name,
          mappings: metricDetails.mappings,
          provider: aiProvider,
          customApiKey: useCustomKey ? customApiKey : ''
        })
      }).then(r => r.json());
      if (res.error) throw new Error(res.error);
      
      explanationCache[cacheKey] = res.explanation;
      setAiExplanation(res.explanation);
    } catch (e) {
      setAiExplanation(`Failed to load AI explanation: ${e.message}`);
    } finally {
      setAiExplainLoading(false);
    }
  }, [metricDetails, aiExplanation, aiExplainLoading, currentSAName, aiProvider, useCustomKey, customApiKey]);

  const fetchAiFdiMatches = useCallback(async () => {
    if (!metricDetails || (Array.isArray(aiMatchedFdi) && aiMatchedFdi.length > 0) || aiMatchedFdiLoading) return;
    
    const cacheKey = `${metricDetails.tableName}||${metricDetails.name}||${aiProvider}`;
    if (matchCache[cacheKey]) {
      const cached = matchCache[cacheKey];
      setExactMatchedFdi(cached.exactMatches);
      setAiMatchedFdi(cached.matches);
      return;
    }

    setAiMatchedFdiLoading(true);
    setAiMatchedFdiError('');
    try {
      const activeMapping = mappings.find(
        m => m.presentationTable === metricDetails.tableName && m.presentationColumn === metricDetails.name
      );
      if (!activeMapping) {
        setAiMatchedFdi([]);
        setAiMatchedFdiError("No direct mapping found to query candidates.");
        return;
      }

      const res = await fetch('/api/ai/match-fdi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          otbiColumn: metricDetails.name,
          otbiTable: metricDetails.tableName,
          pvoName: activeMapping.pvoName,
          pvoAttribute: activeMapping.pvoAttribute,
          provider: aiProvider,
          customApiKey: useCustomKey ? customApiKey : ''
        })
      }).then(r => r.json());
      if (res.error) throw new Error(res.error);
      
      const exactList = res.exactMatches || [];
      const aiList = Array.isArray(res.matches) ? res.matches : [];
      
      matchCache[cacheKey] = { exactMatches: exactList, matches: aiList };
      
      setExactMatchedFdi(exactList);
      setAiMatchedFdi(aiList);
    } catch (e) {
      setAiMatchedFdi([]);
      setAiMatchedFdiError(`Failed to load AI matches: ${e.message}`);
    } finally {
      setAiMatchedFdiLoading(false);
    }
  }, [metricDetails, aiMatchedFdi, aiMatchedFdiLoading, mappings, aiProvider, useCustomKey, customApiKey]);

  // Auto-fetch FDI matches when column changes in OTBI bridge workspace
  useEffect(() => {
    if (workspace === 'otbi' && metricDetails && aiMatchedFdi.length === 0 && !aiMatchedFdiLoading && !aiMatchedFdiError) {
      fetchAiFdiMatches();
    }
  }, [workspace, metricDetails, aiMatchedFdi, aiMatchedFdiLoading, aiMatchedFdiError, fetchAiFdiMatches]);

  const handlePvoFinderSubmit = async (e) => {
    e.preventDefault();
    if (!pvoExplanation.trim()) return;
    
    setPvoLoading(true);
    setPvoError('');
    setPvoResult('');
    setPvoStepIndex(0);
    setSelectedPvoIdx(0);

    const interval = setInterval(() => {
      setPvoStepIndex(prev => (prev + 1) % 4);
    }, 1500);

    try {
      const res = await fetch('/api/ai/pvo-finder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          otbiSubjectArea: pvoOtbiSA,
          fdiSubjectArea: pvoFdiSA,
          explanation: pvoExplanation,
          provider: aiProvider,
          customApiKey: useCustomKey ? customApiKey : ''
        })
      }).then(r => r.json());
      
      if (res.error) throw new Error(res.error);
      const planText = res.plan || 'No customization plan returned.';
      
      // Parse PVO cards from the plan markdown: find ### PVO [N]: lines with Match Score
      const pvoCardMatches = [...planText.matchAll(/###\s*PVO\s*(\d+):\s*([^\n]+)\n\*\*Match Score:\s*([^*\n]+)\*\*/g)];
      const parsedCards = pvoCardMatches.map(m => ({
        rank: m[1],
        pvoName: m[2].trim(),
        score: m[3].trim()
      }));
      setPvoCards(parsedCards);
      setPvoResult(planText);
    } catch (err) {
      setPvoError(err.message || 'Failed to generate customization plan.');
    } finally {
      clearInterval(interval);
      setPvoLoading(false);
    }
  };


  // ══════════════════════════════════════════════════════════════════════════════
  //   RENDER
  // ══════════════════════════════════════════════════════════════════════════════
  return (
    <div className={`app-shell ${darkMode ? 'dark-mode' : ''}`}
         style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden',
                  background: 'var(--bg-app)', color: 'var(--text-h)', fontFamily: 'var(--font-ui)' }}>

      {/* ── TOP BAR ─────────────────────────────────────────────────────────── */}
      <header className="topbar">
        <div className="topbar-brand">
          <div className="brand-icon">🧬</div>
          <span className="brand-name">FDI <span>Lineage</span></span>
        </div>

        {/* Workspace Switcher */}
        <div style={{
          display: 'flex',
          background: 'var(--bg-app)',
          border: '1px solid var(--border)',
          borderRadius: '20px',
          padding: '2px',
          marginLeft: '20px',
          gap: '2px'
        }}>
          <button
            onClick={() => {
              setWorkspace('fdi');
              setNodes([]);
              setEdges([]);
              setMappings([]);
              setActiveColumn(null);
              setMetricDetails(null);
              setSelectedPresTable(null);
              setSelectedOtbiTable(null);
            }}
            style={{
              padding: '6px 14px',
              borderRadius: '18px',
              border: 'none',
              background: workspace === 'fdi' ? 'var(--primary)' : 'none',
              color: workspace === 'fdi' ? '#fff' : 'var(--text-muted)',
              fontSize: '11px',
              fontWeight: 'bold',
              cursor: 'pointer',
              transition: 'all 0.15s'
            }}
          >
            📊 FDI Warehouse
          </button>
          <button
            onClick={() => {
              setWorkspace('otbi');
              setNodes([]);
              setEdges([]);
              setMappings([]);
              setActiveColumn(null);
              setMetricDetails(null);
              setSelectedPresTable(null);
              setSelectedOtbiTable(null);
            }}
            style={{
              padding: '6px 14px',
              borderRadius: '18px',
              border: 'none',
              background: workspace === 'otbi' ? 'var(--primary)' : 'none',
              color: workspace === 'otbi' ? '#fff' : 'var(--text-muted)',
              fontSize: '11px',
              fontWeight: 'bold',
              cursor: 'pointer',
              transition: 'all 0.15s'
            }}
          >
            🔄 OTBI - FDI Match Bridge
          </button>
          <button
            onClick={() => {
              setWorkspace('pvo');
              setNodes([]);
              setEdges([]);
              setMappings([]);
              setActiveColumn(null);
              setMetricDetails(null);
              setSelectedPresTable(null);
              setSelectedOtbiTable(null);
            }}
            style={{
              padding: '6px 14px',
              borderRadius: '18px',
              border: 'none',
              background: workspace === 'pvo' ? 'var(--primary)' : 'none',
              color: workspace === 'pvo' ? '#fff' : 'var(--text-muted)',
              fontSize: '11px',
              fontWeight: 'bold',
              cursor: 'pointer',
              transition: 'all 0.15s'
            }}
          >
            🔍 PVO Finder
          </button>
        </div>

        <div className="topbar-divider" />

        <div className="topbar-selectors">
          {workspace === 'otbi' ? (
            <>
              <div className="selector-group">
                <span className="selector-label">OTBI Area</span>
                <select className="selector-select" value={selectedOtbiArea} onChange={handleOtbiAreaChange}>
                  <option value="all">All Areas</option>
                  <option value="finance">Finance</option>
                  <option value="hcm">Workforce (HCM)</option>
                  <option value="scm">Procurement (SCM)</option>
                  <option value="cx">Sales (CX)</option>
                  <option value="project">Projects</option>
                </select>
              </div>
              <div className="selector-group">
                <span className="selector-label">OTBI Subject Area</span>
                <SearchableSelect
                  options={filteredOtbiSAs.map(sa => ({ value: sa.slug, label: sa.name }))}
                  value={selectedOtbiSA}
                  onChange={val => { setSelectedOtbiSA(val); setSelectedOtbiTable(null); }}
                  placeholder="Select OTBI Subject Area..."
                  style={{ minWidth: '320px' }}
                />
              </div>
            </>
          ) : workspace === 'pvo' ? null : (
            <>
              <div className="selector-group">
                <span className="selector-label">Pillar</span>
                <select className="selector-select" value={selectedPillar} onChange={handlePillarChange}>
                  <option value="all">All Pillars</option>
                  <option value="ERP">ERP Analytics</option>
                  <option value="HCM">HCM Analytics</option>
                  <option value="SCM">SCM Analytics</option>
                  <option value="CX">CX Analytics</option>
                </select>
              </div>
              <div className="selector-group">
                <span className="selector-label">Subject Area</span>
                <SearchableSelect
                  options={filteredSAs.map(sa => ({ value: sa.slug, label: `[${sa.pillar}] ${sa.name}` }))}
                  value={selectedSA}
                  onChange={val => { setSelectedSA(val); setSelectedPresTable(null); }}
                  placeholder="Select Subject Area..."
                  style={{ minWidth: '280px' }}
                />
              </div>
            </>
          )}
        </div>

        <div className="topbar-actions">
          {workspace === 'fdi' && (
            <>
              <button className="search-trigger-btn" onClick={() => setSearchOpen(true)}>
                🔍 Search columns...
                <span className="search-kbd">Ctrl+K</span>
              </button>
              <button className={`compare-toggle-btn ${compareMode ? 'active' : ''}`}
                onClick={() => { setCompareMode(p => !p); if (compareMode) { setCompareSA(''); setCmpPresTable(null); } }}>
                ⇄ Compare
              </button>
            </>
          )}

          {/* AI Model Settings Button */}
          <button 
            onClick={() => setShowAiSettings(true)}
            title="Configure AI Model Provider (Gemini / Grok) & API Key"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '20px',
              background: aiProvider === 'gemini' ? 'rgba(99, 102, 241, 0.15)' : 'rgba(249, 115, 22, 0.15)',
              border: aiProvider === 'gemini' ? '1px solid rgba(99, 102, 241, 0.4)' : '1px solid rgba(249, 115, 22, 0.4)',
              color: 'var(--text-h)',
              fontSize: '11.5px',
              fontWeight: 'bold',
              cursor: 'pointer',
              transition: 'all 0.15s'
            }}
          >
            <span style={{ fontSize: '13px' }}>{aiProvider === 'gemini' ? '✨' : '⚡'}</span>
            <span>{aiProvider === 'gemini' ? 'Google Gemini 2.0' : 'Grok Llama'}</span>
            <span style={{ fontSize: '10px', opacity: 0.6 }}>⚙️</span>
          </button>

          <button className="icon-btn" onClick={() => setDarkMode(p => !p)} title="Toggle theme">
            {darkMode ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      {/* ── STATS BAR ───────────────────────────────────────────────────────── */}
      {workspace === 'fdi' && subjectAreas.length > 0 && <PillarStatsBar subjectAreas={subjectAreas} />}

      {/* ── WORKSPACE ───────────────────────────────────────────────────────── */}
      <div className={`workspace ${compareMode ? 'compare-mode' : ''}`} style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

        {/* ── LEFT SIDEBAR: Presentation Tables ─────────────────────────────── */}
        {workspace !== 'pvo' && (
          <aside className="pres-sidebar">
          <div className="sidebar-head">
            <div className="sidebar-head-row">
              <span className="sidebar-head-title">Presentation Tables</span>
              <span className="sidebar-count-badge">{filteredFolders.length}</span>
            </div>
            <div className="sidebar-search">
              <span className="sidebar-search-icon">🔍</span>
              <input
                className="sidebar-search-input"
                type="text"
                placeholder="Filter tables... (↑↓ Enter)"
                value={workspace === 'otbi' ? otbiSidebarSearch : sidebarSearch}
                onChange={e => {
                  if (workspace === 'otbi') setOtbiSidebarSearch(e.target.value);
                  else setSidebarSearch(e.target.value);
                  setFocusedIdx(-1);
                }}
              />
              {(workspace === 'otbi' ? otbiSidebarSearch : sidebarSearch) && (
                <button className="sidebar-clear-btn" onClick={() => {
                  if (workspace === 'otbi') setOtbiSidebarSearch('');
                  else setSidebarSearch('');
                  setFocusedIdx(-1);
                }}>✕</button>
              )}
            </div>
          </div>

          <div className="sidebar-list">
            {/* Recently Viewed (FDI only) */}
            {workspace === 'fdi' && recentlyViewed.length > 0 && !sidebarSearch && (
              <>
                <div className="sidebar-section-label">Recent Subject Areas</div>
                <div className="recent-chips">
                  {recentlyViewed.map(r => (
                    <button key={r.slug} className="recent-chip"
                      onClick={() => { setSelectedSA(r.slug); setSelectedPresTable(null); }}>
                      <span className="recent-chip-pillar">{r.pillar}</span>
                      {r.name.length > 18 ? r.name.slice(0, 18) + '…' : r.name}
                    </button>
                  ))}
                </div>
                <div className="sidebar-section-label" style={{ marginTop: 4 }}>All Tables</div>
              </>
            )}

            {filteredFolders.length > 0 ? filteredFolders.map((folder, idx) => {
              const isActive = workspace === 'otbi'
                ? selectedOtbiTable === folder.name
                : selectedPresTable === folder.name;

              return (
                <button
                  key={folder.name}
                  className={`pres-item ${isActive ? 'active' : ''} ${idx === focusedIdx ? 'keyboard-focused' : ''}`}
                  onClick={() => {
                    if (workspace === 'otbi') {
                      setSelectedOtbiTable(folder.name);
                    } else {
                      setSelectedPresTable(folder.name);
                    }
                    setActiveColumn(null);
                    setMetricDetails(null);
                    setFocusedIdx(idx);
                  }}
                  onMouseEnter={() => setFocusedIdx(idx)}
                >
                  <span className="pres-item-icon">📊</span>
                  <div className="pres-item-body">
                    <span className="pres-item-name">{shortName(folder.name)}</span>
                    <span className="pres-item-meta">{folder.colCount} columns</span>
                  </div>
                  <span className="pres-item-cols">{folder.colCount}</span>
                </button>
              );
            }) : (
              <div className="sidebar-empty">
                {(workspace === 'otbi' ? otbiSidebarSearch : sidebarSearch) ? 'No tables match your search' : 'Select a Subject Area to see tables'}
              </div>
            )}
          </div>
        </aside>
        )}

        {/* ── MAIN CANVAS ───────────────────────────────────────────────────── */}
        {workspace === 'pvo' ? (
          <main style={{ display: 'flex', flex: 1, height: '100%', background: 'var(--bg-app)', padding: '24px', gap: '24px', overflow: 'hidden' }}>
            {/* Left Side: Inputs */}
            <section style={{
              flex: '0 0 400px',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: '12px',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
              boxShadow: 'var(--sh-md)'
            }}>
              <div>
                <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-h)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>🔍</span> PVO Finder & Extender
                </h3>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Locate Fusion PVO source views and generate steps to augment your FDI semantic warehouse.
                </p>
              </div>

              <form onSubmit={handlePvoFinderSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-faint)', textTransform: 'uppercase' }}>
                    1. Source OTBI Subject Area
                  </label>
                  <SearchableSelect
                    options={otbiSubjectAreas.map(sa => ({ value: sa.name, label: sa.name }))}
                    value={pvoOtbiSA}
                    onChange={val => setPvoOtbiSA(val)}
                    placeholder="Search OTBI Subject Area..."
                    style={{ width: '100%' }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-faint)', textTransform: 'uppercase' }}>
                    2. Target FDI Subject Area
                  </label>
                  <SearchableSelect
                    options={subjectAreas.map(sa => ({ value: sa.name, label: `[${sa.pillar}] ${sa.name}` }))}
                    value={pvoFdiSA}
                    onChange={val => setPvoFdiSA(val)}
                    placeholder="Search FDI Subject Area..."
                    style={{ width: '100%' }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                  <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-faint)', textTransform: 'uppercase' }}>
                    3. Missing Data Business Case
                  </label>
                  <textarea
                    style={{
                      width: '100%',
                      flex: 1,
                      minHeight: '150px',
                      background: 'var(--bg-app)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      padding: '12px',
                      color: 'var(--text-h)',
                      fontFamily: 'var(--font-ui)',
                      fontSize: '13px',
                      resize: 'none',
                      lineHeight: '1.5'
                    }}
                    placeholder="Describe the transaction data or column that is present in Fusion but missing from FDI. E.g., 'Uncoded credit card transactions are present in Fusion under Credit Card Transactions but are not extracted to FDI.'"
                    value={pvoExplanation}
                    onChange={e => setPvoExplanation(e.target.value)}
                    required
                  />
                </div>

                <button
                  type="submit"
                  disabled={pvoLoading || !pvoExplanation.trim()}
                  style={{
                    width: '100%',
                    padding: '12px',
                    borderRadius: '8px',
                    border: 'none',
                    background: 'var(--primary)',
                    color: '#fff',
                    fontWeight: 'bold',
                    fontSize: '13px',
                    cursor: pvoLoading ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s',
                    opacity: pvoLoading || !pvoExplanation.trim() ? 0.6 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px'
                  }}
                >
                  {pvoLoading ? 'Generating Blueprint...' : 'Generate FDI Customization Plan'}
                </button>
              </form>
            </section>

            {/* Right Side: Output */}
            <section style={{
              flex: 1,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: '12px',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              boxShadow: 'var(--sh-md)'
            }}>
              <div style={{
                padding: '16px 24px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg-app)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: 'var(--text-muted)' }}>
                  🛠️ FDI Customization Plan & Join Blueprint
                </span>
                {pvoResult && (
                  <button
                    onClick={() => { setPvoResult(''); setPvoExplanation(''); setPvoCards([]); setSelectedPvoIdx(0); }}
                    style={{
                      border: 'none',
                      background: 'none',
                      color: 'var(--text-faint)',
                      fontSize: '11px',
                      cursor: 'pointer',
                      fontWeight: 'bold'
                    }}
                  >
                    Clear Plan
                  </button>
                )}
              </div>

              <div style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>
                {pvoLoading ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '16px' }}>
                    <span style={{ fontSize: '32px', animation: 'spin 1s linear infinite', color: 'var(--primary)' }}>⟳</span>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                      <span style={{ fontSize: '14px', fontWeight: 'bold', color: 'var(--text-h)' }}>
                        {pvoStepIndex === 0 && "Analyzing OTBI lineage data..."}
                        {pvoStepIndex === 1 && "Identifying top 3 Fusion PVOs..."}
                        {pvoStepIndex === 2 && "Designing join configurations in FDI..."}
                        {pvoStepIndex === 3 && "Structuring Sandbox extension guide..."}
                      </span>
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Asking Grok to engineer the blueprint...</span>
                    </div>
                  </div>
                ) : pvoError ? (
                  <div style={{
                    padding: '16px',
                    borderRadius: '8px',
                    background: 'rgba(239,68,68,0.1)',
                    border: '1px solid rgba(239,68,68,0.2)',
                    color: '#EF4444',
                    fontSize: '13px'
                  }}>
                    <strong>Error: </strong> {pvoError}
                  </div>
                                ) : pvoResult ? (
                  (() => {
                    const parsed = parsedPlan;
                    const selectedPvo = parsed.pvos[selectedPvoIdx];
                    
                    const pPattern = selectedPvo ? extractField(selectedPvo.details, 'pattern') : '';
                    const pTable = selectedPvo ? extractField(selectedPvo.details, 'table') : '';
                    const pKey = selectedPvo ? extractField(selectedPvo.details, 'key') : '';

                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%' }}>

                        {/* ── 3 PVO Score Cards ── */}
                        {pvoCards.length > 0 && (
                          <div>
                            <div style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: '10px', letterSpacing: '0.05em' }}>
                              🏆 Recommended PVOs (Click to view custom blueprint)
                            </div>
                            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                              {pvoCards.map((card, i) => {
                                const isSelected = selectedPvoIdx === i;
                                const color = i === 0 ? '#6366F1' : i === 1 ? '#F97316' : '#10B981';
                                const bg = isSelected 
                                  ? (i === 0 ? 'rgba(99,102,241,0.15)' : i === 1 ? 'rgba(249,115,22,0.15)' : 'rgba(16,185,129,0.15)')
                                  : 'rgba(255,255,255,0.02)';
                                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
                                
                                return (
                                  <div 
                                    key={i} 
                                    onClick={() => setSelectedPvoIdx(i)}
                                    style={{
                                      flex: '1 1 160px',
                                      padding: '14px 16px',
                                      borderRadius: '10px',
                                      border: isSelected ? `2px solid ${color}` : `1px solid var(--border)`,
                                      background: bg,
                                      boxShadow: isSelected ? `0 4px 12px ${color}30` : 'none',
                                      cursor: 'pointer',
                                      transform: isSelected ? 'translateY(-2px)' : 'none',
                                      transition: 'all 0.2s',
                                      position: 'relative'
                                    }}
                                    onMouseEnter={(e) => {
                                      if (!isSelected) {
                                        e.currentTarget.style.border = `1px solid ${color}80`;
                                        e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                                      }
                                    }}
                                    onMouseLeave={(e) => {
                                      if (!isSelected) {
                                        e.currentTarget.style.border = `1px solid var(--border)`;
                                        e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
                                      }
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                                      <span style={{ fontSize: '16px' }}>{medal}</span>
                                      <span style={{ fontSize: '10px', fontWeight: 'bold', color, textTransform: 'uppercase', letterSpacing: '0.06em' }}>PVO #{card.rank}</span>
                                    </div>
                                    <div style={{ fontSize: '12px', fontWeight: '700', color: 'var(--text-h)', marginBottom: '10px', wordBreak: 'break-word', lineHeight: 1.4 }}>
                                      {card.pvoName}
                                    </div>
                                    {/* Score Bar */}
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <span style={{ fontSize: '10px', color: 'var(--text-faint)' }}>Match Score</span>
                                        <span style={{ fontSize: '12px', fontWeight: 'bold', color }}>{card.score}</span>
                                      </div>
                                      <div style={{ height: '4px', borderRadius: '2px', background: 'var(--bg-app)', overflow: 'hidden' }}>
                                        <div style={{ height: '100%', width: card.score, background: color, borderRadius: '2px' }} />
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        <div style={{ height: '1px', background: 'var(--border)' }} />

                        {/* ── Visual step-by-step semantic extension guide ── */}
                        {selectedPvo && (
                          <div style={{
                            background: 'rgba(99, 102, 241, 0.03)',
                            border: '1px solid rgba(99, 102, 241, 0.15)',
                            borderRadius: '12px',
                            padding: '20px',
                            boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.02)'
                          }}>
                            <h4 style={{ color: 'var(--primary)', margin: '0 0 16px 0', fontSize: '14px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span>🚀</span> FDI Console Extension Walkthrough: {shortName(selectedPvo.name)}
                            </h4>
                            
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                              {/* Step 1 */}
                              <div style={{ display: 'flex', gap: '12px' }}>
                                <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 'bold', flexShrink: 0 }}>1</div>
                                <div>
                                  <strong style={{ color: 'var(--text-h)', fontSize: '13px' }}>Create extension Sandbox</strong>
                                  <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>Go to FDI Console &gt; Semantic Model Extensions, click "Create Sandbox", name it (e.g. <code>Ext_{shortName(selectedPvo.name)}</code>), and open it.</p>
                                </div>
                              </div>
                              
                              {/* Step 2 */}
                              <div style={{ display: 'flex', gap: '12px' }}>
                                <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 'bold', flexShrink: 0 }}>2</div>
                                <div>
                                  <strong style={{ color: 'var(--text-h)', fontSize: '13px' }}>Add Data Augmentation</strong>
                                  <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>Create a Data Augmentation task. Select source PVO <code style={{color:'var(--primary)', background:'rgba(99,102,241,0.1)', padding:'2px 6px', borderRadius:'4px'}}>{selectedPvo.name}</code>. Extract the required columns detailed in the plan below.</p>
                                </div>
                              </div>
                              
                              {/* Step 3 */}
                              <div style={{ display: 'flex', gap: '12px' }}>
                                <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 'bold', flexShrink: 0 }}>3</div>
                                <div>
                                  <strong style={{ color: 'var(--text-h)', fontSize: '13px' }}>Configure Logical Join</strong>
                                  <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                    Choose extensible pattern: <strong style={{color:'var(--text-h)'}}>{pPattern || 'Extend a Dimension'}</strong>.<br/>
                                    Target FDI warehouse table: <strong style={{color:'var(--text-h)'}}>{pTable || 'Standard DW Table'}</strong>.<br/>
                                    Join relationship: <code style={{color:'var(--primary)', background:'rgba(99,102,241,0.1)', padding:'2px 6px', borderRadius:'4px'}}>{pKey || 'Define using PVO join keys'}</code>.
                                  </p>
                                </div>
                              </div>
                              
                              {/* Step 4 */}
                              <div style={{ display: 'flex', gap: '12px' }}>
                                <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 'bold', flexShrink: 0 }}>4</div>
                                <div>
                                  <strong style={{ color: 'var(--text-h)', fontSize: '13px' }}>Expose Presentation Columns</strong>
                                  <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>Open the target Subject Area <strong>{pvoFdiSA}</strong>. Expose the augmented PVO attributes to your reporting users under the appropriate folder.</p>
                                </div>
                              </div>

                              {/* Step 5 */}
                              <div style={{ display: 'flex', gap: '12px' }}>
                                <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 'bold', flexShrink: 0 }}>5</div>
                                <div>
                                  <strong style={{ color: 'var(--text-h)', fontSize: '13px' }}>Validate and Publish</strong>
                                  <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>Click "Validate" to check logical model integrity. Once clean, click "Publish" to deploy the semantic model updates.</p>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* ── Selected PVO Details ── */}
                        {selectedPvo && (
                          <div style={{ lineHeight: '1.6', fontSize: '13.5px', color: 'var(--text-body)', width: '100%' }}>
                            {renderMarkdown(selectedPvo.details)}
                          </div>
                        )}

                        {/* ── Sandbox Framework Guide (always shown at bottom) ── */}
                        {parsed.guide && (
                          <>
                            <div style={{ height: '1px', background: 'var(--border)' }} />
                            <div style={{ lineHeight: '1.6', fontSize: '13.5px', color: 'var(--text-body)', width: '100%' }}>
                              {renderMarkdown(parsed.guide)}
                            </div>
                          </>
                        )}

                      </div>
                    );
                  })()
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '16px', color: 'var(--text-faint)', textAlign: 'center', padding: '0 40px' }}>
                    <span style={{ fontSize: '48px' }}>🤖</span>
                    <h4 style={{ fontSize: '15px', fontWeight: 'bold', color: 'var(--text-muted)' }}>No Blueprint Generated Yet</h4>
                    <p style={{ fontSize: '12.5px', maxWidth: '360px', margin: '0 auto', lineHeight: 1.5 }}>
                      Fill out the form on the left, explaining your business case. Grok will generate a customized implementation plan with top 3 target PVOs with match scores, FDI tables, join keys, and a Sandbox configuration guide.
                    </p>
                  </div>
                )}
              </div>
            </section>
          </main>
        ) : (
          <main className="canvas-main">

          {/* Action bar */}
          <div className="canvas-actionbar">
            <div className="canvas-breadcrumb">
              {(workspace === 'otbi' ? (otbiSubjectAreas.find(x => x.slug === selectedOtbiSA)?.name || '') : currentSAName) && (
                <span className="breadcrumb-sa">
                  {workspace === 'otbi' ? (otbiSubjectAreas.find(x => x.slug === selectedOtbiSA)?.name || '') : currentSAName}
                </span>
              )}
              {(workspace === 'otbi' ? selectedOtbiTable : selectedPresTable) && (
                <>
                  <span className="breadcrumb-sep">›</span>
                  <span className="breadcrumb-table">
                    {shortName(workspace === 'otbi' ? selectedOtbiTable : selectedPresTable)}
                  </span>
                </>
              )}
              {activeColumn && (
                <>
                  <span className="breadcrumb-sep">›</span>
                  <span style={{ color: 'var(--phys)', fontWeight: 700 }}>{activeColumn.colName}</span>
                </>
              )}
            </div>

            <div className="canvas-action-group">
              {activeColumn && (
                <button className="action-chip" onClick={() => { setActiveColumn(null); setMetricDetails(null); }}>
                  <span>✕</span> Clear Column Filter
                </button>
              )}
              {workspace === 'fdi' && selectedPresTable && (
                <>
                  <button className="action-chip" onClick={handleExportPNG}>
                    <span className="chip-icon">📷</span> PNG
                  </button>
                  <button className="action-chip" onClick={() => exportCSV(mappings, currentSAName)}>
                    <span className="chip-icon">📄</span> CSV
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Canvas / Empty State */}
          <div className="canvas-view" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {(workspace === 'otbi' ? selectedOtbiTable : selectedPresTable) ? (
              <ReactFlowProvider>
                <FlowCanvas
                  nodes={processedNodes}
                  edges={processedEdges}
                  nodeTypes={nodeTypes}
                />
              </ReactFlowProvider>
            ) : (
              <div className="canvas-empty">
                <div className="empty-illustration">🔍</div>
                <h3>{workspace === 'otbi' ? 'OTBI - FDI Match Bridge' : 'Explore Data Lineage'}</h3>
                <p>
                  {workspace === 'otbi'
                    ? "Select an OTBI Presentation Table from the left panel, then click any column to find its match in FDI."
                    : "Select a Presentation Table from the left panel to visualize its full data lineage from physical source tables."}
                </p>
                {workspace === 'fdi' && (
                  <div className="canvas-empty-tip">
                    <span>💡</span>
                    <span>Use <strong>Ctrl+K</strong> to search directly by column name</span>
                  </div>
                )}
              </div>
            )}

            {/* Metric Details Drawer */}
            {metricDetails && (
              <aside className={`details-drawer ${metricDetails ? 'open' : ''}`}>
                <div className="drawer-topbar">
                  <h3>🏷 {workspace === 'otbi' ? 'OTBI - FDI Match Bridge' : 'Column Details'}</h3>
                  <button className="drawer-close" onClick={() => { setMetricDetails(null); setActiveColumn(null); }}>✕</button>
                </div>

                {/* Tabs bar (FDI workspace only) */}
                {workspace === 'fdi' && (
                  <div style={{
                    display: 'flex',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--bg-app)',
                    padding: '0 10px'
                  }}>
                    <button
                      onClick={() => setDrawerTab('mappings')}
                      style={{
                        flex: 1, padding: '12px 6px', border: 'none', background: 'none', cursor: 'pointer',
                        fontSize: '11.5px', fontWeight: '600',
                        color: drawerTab === 'mappings' ? 'var(--primary)' : 'var(--text-muted)',
                        borderBottom: drawerTab === 'mappings' ? '2.5px solid var(--primary)' : '2.5px solid transparent',
                        transition: 'all 0.15s',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px'
                      }}
                    >
                      🗄️ Sources
                    </button>
                    <button
                      onClick={() => { setDrawerTab('explain'); fetchAiExplanation(); }}
                      style={{
                        flex: 1, padding: '12px 6px', border: 'none', background: 'none', cursor: 'pointer',
                        fontSize: '11.5px', fontWeight: '600',
                        color: drawerTab === 'explain' ? 'var(--primary)' : 'var(--text-muted)',
                        borderBottom: drawerTab === 'explain' ? '2.5px solid var(--primary)' : '2.5px solid transparent',
                        transition: 'all 0.15s',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px'
                      }}
                    >
                      🤖 AI Explain
                    </button>
                  </div>
                )}

                <div className="drawer-body" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '18px', flex: 1, minHeight: 0 }}>
                  
                  {/* Common Details */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderBottom: '1px solid var(--border)', paddingBottom: '14px' }}>
                    <div className="drawer-field">
                      <span className="drawer-field-label">Presentation Table</span>
                      <span className="drawer-field-value" style={{ color: 'var(--primary)', fontWeight: 700 }}>
                        {shortName(metricDetails.tableName)}
                      </span>
                    </div>

                    <div className="drawer-field">
                      <span className="drawer-field-label">Presentation Column</span>
                      <span className="drawer-field-value orange" style={{ fontSize: '15px', fontWeight: 'bold' }}>
                        {metricDetails.name}
                      </span>
                    </div>
                  </div>

                  {/* Tab Content: Mappings (FDI only) */}
                  {workspace === 'fdi' && drawerTab === 'mappings' && (
                    <div className="drawer-field" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                      <span className="drawer-field-label" style={{ marginBottom: 8 }}>
                        Source Physical Columns ({metricDetails.mappings?.length || 0})
                      </span>
                      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 4 }}>
                        {metricDetails.mappings && metricDetails.mappings.length > 0 ? (
                          metricDetails.mappings.map((m, i) => (
                            <div key={i} style={{
                              padding: '12px',
                              border: '1px solid var(--border)',
                              borderRadius: 'var(--r-md)',
                              background: 'var(--bg-app)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 8,
                              boxShadow: 'var(--sh-xs)'
                            }}>
                              <div>
                                <div style={{ fontSize: '9px', fontWeight: 'bold', color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 2 }}>
                                  🗄️ Physical Table
                                </div>
                                <div style={{ fontSize: '11.5px', fontWeight: '600', color: 'var(--text-h)', wordBreak: 'break-all', fontFamily: 'var(--font-mono)' }}>
                                  {m.physicalTable}
                                </div>
                              </div>
                              <div style={{ height: '1px', background: 'var(--border)' }} />
                              <div>
                                <div style={{ fontSize: '9px', fontWeight: 'bold', color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 2 }}>
                                  ◆ Physical Column
                                </div>
                                <div style={{ fontSize: '11.5px', fontWeight: '700', color: 'var(--in-700)', wordBreak: 'break-all', fontFamily: 'var(--font-mono)' }}>
                                  {m.physicalColumn}
                                </div>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div style={{ color: 'var(--text-faint)', fontSize: '12px', fontStyle: 'italic', padding: 8 }}>
                            No mappings found for this column.
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Tab Content: FDI AI Explain (FDI only) */}
                  {workspace === 'fdi' && drawerTab === 'explain' && (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                      <span className="drawer-field-label" style={{ marginBottom: 10 }}>AI Lineage Explanation</span>
                      
                      {aiExplainLoading ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, flex: 1 }}>
                          <span style={{ fontSize: '24px', animation: 'spin 0.8s linear infinite', color: 'var(--primary)' }}>⟳</span>
                          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Asking Grok to explain...</span>
                        </div>
                      ) : (
                        <div style={{
                          flex: 1, overflowY: 'auto', padding: '16px', borderRadius: 'var(--r-md)',
                          background: 'linear-gradient(135deg, rgba(249,115,22,0.04), rgba(99,102,241,0.02))',
                          border: '1px solid var(--primary-border)', lineHeight: '1.6', fontSize: '13px',
                          color: 'var(--text-body)', whiteSpace: 'pre-wrap'
                        }}>
                          {aiExplanation}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Tab Content: OTBI Grok FDI Match (OTBI only, auto-displayed) */}
                  {workspace === 'otbi' && (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, gap: '14px' }}>
                      
                      {/* Section 1: Deterministic Matches */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <span className="drawer-field-label">🔗 Direct Warehouse Lineage Links</span>
                        {aiMatchedFdiLoading ? (
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic', paddingLeft: 4 }}>Checking database...</div>
                        ) : exactMatchedFdi.length > 0 ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {exactMatchedFdi.map((match, i) => (
                              <div key={i} style={{
                                padding: '10px 12px',
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--r-md)',
                                background: 'linear-gradient(135deg, rgba(99,102,241,0.06), rgba(99,102,241,0.02))',
                                boxShadow: 'var(--sh-xs)'
                              }}>
                                <div style={{ fontSize: '9px', fontWeight: 'bold', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '4px' }}>
                                  🎯 Exact Match Found
                                </div>
                                <div style={{ fontSize: '12px', fontWeight: '700', color: 'var(--text-h)' }}>
                                  {match.subjectArea}
                                </div>
                                <div style={{ fontSize: '11px', color: 'var(--text-body)', marginTop: '2px', display: 'flex', gap: '4px', alignItems: 'center' }}>
                                  <span style={{ color: 'var(--text-faint)' }}>Table:</span>
                                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{match.presentationTable}</span>
                                  <span style={{ color: 'var(--text-faint)' }}>›</span>
                                  <span style={{ color: 'var(--in-700)', fontWeight: 700 }}>{match.presentationColumn}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div style={{ fontSize: '12px', color: 'var(--text-faint)', fontStyle: 'italic', paddingLeft: 4 }}>
                            No exact physical links found in the FDI mapping tables.
                          </div>
                        )}
                      </div>

                      <div style={{ height: '1px', background: 'var(--border)' }} />

                      {/* Section 2: AI Semantic Ranks */}
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                        <span className="drawer-field-label" style={{ marginBottom: 8 }}>🤖 Grok AI Semantic Rankings</span>
                        
                        {aiMatchedFdiLoading ? (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, flex: 1 }}>
                            <span style={{ fontSize: '24px', animation: 'spin 0.8s linear infinite', color: 'var(--primary)' }}>⟳</span>
                            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Asking Grok to match FDI columns...</span>
                          </div>
                        ) : aiMatchedFdiError ? (
                          <div style={{ color: '#EF4444', fontSize: '12px', padding: '8px', background: 'rgba(239,68,68,0.1)', borderRadius: '6px', border: '1px solid rgba(239,68,68,0.2)' }}>
                            {aiMatchedFdiError}
                          </div>
                        ) : Array.isArray(aiMatchedFdi) && aiMatchedFdi.length > 0 ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto', flex: 1, paddingRight: 4 }}>
                            {aiMatchedFdi.map((match, i) => (
                              <div key={i} style={{
                                padding: '12px',
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--r-md)',
                                background: 'linear-gradient(135deg, rgba(249,115,22,0.05), rgba(99,102,241,0.02))',
                                boxShadow: 'var(--sh-xs)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '8px'
                              }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span style={{
                                    fontSize: '10px',
                                    fontWeight: 'bold',
                                    color: '#fff',
                                    background: 'var(--primary)',
                                    padding: '2px 8px',
                                    borderRadius: '10px',
                                    textTransform: 'uppercase'
                                  }}>
                                    {match.rank || `${i+1}st`} Match
                                  </span>
                                  <span style={{
                                    fontSize: '11px',
                                    fontWeight: 'bold',
                                    color: 'var(--primary)',
                                    background: 'rgba(249,115,22,0.1)',
                                    padding: '2px 8px',
                                    borderRadius: '10px'
                                  }}>
                                    Score: {match.score || 'N/A'}
                                  </span>
                                </div>

                                <div>
                                  <div style={{ fontSize: '9px', fontWeight: 'bold', color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 2 }}>
                                    🌐 FDI Subject Area
                                  </div>
                                  <div style={{ fontSize: '12px', fontWeight: '700', color: 'var(--text-h)' }}>
                                    {match.subjectArea}
                                  </div>
                                </div>

                                <div style={{ display: 'flex', gap: '8px', borderTop: '1px dashed var(--border)', paddingTop: '6px' }}>
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: '9px', fontWeight: 'bold', color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 2 }}>
                                      🗄️ FDI Presentation Table
                                    </div>
                                    <div style={{ fontSize: '11px', fontWeight: '600', color: 'var(--text-body)', fontFamily: 'var(--font-mono)' }}>
                                      {match.presentationTable}
                                    </div>
                                  </div>
                                  <div style={{ width: '1px', background: 'var(--border)' }} />
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: '9px', fontWeight: 'bold', color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 2 }}>
                                      ◆ FDI Column
                                    </div>
                                    <div style={{ fontSize: '11px', fontWeight: '700', color: 'var(--in-700)', fontFamily: 'var(--font-mono)' }}>
                                      {match.presentationColumn}
                                    </div>
                                  </div>
                                </div>

                                {match.explanation && (
                                  <div style={{
                                    fontSize: '11.5px',
                                    color: 'var(--text-muted)',
                                    background: 'rgba(0,0,0,0.15)',
                                    padding: '8px',
                                    borderRadius: '6px',
                                    borderLeft: '3px solid var(--primary)',
                                    lineHeight: '1.4',
                                    marginTop: '4px'
                                  }}>
                                    {match.explanation}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div style={{ color: 'var(--text-faint)', fontSize: '12px', fontStyle: 'italic', padding: 8 }}>
                            No recommendations found or returned.
                          </div>
                        )}
                      </div>
                  </div>
                  )}
                </div>
              </aside>
            )}
          </div>
        </main>
      )}

        {/* ── COMPARE PANE ─────────────────────────────────────────────────── */}
        {compareMode && (
          <div className="compare-pane">
            <div className="compare-pane-header">
              <span className="compare-pane-label">⇄ Compare</span>
              <select className="compare-sa-select" value={compareSA}
                onChange={e => { setCompareSA(e.target.value); setCmpPresTable(null); }}>
                <option value="">— Select Subject Area —</option>
                {subjectAreas.map(sa => (
                  <option key={sa.slug} value={sa.slug}>[{sa.pillar}] {sa.name}</option>
                ))}
              </select>
            </div>

            <div className="compare-content">
              {/* Compare sidebar */}
              <div className="compare-sidebar">
                {cmpFolders.length > 0 ? cmpFolders.map(f => (
                  <button key={f.name}
                    className={`compare-folder-item ${cmpPresTable === f.name ? 'active' : ''}`}
                    onClick={() => setCmpPresTable(f.name)}>
                    📊 {shortName(f.name)}
                    <span style={{ float: 'right', color: 'var(--text-faint)', fontSize: 10 }}>{f.colCount}</span>
                  </button>
                )) : (
                  <div style={{ padding: 16, color: 'var(--text-faint)', fontSize: 12 }}>
                    {compareSA ? 'Loading...' : 'Select a subject area above'}
                  </div>
                )}
              </div>

              {/* Compare canvas */}
              <div className="compare-canvas" style={{ position: 'relative' }}>
                {cmpPresTable ? (
                  <ReactFlowProvider>
                    <FlowCanvas
                      nodes={cmpProcessedNodes}
                      edges={cmpProcessedEdges}
                      nodeTypes={nodeTypes}
                      onNodeClick={() => {}}
                      onNodesChange={() => {}}
                      onEdgesChange={() => {}}
                    />
                  </ReactFlowProvider>
                ) : (
                  <div className="canvas-empty" style={{ height: '100%' }}>
                    <div className="empty-illustration" style={{ width: 60, height: 60, fontSize: 24 }}>⇄</div>
                    <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>Select a table to compare</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── COMMAND PALETTE ─────────────────────────────────────────────────── */}
      {searchOpen && (
        <div className="palette-overlay" onClick={() => setSearchOpen(false)}>
          <div className="palette-modal" onClick={e => e.stopPropagation()}>
            <div className="palette-input-row">
              <span className="palette-search-icon">🔍</span>
              <input
                className="palette-input"
                type="text"
                placeholder="Search subject areas, columns, physical tables..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                autoFocus
              />
              {searchLoading && <span className="palette-spinner">⟳</span>}
              <span className="palette-esc">ESC</span>
            </div>
            <div className="palette-results">
              {searchResults.length > 0 ? searchResults.map((r, i) => (
                <div key={i} className="palette-result-item"
                   onClick={() => { r.action(); setSearchOpen(false); setSearchQuery(''); }}>
                  <span className={`res-type ${r.type === 'Column' ? 'res-type-col' : 'res-type-sa'}`}>{r.type}</span>
                  <div className="res-info">
                    <span className="res-label">{r.label}</span>
                    {r.sub && <span className="res-sub">{r.sub}</span>}
                  </div>
                  <span className="res-pillar">{r.pillar}</span>
                </div>
              )) : (
                <div className="palette-empty">
                  {searchQuery.length > 0 ? '— No results —' : 'Start typing to search...'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── AI ENGINE & API KEY SETTINGS MODAL ─────────────────────────────────────── */}
      {showAiSettings && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(4px)',
          zIndex: 100000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }} onClick={() => setShowAiSettings(false)}>
          <div style={{
            background: '#181C27',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '16px',
            width: '100%',
            maxWidth: '520px',
            padding: '24px',
            boxShadow: '0 20px 50px rgba(0,0,0,0.85)',
            display: 'flex',
            flexDirection: 'column',
            gap: '20px'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '22px' }}>🤖</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 'bold', color: '#F9FAFB' }}>AI Engine & Key Settings</h3>
                  <span style={{ fontSize: '11px', color: '#9CA3AF' }}>Switch AI models or configure custom API keys</span>
                </div>
              </div>
              <button onClick={() => setShowAiSettings(false)} style={{ background: 'none', border: 'none', color: '#9CA3AF', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>

            {/* Provider Selection */}
            <div>
              <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>1. Select AI Model Engine</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '10px' }}>
                {/* Gemini Option */}
                <div 
                  onClick={() => setAiProvider('gemini')}
                  style={{
                    padding: '14px',
                    borderRadius: '10px',
                    border: aiProvider === 'gemini' ? '2px solid #6366F1' : '1px solid rgba(255,255,255,0.1)',
                    background: aiProvider === 'gemini' ? 'rgba(99, 102, 241, 0.15)' : 'rgba(255,255,255,0.03)',
                    cursor: 'pointer',
                    transition: 'all 0.15s'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', fontSize: '13px', color: aiProvider === 'gemini' ? '#818CF8' : '#F9FAFB' }}>
                    <span>✨</span> Google Gemini
                  </div>
                  <p style={{ margin: '6px 0 0 0', fontSize: '11px', color: '#9CA3AF', lineHeight: '1.3' }}>
                    Gemini 2.0 / 1.5 Flash. Fast, accurate, & default for FDI data lineage.
                  </p>
                </div>

                {/* Grok Option */}
                <div 
                  onClick={() => setAiProvider('grok')}
                  style={{
                    padding: '14px',
                    borderRadius: '10px',
                    border: aiProvider === 'grok' ? '2px solid #F97316' : '1px solid rgba(255,255,255,0.1)',
                    background: aiProvider === 'grok' ? 'rgba(249, 115, 22, 0.15)' : 'rgba(255,255,255,0.03)',
                    cursor: 'pointer',
                    transition: 'all 0.15s'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', fontSize: '13px', color: aiProvider === 'grok' ? '#FB923C' : '#F9FAFB' }}>
                    <span>⚡</span> Grok / Llama
                  </div>
                  <p style={{ margin: '6px 0 0 0', fontSize: '11px', color: '#9CA3AF', lineHeight: '1.3' }}>
                    Groq Llama-3.3-70B. High reasoning for complex customization plans.
                  </p>
                </div>
              </div>
            </div>

            {/* API Key Source */}
            <div>
              <label style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>2. API Key Source</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12.5px', cursor: 'pointer', color: '#D1D5DB' }}>
                  <input 
                    type="radio" 
                    name="keySource" 
                    checked={!useCustomKey} 
                    onChange={() => setUseCustomKey(false)} 
                  />
                  <span>🌐 Use Server Environment Key ({aiProvider === 'gemini' ? 'GEMINI_API_KEY' : 'GROK_API_KEY'} on Render)</span>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12.5px', cursor: 'pointer', color: '#D1D5DB' }}>
                  <input 
                    type="radio" 
                    name="keySource" 
                    checked={useCustomKey} 
                    onChange={() => setUseCustomKey(true)} 
                  />
                  <span>🔑 Use Custom Frontend API Key</span>
                </label>

                {useCustomKey && (
                  <div style={{ marginTop: '4px', paddingLeft: '24px' }}>
                    <input 
                      type="password"
                      placeholder={`Enter your ${aiProvider === 'gemini' ? 'Gemini API Key (AIzaSy...)' : 'Groq/Grok API Key (gsk_...)'}`}
                      value={customApiKey}
                      onChange={e => setCustomApiKey(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        background: '#0F1117',
                        border: '1px solid rgba(255,255,255,0.2)',
                        borderRadius: '8px',
                        color: '#F9FAFB',
                        fontSize: '12px',
                        outline: 'none'
                      }}
                    />
                    <span style={{ fontSize: '10.5px', color: '#6B7280', marginTop: '4px', display: 'block' }}>Key is stored locally in your browser and sent with AI requests.</span>
                  </div>
                )}
              </div>
            </div>

            {/* Save Action */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '16px', gap: '10px' }}>
              <button 
                onClick={() => {
                  localStorage.setItem('fdi_ai_provider', aiProvider);
                  localStorage.setItem('fdi_use_custom_key', useCustomKey ? 'true' : 'false');
                  localStorage.setItem('fdi_custom_api_key', customApiKey);
                  setShowAiSettings(false);
                }}
                style={{
                  padding: '9px 22px',
                  borderRadius: '8px',
                  border: 'none',
                  background: 'var(--primary)',
                  color: '#fff',
                  fontSize: '13px',
                  fontWeight: 'bold',
                  cursor: 'pointer'
                }}
              >
                Save & Apply Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── FLOATING CHATBOT TOGGLE BUTTON (Right Side) ───────────────────────── */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          title="Ask Oracle FDI, OAC, OCI & Fusion Applications AI Assistant"
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '12px 20px',
            borderRadius: '30px',
            background: 'linear-gradient(135deg, #F97316 0%, #EA580C 100%)',
            color: '#FFFFFF',
            border: '1px solid rgba(255,255,255,0.2)',
            boxShadow: '0 10px 25px rgba(249, 115, 22, 0.45)',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 'bold',
            transition: 'transform 0.2s, boxShadow 0.2s'
          }}
          onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.05)'}
          onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
        >
          <span style={{ fontSize: '18px' }}>🤖</span>
          <span>Ask Oracle AI Assistant</span>
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: '#10B981',
            boxShadow: '0 0 8px #10B981'
          }} />
        </button>
      )}

      {/* ── RIGHT CHATBOT DRAWER PANEL ────────────────────────────────────────── */}
      {chatOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          right: 0,
          width: '420px',
          height: '100vh',
          zIndex: 99999,
          background: '#141722',
          borderLeft: '1px solid rgba(255, 255, 255, 0.12)',
          boxShadow: '-10px 0 40px rgba(0,0,0,0.7)',
          display: 'flex',
          flexDirection: 'column'
        }}>
          {/* Chat Header */}
          <div style={{
            padding: '16px 20px',
            background: '#1B1F2D',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{
                width: '36px',
                height: '36px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, #F97316 0%, #EA580C 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '18px',
                boxShadow: '0 4px 12px rgba(249, 115, 22, 0.3)'
              }}>
                🤖
              </div>
              <div>
                <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 'bold', color: '#F9FAFB' }}>
                  Oracle Analytics AI Assistant
                </h4>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10B981' }} />
                  <span style={{ fontSize: '11px', color: '#9CA3AF' }}>
                    FDI • OAC • OCI • Fusion Cloud ({aiProvider === 'gemini' ? 'Gemini 2.0' : 'Grok'})
                  </span>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button 
                onClick={() => setChatMessages([
                  {
                    role: 'assistant',
                    content: '👋 Hi! I am your **Oracle Enterprise Analytics AI Consultant**.\n\nAsk me anything about **FDI (FAW)**, **OAC**, **OTBI**, **OCI Services (ADW, GoldenGate, OIC)**, or **Fusion ERP/HCM/SCM/CX PVO Data Extensibility**!',
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  }
                ])}
                title="Clear Chat History"
                style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: '14px', cursor: 'pointer', padding: '4px' }}
              >
                🗑️
              </button>
              <button 
                onClick={() => setChatOpen(false)}
                title="Close Chat Assistant"
                style={{ background: 'none', border: 'none', color: '#9CA3AF', fontSize: '18px', cursor: 'pointer', padding: '4px' }}
              >
                ✕
              </button>
            </div>
          </div>

          {/* Quick Prompts Chips */}
          <div style={{
            padding: '10px 16px',
            background: '#181C27',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            gap: '8px',
            overflowX: 'auto',
            whiteSpace: 'nowrap'
          }}>
            {[
              '💡 How do I extend FDI using Data Augmentation?',
              '💡 Difference between OTBI, OAC, and FDI?',
              '💡 How does BICC extract PVOs to OCI ADW?',
              '💡 How to join EXM_EXPENSE_ITEMS to DW_PARTY_D?'
            ].map((promptText, i) => (
              <button
                key={i}
                onClick={() => handleSendChatMessage(promptText.replace(/^💡\s*/, ''))}
                style={{
                  padding: '5px 10px',
                  borderRadius: '14px',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'var(--text-body)',
                  fontSize: '11px',
                  cursor: 'pointer',
                  flexShrink: 0
                }}
              >
                {promptText}
              </button>
            ))}
          </div>

          {/* Chat Messages */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            background: '#141722'
          }}>
            {chatMessages.map((msg, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '90%',
                  alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start'
                }}
              >
                <div style={{
                  padding: '12px 14px',
                  borderRadius: msg.role === 'user' ? '14px 14px 2px 14px' : '14px 14px 14px 2px',
                  background: msg.role === 'user' ? 'linear-gradient(135deg, #F97316 0%, #EA580C 100%)' : '#1E2332',
                  color: '#FFFFFF',
                  fontSize: '12.5px',
                  lineHeight: '1.5',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                  whiteSpace: 'pre-wrap',
                  border: msg.role === 'user' ? 'none' : '1px solid rgba(255,255,255,0.08)'
                }}>
                  {msg.content}
                </div>
                <span style={{ fontSize: '10px', color: '#6B7280', marginTop: '4px', padding: '0 4px' }}>
                  {msg.timestamp}
                </span>
              </div>
            ))}

            {chatLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', background: '#1E2332', borderRadius: '12px', width: 'fit-content', border: '1px solid rgba(255,255,255,0.08)' }}>
                <span style={{ fontSize: '14px' }}>⚙️</span>
                <span style={{ fontSize: '12px', color: '#9CA3AF' }}>Oracle AI is analyzing...</span>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Chat Input */}
          <form
            onSubmit={e => { e.preventDefault(); handleSendChatMessage(); }}
            style={{
              padding: '12px 16px',
              background: '#1B1F2D',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              gap: '10px',
              alignItems: 'center'
            }}
          >
            <input
              type="text"
              placeholder="Ask about FDI, OAC, OCI, PVOs, or Fusion Cloud..."
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              disabled={chatLoading}
              style={{
                flex: 1,
                padding: '10px 14px',
                background: '#0F1117',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '10px',
                color: '#F9FAFB',
                fontSize: '12.5px',
                outline: 'none'
              }}
            />
            <button
              type="submit"
              disabled={!chatInput.trim() || chatLoading}
              style={{
                padding: '10px 16px',
                borderRadius: '10px',
                border: 'none',
                background: chatInput.trim() && !chatLoading ? 'var(--primary)' : 'rgba(255,255,255,0.1)',
                color: '#FFFFFF',
                fontWeight: 'bold',
                fontSize: '13px',
                cursor: chatInput.trim() && !chatLoading ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s'
              }}
            >
              Send 🚀
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

